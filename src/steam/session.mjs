import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_FILE_NAME = "steam-session.json";
const TOKEN_CACHE_FILE_NAME = "steam-token.json";

export function sessionFilePath(dataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR) {
  return join(dataDirRoot(dataDir), SESSION_FILE_NAME);
}

export function tokenCacheFilePath(dataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR) {
  return join(dataDirRoot(dataDir), TOKEN_CACHE_FILE_NAME);
}

export function loadSessionCookieExport(dataDir) {
  const filePath = sessionFilePath(dataDir);
  if (!existsSync(filePath)) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed?.cookies) && !parsed?.cookieHeaderByUrl) {
    return undefined;
  }
  return parsed;
}

/** Returns sanitized Steam login state without exposing cookie or token material. */
export function steamSessionStatus(dataDir) {
  const session = loadSessionCookieExport(dataDir);
  const loginCookie = session?.cookies?.find(
    (cookie) => String(cookie?.name).toLowerCase() === "steamloginsecure",
  );
  const headerValue = loginCookie?.value ?? steamLoginSecureFromHeaders(session?.cookieHeaderByUrl);
  if (!headerValue || cookieExpired(loginCookie?.expires)) {
    return {
      loggedIn: false,
      message: "Steam browser login is required.",
    };
  }

  const token = readJson(tokenCacheFilePath(dataDir));
  return {
    loggedIn: true,
    accountId: stringValue(token?.steamId) ?? steamIdFromLoginCookie(headerValue),
    message: "Steam browser session is ready.",
  };
}

export function writeJsonPrivate(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function steamLoginSecureFromHeaders(headers) {
  for (const header of Object.values(headers ?? {})) {
    const match = String(header).match(/(?:^|;\s*)steamLoginSecure=([^;]+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function steamIdFromLoginCookie(value) {
  let decoded = String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // The raw cookie still contains the SteamID prefix when it is not URL encoded.
  }
  return decoded.match(/^(\d{16,20})(?:\|\||$)/)?.[1];
}

function cookieExpired(expires) {
  const timestamp = Number(expires);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp * 1000 <= Date.now();
}

function dataDirRoot(dataDir) {
  const value = stringValue(dataDir);
  if (value) {
    return value;
  }
  const current = dirname(fileURLToPath(import.meta.url));
  return resolve(current, "..", "..", ".session");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
