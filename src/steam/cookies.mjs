export const STEAM_STORE_COOKIE_URL = "https://store.steampowered.com/";
export const STEAM_STORE_ASYNC_CONFIG_URL = "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig";

const STEAM_STORE_HOST = "store.steampowered.com";
const COOKIE_HEADER_MAX_BYTES = 3800;
const PRIORITY_COOKIE_NAMES = [
  "steamLoginSecure",
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
  const exportedPairs = cookiePairsFromExport(cookieExport);
  const raw = exportedPairs.length
    ? undefined
    : stringValue(cookieExport?.cookieHeaderByUrl?.[STEAM_STORE_ASYNC_CONFIG_URL])
      ?? stringValue(cookieExport?.cookieHeaderByUrl?.[STEAM_STORE_COOKIE_URL])
      ?? firstStoreCookieHeader(cookieExport?.cookieHeaderByUrl);
  const pairs = exportedPairs.length ? exportedPairs : parseCookieHeader(raw);
  return compactCookiePairs(pairs).join("; ");
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

function firstStoreCookieHeader(headersByUrl) {
  if (!headersByUrl || typeof headersByUrl !== "object") {
    return undefined;
  }
  for (const [url, header] of Object.entries(headersByUrl)) {
    if (/^https:\/\/(?:[^/]+\.)?steampowered\.com\//i.test(url) && stringValue(header)) {
      return stringValue(header);
    }
  }
  return undefined;
}

function cookiePairsFromExport(cookieExport) {
  if (!Array.isArray(cookieExport?.cookies)) {
    return [];
  }
  return cookieExport.cookies
    .filter((cookie) => domainMatchesSteamStore(cookie?.domain))
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

function domainMatchesSteamStore(domain) {
  const value = stringValue(domain)?.replace(/^\./, "").toLowerCase();
  return value === STEAM_STORE_HOST || STEAM_STORE_HOST.endsWith(`.${value}`);
}

function isTrackingCookie(name) {
  return TRACKING_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
