import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { buildSteamStoreCookieHeader, STEAM_STORE_ASYNC_CONFIG_URL } from "./cookies.mjs";
import { loadSessionCookieExport, tokenCacheFilePath, writeJsonPrivate } from "./session.mjs";

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

  const cookieExport = loadSessionCookieExport(dataDir);
  const cookie = buildSteamStoreCookieHeader(cookieExport);
  if (!cookie || !/\bsteamLoginSecure=/i.test(cookie)) {
    throw new SteamLoginRequiredError("Steam browser login is required before an access token can be refreshed.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchStoreAsyncConfig(fetchImpl, cookie);

  if (response.status === 401 || response.status === 403) {
    throw new SteamLoginRequiredError(`Steam store token refresh requires a logged-in browser session; HTTP ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`Steam store token refresh failed with HTTP ${response.status || "unknown"}.`);
  }

  const text = await response.text();
  const token = parseStoreWebApiToken(text);
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

async function fetchStoreAsyncConfig(fetchImpl, initialCookie) {
  const jar = cookieJarFromHeader(initialCookie);
  let url = STEAM_STORE_ASYNC_CONFIG_URL;
  for (let redirectCount = 0; redirectCount <= MAX_TOKEN_REFRESH_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookieHeaderFromJar(jar),
        Referer: "https://store.steampowered.com/points/shop",
        "User-Agent": BROWSER_USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    applySetCookieHeaders(jar, response.headers);

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

function cookieJarFromHeader(header) {
  const jar = new Map();
  for (const part of String(header ?? "").split(";")) {
    const text = part.trim();
    const index = text.indexOf("=");
    if (index <= 0) {
      continue;
    }
    jar.set(text.slice(0, index), text.slice(index + 1));
  }
  return jar;
}

function cookieHeaderFromJar(jar) {
  return [...jar.entries()]
    .filter(([name, value]) => name && value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function applySetCookieHeaders(jar, headers) {
  for (const header of setCookieHeaders(headers)) {
    const pair = String(header).split(";")[0];
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) {
      continue;
    }
    if (!value || deletesCookie(header)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function setCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const header = headers?.get?.("set-cookie");
  return header ? splitCombinedSetCookieHeader(header) : [];
}

function splitCombinedSetCookieHeader(header) {
  const parts = [];
  let start = 0;
  let inExpires = false;
  const text = String(header);
  for (let index = 0; index < text.length; index += 1) {
    const rest = text.slice(index);
    if (rest.toLowerCase().startsWith("expires=")) {
      inExpires = true;
      index += "expires=".length - 1;
      continue;
    }
    if (inExpires && text[index] === ";") {
      inExpires = false;
      continue;
    }
    if (!inExpires && text[index] === ",") {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function deletesCookie(header) {
  return /;\s*max-age=0(?:;|$)/i.test(header)
    || /;\s*expires=Thu,\s*01 Jan 1970/i.test(header);
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
