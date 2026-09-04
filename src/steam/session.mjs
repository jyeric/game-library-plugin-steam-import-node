import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasUsableSteamRefreshCookie } from "./cookies.mjs";

const SESSION_FILE_NAME = "steam-session.json";
const TOKEN_CACHE_FILE_NAME = "steam-token.json";
const LOGIN_STATE_FILE_NAME = "steam-login-state.json";
const LOGIN_PENDING_TTL_MS = 10 * 60 * 1000;

export function sessionFilePath(dataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR) {
  return join(dataDirRoot(dataDir), SESSION_FILE_NAME);
}

export function tokenCacheFilePath(dataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR) {
  return join(dataDirRoot(dataDir), TOKEN_CACHE_FILE_NAME);
}

export function loginStateFilePath(dataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR) {
  return join(dataDirRoot(dataDir), LOGIN_STATE_FILE_NAME);
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
  const loginState = readJson(loginStateFilePath(dataDir));
  if (loginState?.state === "pending") {
    const startedAt = Date.parse(loginState.startedAt ?? "");
    if (Number.isFinite(startedAt) && Date.now() - startedAt < LOGIN_PENDING_TTL_MS) {
      return {
        loggedIn: false,
        pending: true,
        message: "Waiting for Steam browser login to complete.",
      };
    }
  }
  const session = loadSessionCookieExport(dataDir);
  const loginCookie = session?.cookies?.find(
    (cookie) => String(cookie?.name).toLowerCase() === "steamloginsecure",
  );
  const headerValue = loginCookie?.value ?? steamLoginSecureFromHeaders(session?.cookieHeaderByUrl);
  const refreshable = hasUsableSteamRefreshCookie(session);

  if (loginState?.state === "required" && !refreshable) {
    return {
      loggedIn: false,
      message: "Steam browser login has expired.",
    };
  }

  if ((!headerValue || cookieExpired(loginCookie?.expires)) && !refreshable) {
    return {
      loggedIn: false,
      message: "Steam browser login is required.",
    };
  }

  const token = readJson(tokenCacheFilePath(dataDir));
  return {
    loggedIn: true,
    accountId: stringValue(token?.steamId) ?? steamIdFromLoginCookie(headerValue),
    message: headerValue && !cookieExpired(loginCookie?.expires)
      ? "Steam browser session is ready."
      : "Steam browser session can be refreshed.",
  };
}

/** Marks the saved browser session unusable after Steam rejects token refresh. */
export function markSteamLoginRequired(dataDir) {
  writeJsonPrivate(loginStateFilePath(dataDir), {
    state: "required",
    updatedAt: new Date().toISOString(),
  });
}

/** Marks login pending before the detached browser helper starts, closing the stale-cookie race. */
export function markSteamLoginPending(dataDir) {
  writeJsonPrivate(loginStateFilePath(dataDir), {
    state: "pending",
    startedAt: new Date().toISOString(),
  });
}

/** Starts a fresh login without allowing an old cookie or token to report a false success. */
export function beginSteamLogin(dataDir) {
  removePrivateFile(sessionFilePath(dataDir));
  removePrivateFile(tokenCacheFilePath(dataDir));
  markSteamLoginPending(dataDir);
}

/** Commits a newly captured Steam session and clears the pending-login marker. */
export function completeSteamLogin(dataDir, session) {
  writeJsonPrivate(sessionFilePath(dataDir), session);
  removePrivateFile(tokenCacheFilePath(dataDir));
  removePrivateFile(loginStateFilePath(dataDir));
}

/** Replaces the persisted Steam web-session cookie export after a successful refresh. */
export function saveSessionCookieExport(dataDir, session) {
  writeJsonPrivate(sessionFilePath(dataDir), session);
}

/** Clears a stale login-required marker after a verified account-library request succeeds. */
export function clearSteamLoginState(dataDir) {
  removePrivateFile(loginStateFilePath(dataDir));
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

function removePrivateFile(filePath) {
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Best effort: the caller will still overwrite the state on the next successful login.
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
