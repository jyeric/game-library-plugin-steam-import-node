export const STEAM_STORE_COOKIE_URL = "https://store.steampowered.com/";
export const STEAM_STORE_ASYNC_CONFIG_URL = "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig";
export const STEAM_LOGIN_COOKIE_URL = "https://login.steampowered.com/";

const COOKIE_HEADER_MAX_BYTES = 3800;
const PRIORITY_COOKIE_NAMES = [
  "steamLoginSecure",
  "steamRefresh_steam",
  "sessionid",
  "browserid",
  "steamCountry",
  "timezoneOffset",
  "steamRememberLogin",
  "steamMachineAuth",
];

const priorityByName = new Map(PRIORITY_COOKIE_NAMES.map((name, index) => [name.toLowerCase(), index]));

const TRACKING_COOKIE_PATTERNS = [
  /^_/,
  /^app_impressions$/i,
  /^birthtime$/i,
  /^lastagecheckage$/i,
  /^recentapps$/i,
  /^wants_mature_content$/i,
];

export function buildSteamStoreCookieHeader(cookieExport) {
  return buildSteamCookieHeaderForUrl(cookieExport, STEAM_STORE_ASYNC_CONFIG_URL);
}

/** Builds a request Cookie header using only cookies that are valid for the target Steam URL. */
export function buildSteamCookieHeaderForUrl(cookieExport, targetUrl) {
  const exportedPairs = cookiePairsFromExport(cookieExport, targetUrl);
  const raw = exportedPairs.length ? undefined : cookieHeaderFallback(cookieExport?.cookieHeaderByUrl, targetUrl);
  const pairs = exportedPairs.length ? exportedPairs : parseCookieHeader(raw);
  return compactCookiePairs(pairs).join("; ");
}

/** Returns true while the saved WebBrowser refresh cookie can still renew Steam web access cookies. */
export function hasUsableSteamRefreshCookie(cookieExport) {
  return /(?:^|;\s*)steamRefresh_steam=[^;]+/i.test(
    buildSteamCookieHeaderForUrl(cookieExport, STEAM_LOGIN_COOKIE_URL),
  );
}

/** Applies response Set-Cookie headers to the persisted Steam cookie export. */
export function applySteamResponseCookies(cookieExport, responseUrl, headers) {
  const base = cookieExport && typeof cookieExport === "object" ? cookieExport : {};
  const cookies = Array.isArray(base.cookies)
    ? base.cookies.map((cookie) => ({ ...cookie }))
    : [];
  let changed = false;

  for (const header of setCookieHeaders(headers)) {
    const parsed = parseSetCookie(header, responseUrl);
    if (!parsed) {
      continue;
    }
    const index = cookies.findIndex((cookie) => sameCookieIdentity(cookie, parsed));
    if (parsed.deleted) {
      if (index >= 0) {
        cookies.splice(index, 1);
        changed = true;
      }
      continue;
    }
    const next = parsed.cookie;
    if (index >= 0) {
      if (JSON.stringify(cookies[index]) !== JSON.stringify(next)) {
        cookies[index] = next;
        changed = true;
      }
    } else {
      cookies.push(next);
      changed = true;
    }
  }

  if (!changed) {
    return { cookieExport: base, changed: false };
  }

  const next = {
    ...base,
    exportedAt: new Date().toISOString(),
    source: base.source ?? "steam-session-refresh",
    cookies,
  };
  next.cookieHeaderByUrl = {
    ...(base.cookieHeaderByUrl ?? {}),
    [STEAM_STORE_COOKIE_URL]: buildSteamCookieHeaderForUrl(next, STEAM_STORE_COOKIE_URL),
    [STEAM_STORE_ASYNC_CONFIG_URL]: buildSteamCookieHeaderForUrl(next, STEAM_STORE_ASYNC_CONFIG_URL),
    [STEAM_LOGIN_COOKIE_URL]: buildSteamCookieHeaderForUrl(next, STEAM_LOGIN_COOKIE_URL),
  };
  return { cookieExport: next, changed: true };
}

export function compactCookiePairs(pairs, maxBytes = COOKIE_HEADER_MAX_BYTES) {
  const normalized = pairs
    .map((pair, index) => normalizeCookiePair(pair, index))
    .filter(Boolean)
    .filter((pair) => pair.priority < Number.POSITIVE_INFINITY || !isTrackingCookie(pair.name))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);

  const selected = [];
  const seen = new Set();
  let total = 0;
  for (const pair of normalized) {
    const key = pair.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    const text = `${pair.name}=${pair.value}`;
    const nextTotal = total + Buffer.byteLength(text, "utf8") + (selected.length ? 2 : 0);
    if (nextTotal > maxBytes) {
      continue;
    }
    selected.push(text);
    seen.add(key);
    total = nextTotal;
  }
  return selected;
}

function cookieHeaderFallback(headersByUrl, targetUrl) {
  if (!headersByUrl || typeof headersByUrl !== "object") {
    return undefined;
  }
  const exact = stringValue(headersByUrl[targetUrl]);
  if (exact) {
    return exact;
  }
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [url, header] of Object.entries(headersByUrl)) {
    try {
      if (new URL(url).hostname.toLowerCase() === hostname && stringValue(header)) {
        return stringValue(header);
      }
    } catch {
      // Ignore malformed legacy URL keys.
    }
  }
  return undefined;
}

function cookiePairsFromExport(cookieExport, targetUrl) {
  if (!Array.isArray(cookieExport?.cookies)) {
    return [];
  }
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return [];
  }
  return cookieExport.cookies
    .filter((cookie) => cookieAppliesToUrl(cookie, url))
    .sort((left, right) => cookieSpecificity(right, url) - cookieSpecificity(left, url))
    .map((cookie) => ({
      name: stringValue(cookie?.name),
      value: stringValue(cookie?.value),
    }));
}

function parseCookieHeader(header) {
  if (!header) {
    return [];
  }
  return String(header)
    .split(";")
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) {
        return null;
      }
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
      };
    })
    .filter(Boolean);
}

function normalizeCookiePair(pair, index) {
  const name = stringValue(pair?.name);
  const value = stringValue(pair?.value);
  if (!name || !value || /[\r\n;=]/.test(name) || /[\r\n;]/.test(value)) {
    return null;
  }
  return {
    name,
    value,
    index,
    priority: priorityByName.get(name.toLowerCase()) ?? Number.POSITIVE_INFINITY,
  };
}

function cookieAppliesToUrl(cookie, url) {
  const domain = normalizedDomain(cookie?.domain);
  if (!domain || !isSteamDomain(domain) || cookieExpired(cookie?.expires)) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    return false;
  }
  if (cookie?.secure === true && url.protocol !== "https:") {
    return false;
  }
  return pathMatches(url.pathname || "/", stringValue(cookie?.path) ?? "/");
}

function cookieSpecificity(cookie, url) {
  const domain = normalizedDomain(cookie?.domain) ?? "";
  const path = stringValue(cookie?.path) ?? "/";
  return (url.hostname.toLowerCase() === domain ? 10000 : 0) + (domain.length * 10) + path.length;
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function parseSetCookie(header, responseUrl) {
  let url;
  try {
    url = new URL(responseUrl);
  } catch {
    return undefined;
  }
  if (!isSteamDomain(url.hostname.toLowerCase())) {
    return undefined;
  }

  const parts = String(header).split(";");
  const pair = parts.shift()?.trim();
  const equals = pair?.indexOf("=") ?? -1;
  if (!pair || equals <= 0) {
    return undefined;
  }
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name || /[\r\n;=]/.test(name) || /[\r\n;]/.test(value)) {
    return undefined;
  }

  const attributes = new Map();
  const flags = new Set();
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const index = part.indexOf("=");
    if (index > 0) {
      attributes.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
    } else {
      flags.add(part.toLowerCase());
    }
  }

  const originHost = url.hostname.toLowerCase();
  const requestedDomain = normalizedDomain(attributes.get("domain"));
  const domain = requestedDomain ?? originHost;
  if (!isSteamDomain(domain) || (originHost !== domain && !originHost.endsWith(`.${domain}`))) {
    return undefined;
  }
  const path = attributes.get("path")?.startsWith("/")
    ? attributes.get("path")
    : defaultCookiePath(url.pathname);

  let expires;
  let deleted = !value;
  if (attributes.has("max-age")) {
    const maxAge = Number(attributes.get("max-age"));
    if (Number.isFinite(maxAge)) {
      deleted = deleted || maxAge <= 0;
      expires = Math.floor(Date.now() / 1000) + maxAge;
    }
  } else if (attributes.has("expires")) {
    const parsed = Date.parse(attributes.get("expires"));
    if (Number.isFinite(parsed)) {
      expires = Math.floor(parsed / 1000);
      deleted = deleted || parsed <= Date.now();
    }
  }

  return {
    deleted,
    cookie: {
      name,
      value,
      domain: requestedDomain ? `.${domain}` : domain,
      path,
      ...(Number.isFinite(expires) ? { expires } : {}),
      httpOnly: flags.has("httponly"),
      secure: flags.has("secure"),
      ...(attributes.has("samesite") ? { sameSite: attributes.get("samesite") } : {}),
    },
  };
}

function sameCookieIdentity(cookie, parsed) {
  const other = parsed.cookie;
  return String(cookie?.name) === other.name
    && normalizedDomain(cookie?.domain) === normalizedDomain(other.domain)
    && (stringValue(cookie?.path) ?? "/") === other.path;
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

function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith("/") || pathname === "/") {
    return "/";
  }
  const end = pathname.lastIndexOf("/");
  return end <= 0 ? "/" : pathname.slice(0, end);
}

function normalizedDomain(domain) {
  return stringValue(domain)?.replace(/^\./, "").toLowerCase();
}

function isSteamDomain(domain) {
  return domain === "steampowered.com"
    || domain.endsWith(".steampowered.com")
    || domain === "steamcommunity.com"
    || domain.endsWith(".steamcommunity.com");
}

function cookieExpired(expires) {
  const timestamp = Number(expires);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp * 1000 <= Date.now();
}

function isTrackingCookie(name) {
  return TRACKING_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
