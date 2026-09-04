import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  applySteamResponseCookies,
  buildSteamCookieHeaderForUrl,
  buildSteamStoreCookieHeader,
  hasUsableSteamRefreshCookie,
  STEAM_LOGIN_COOKIE_URL,
  STEAM_STORE_ASYNC_CONFIG_URL,
} from "./cookies.mjs";
import {
  loadSessionCookieExport,
  saveSessionCookieExport,
  tokenCacheFilePath,
  writeJsonPrivate,
} from "./session.mjs";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_FALLBACK_TTL_MS = 30 * 60 * 1000;
const MAX_TOKEN_REFRESH_REDIRECTS = 6;
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export class SteamLoginRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SteamLoginRequiredError";
  }
}

export function isSteamLoginRequiredError(error) {
  return error instanceof SteamLoginRequiredError || error?.name === "SteamLoginRequiredError";
}

export async function getStoreAccessToken(options = {}) {
  const dataDir = options.dataDir;
  if (!options.forceRefresh) {
    const cached = loadTokenCache(dataDir);
    if (cached?.token && !tokenExpiresSoon(cached.expiresAt)) {
      return cached;
    }
  }

  let cookieExport = loadSessionCookieExport(dataDir);
  let cookie = buildSteamStoreCookieHeader(cookieExport);
  if ((!cookie || !/\bsteamLoginSecure=/i.test(cookie)) && !hasUsableSteamRefreshCookie(cookieExport)) {
    throw new SteamLoginRequiredError("Steam browser login is required before an access token can be refreshed.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let refreshedWebSession = false;
  if ((!cookie || !/\bsteamLoginSecure=/i.test(cookie)) && hasUsableSteamRefreshCookie(cookieExport)) {
    cookieExport = await refreshSteamWebSession(fetchImpl, cookieExport, dataDir);
    refreshedWebSession = true;
    cookie = buildSteamStoreCookieHeader(cookieExport);
    if (!cookie || !/\bsteamLoginSecure=/i.test(cookie)) {
      throw new SteamLoginRequiredError("Steam refresh cookie did not produce a usable store login session.");
    }
  }
  let response = await fetchStoreAsyncConfig(fetchImpl, cookieExport, dataDir);

  if (response.status === 401 || response.status === 403) {
    if (!refreshedWebSession && hasUsableSteamRefreshCookie(cookieExport)) {
      cookieExport = await refreshSteamWebSession(fetchImpl, cookieExport, dataDir);
      refreshedWebSession = true;
      response = await fetchStoreAsyncConfig(fetchImpl, cookieExport, dataDir);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SteamLoginRequiredError(`Steam store token refresh requires a logged-in browser session; HTTP ${response.status}.`);
    }
  }
  if (!response.ok) {
    throw new Error(`Steam store token refresh failed with HTTP ${response.status || "unknown"}.`);
  }

  let text = await response.text();
  let token = parseStoreWebApiToken(text);
  if (!token && !refreshedWebSession && hasUsableSteamRefreshCookie(cookieExport)) {
    cookieExport = await refreshSteamWebSession(fetchImpl, cookieExport, dataDir);
    refreshedWebSession = true;
    response = await fetchStoreAsyncConfig(fetchImpl, cookieExport, dataDir);
    if (response.status === 401 || response.status === 403) {
      throw new SteamLoginRequiredError(`Steam store token refresh requires a logged-in browser session; HTTP ${response.status}.`);
    }
    if (!response.ok) {
      throw new Error(`Steam store token refresh failed with HTTP ${response.status || "unknown"}.`);
    }
    text = await response.text();
    token = parseStoreWebApiToken(text);
  }
  if (!token) {
    throw new SteamLoginRequiredError("Steam store token response did not include webapi_token. Log in to Steam again and retry.");
  }

  const decoded = decodeSteamAccessToken(token);
  const expiresAt = decoded.expiresAt ?? new Date(Date.now() + TOKEN_FALLBACK_TTL_MS).toISOString();
  const cache = {
    token,
    steamId: decoded.steamId,
    expiresAt,
    refreshedAt: new Date().toISOString(),
    source: STEAM_STORE_ASYNC_CONFIG_URL,
  };
  writeJsonPrivate(tokenCacheFilePath(dataDir), cache);
  return cache;
}

async function refreshSteamWebSession(fetchImpl, initialCookieExport, dataDir) {
  let cookieExport = initialCookieExport;
  const refreshCookie = cookieValueForUrl(cookieExport, STEAM_LOGIN_COOKIE_URL, "steamRefresh_steam");
  const sessionId = cookieValueForUrl(cookieExport, STEAM_LOGIN_COOKIE_URL, "sessionid")
    ?? cookieValueForUrl(cookieExport, STEAM_STORE_ASYNC_CONFIG_URL, "sessionid");
  const nonce = steamTokenFromCookie(refreshCookie);
  if (!nonce || !sessionId) {
    throw new SteamLoginRequiredError("Steam refresh session is incomplete. Log in to Steam again and retry.");
  }

  const finalizeUrl = new URL("/jwt/finalizelogin", STEAM_LOGIN_COOKIE_URL).toString();
  const response = await fetchImpl(finalizeUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: buildSteamCookieHeaderForUrl(cookieExport, finalizeUrl),
      Referer: "https://store.steampowered.com/",
      "User-Agent": BROWSER_USER_AGENT,
    },
    body: new URLSearchParams({
      nonce,
      sessionid: sessionId,
      redir: STEAM_STORE_ASYNC_CONFIG_URL,
    }).toString(),
  });
  cookieExport = persistResponseCookies(cookieExport, finalizeUrl, response.headers, dataDir);
  if (response.status === 401 || response.status === 403) {
    throw new SteamLoginRequiredError(`Steam web-session refresh was rejected; HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`Steam web-session refresh failed with HTTP ${response.status || "unknown"}.`);
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch (error) {
    throw new Error(`Steam web-session refresh response was not valid JSON: ${error.message}`);
  }
  if (Number(payload?.success) === 0 || payload?.success === false) {
    throw new SteamLoginRequiredError(
      stringValue(payload?.message) ?? stringValue(payload?.error) ?? "Steam rejected the refresh token.",
    );
  }

  const steamId = stringValue(payload?.steamID) ?? steamIdFromCookie(refreshCookie);
  for (const transfer of Array.isArray(payload?.transfer_info) ? payload.transfer_info : []) {
    const url = stringValue(transfer?.url);
    if (!url) continue;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(transfer?.params ?? {})) {
      const text = stringValue(value);
      if (text) params.set(key, text);
    }
    if (steamId && !params.has("steamID")) {
      params.set("steamID", steamId);
    }
    const transferResponse = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: buildSteamCookieHeaderForUrl(cookieExport, url),
        Referer: finalizeUrl,
        "User-Agent": BROWSER_USER_AGENT,
      },
      body: params.toString(),
    });
    cookieExport = persistResponseCookies(cookieExport, url, transferResponse.headers, dataDir);
    if (transferResponse.status === 401 || transferResponse.status === 403) {
      throw new SteamLoginRequiredError(`Steam web-session transfer was rejected; HTTP ${transferResponse.status}.`);
    }
    if (!transferResponse.ok && !isRedirectStatus(transferResponse.status)) {
      throw new Error(`Steam web-session transfer failed with HTTP ${transferResponse.status || "unknown"}.`);
    }
  }
  return cookieExport;
}

function persistResponseCookies(cookieExport, url, headers, dataDir) {
  const updated = applySteamResponseCookies(cookieExport, url, headers);
  if (updated.changed) {
    saveSessionCookieExport(dataDir, updated.cookieExport);
  }
  return updated.cookieExport;
}

function cookieValueForUrl(cookieExport, url, name) {
  const header = buildSteamCookieHeaderForUrl(cookieExport, url);
  for (const part of header.split(";")) {
    const text = part.trim();
    const index = text.indexOf("=");
    if (index > 0 && text.slice(0, index).trim().toLowerCase() === name.toLowerCase()) {
      return text.slice(index + 1).trim();
    }
  }
  return undefined;
}

function steamTokenFromCookie(value) {
  let decoded = stringValue(value);
  if (!decoded) return undefined;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Steam also accepts the raw JWT when the cookie is not percent encoded.
  }
  const marker = decoded.indexOf("||");
  return marker >= 0 ? stringValue(decoded.slice(marker + 2)) : decoded;
}

function steamIdFromCookie(value) {
  let decoded = String(value ?? "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Fall through to the raw cookie form.
  }
  return decoded.match(/^(\d{16,20})\|\|/)?.[1];
}

async function fetchStoreAsyncConfig(fetchImpl, initialCookieExport, dataDir) {
  let cookieExport = initialCookieExport;
  let url = STEAM_STORE_ASYNC_CONFIG_URL;
  for (let redirectCount = 0; redirectCount <= MAX_TOKEN_REFRESH_REDIRECTS; redirectCount += 1) {
    const cookie = buildSteamCookieHeaderForUrl(cookieExport, url);
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        ...(cookie ? { Cookie: cookie } : {}),
        Referer: "https://store.steampowered.com/points/shop",
        "User-Agent": BROWSER_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const updated = applySteamResponseCookies(cookieExport, url, response.headers);
    cookieExport = updated.cookieExport;
    if (updated.changed) {
      saveSessionCookieExport(dataDir, cookieExport);
    }

    if (!isRedirectStatus(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new SteamLoginRequiredError("Steam store token refresh redirected without a target. Log in to Steam again and retry.");
    }
    if (redirectCount === MAX_TOKEN_REFRESH_REDIRECTS) {
      throw new SteamLoginRequiredError("Steam store token refresh redirected too many times. Log in to Steam again and retry.");
    }
    url = new URL(location, url).toString();
  }
  throw new SteamLoginRequiredError("Steam store token refresh redirected too many times. Log in to Steam again and retry.");
}

export function clearTokenCache(dataDir) {
  const filePath = tokenCacheFilePath(dataDir);
  if (!existsSync(filePath)) {
    return;
  }
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort. A failed delete only means the next refresh may overwrite it.
  }
}

export function parseStoreWebApiToken(value) {
  if (typeof value !== "string") {
    return findWebApiToken(value);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return text;
  }
  try {
    return findWebApiToken(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function decodeSteamAccessToken(token) {
  const payload = decodeJwtPayload(token);
  const expiresAt = Number.isFinite(Number(payload?.exp))
    ? new Date(Number(payload.exp) * 1000).toISOString()
    : undefined;
  const steamId = stringValue(payload?.sub)
    ?? stringValue(payload?.steamid)
    ?? stringValue(payload?.steam_id);
  return { payload, expiresAt, steamId };
}

function loadTokenCache(dataDir) {
  const filePath = tokenCacheFilePath(dataDir);
  if (!existsSync(filePath)) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  const token = stringValue(parsed?.token);
  if (!token) {
    return undefined;
  }
  return {
    token,
    steamId: stringValue(parsed?.steamId),
    expiresAt: stringValue(parsed?.expiresAt),
    refreshedAt: stringValue(parsed?.refreshedAt),
  };
}

function tokenExpiresSoon(expiresAt) {
  const expires = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(expires)) {
    return true;
  }
  return expires - Date.now() <= TOKEN_REFRESH_SKEW_MS;
}

function findWebApiToken(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (typeof value.webapi_token === "string" && value.webapi_token.trim()) {
    return value.webapi_token.trim();
  }
  for (const child of Object.values(value)) {
    const found = findWebApiToken(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function decodeJwtPayload(token) {
  const [, payload] = String(token).split(".");
  if (!payload) {
    return {};
  }
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function stringValue(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}
