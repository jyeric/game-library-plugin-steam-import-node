#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

import {
  STEAM_STORE_ASYNC_CONFIG_URL,
  STEAM_STORE_COOKIE_URL,
  compactCookiePairs,
} from "../steam/cookies.mjs";
import { decodeSteamAccessToken, parseStoreWebApiToken } from "../steam/accessToken.mjs";
import { beginSteamLogin, completeSteamLogin } from "../steam/session.mjs";

const LOGIN_URL = "https://store.steampowered.com/login/?redir=pointssummary%2Fajaxgetasyncconfig&redir_ssl=1";
const BLANK_URL = "about:blank";
const MAX_LOGIN_MS = 10 * 60 * 1000;
const POLL_MS = 1500;
const LOGIN_COOKIE_NAMES = new Set(["steamLoginSecure"]);
const STEAM_STORE_HOST = "store.steampowered.com";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "auth") {
    throw new Error("usage: node src/auth/steam-auth.mjs auth --data-dir <path>");
  }

  const dataDir = args.dataDir ?? join(homedir(), ".game-library-steam");
  mkdirSync(dataDir, { recursive: true });
  beginSteamLogin(dataDir);
  const profileDir = join(dataDir, "browser-profile");
  mkdirSync(profileDir, { recursive: true });

  const browserPath = args.browser ?? findBrowserExecutable();
  if (!browserPath) {
    throw new Error("Microsoft Edge or Chrome was not found. Install Edge/Chrome or pass --browser <path>.");
  }

  const port = await findOpenPort();
  const browser = spawn(browserPath, browserArgs(port, profileDir, BLANK_URL), {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  browser.unref();

  const page = await connectToFirstPage(port);
  await page.call("Network.enable");
  await page.call("Page.enable");
  // This is the plugin's dedicated browser profile. Clearing it prevents a stale
  // steamLoginSecure cookie from completing re-login before the user sees Steam.
  await page.call("Network.clearBrowserCookies");
  await page.call("Page.navigate", { url: LOGIN_URL });

  const deadline = Date.now() + MAX_LOGIN_MS;
  while (Date.now() < deadline) {
    const target = await activePageTarget(port).catch(() => undefined);
    if (target?.url === "about:blank") {
      await page.call("Page.navigate", { url: LOGIN_URL }).catch(() => {});
    }

    const exportData = await cookieExport(page);
    if (hasLoginCookies(exportData.cookies) && await hasUsableStoreToken(page)) {
      writeSession(dataDir, exportData);
      await closeBrowser(page);
      return;
    }
    await sleep(POLL_MS);
  }

  throw new Error("Timed out waiting for Steam login cookies.");
}

function parseArgs(args) {
  const parsed = { command: args[0] };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data-dir") {
      parsed.dataDir = args[++index];
    } else if (arg === "--browser") {
      parsed.browser = args[++index];
    }
  }
  return parsed;
}

function browserArgs(port, profileDir, url) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=en-US",
    `--app=${url}`,
  ];
  const proxy = process.env.GAME_LIBRARY_PROXY_SERVER ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxy && /^https?:\/\//i.test(proxy)) {
    args.splice(4, 0, `--proxy-server=${proxy}`);
  }
  return args;
}

function findBrowserExecutable() {
  const candidates = process.platform === "win32"
    ? [
        process.env.MSEDGE,
        join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"];
  return candidates.filter(Boolean).find((candidate) => existsSync(candidate));
}

async function connectToFirstPage(port) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const target = await activePageTarget(port).catch(() => undefined);
    if (target?.webSocketDebuggerUrl) {
      return CdpConnection.connect(target.webSocketDebuggerUrl);
    }
    await sleep(300);
  }
  throw new Error("Browser DevTools endpoint did not become available.");
}

async function activePageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  return targets.find((target) => target.type === "page" && isSteamUrl(target.url))
    ?? targets.find((target) => target.type === "page");
}

function isSteamUrl(url) {
  return typeof url === "string" && /^https:\/\/(?:[^/]+\.)?(steampowered|steamcommunity)\.com\//i.test(url);
}

async function cookieExport(page) {
  const result = await page.call("Network.getAllCookies");
  const cookies = (result.cookies ?? [])
    .filter((cookie) => domainMatchesSteam(cookie.domain))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  const storePairs = cookies
    .filter((cookie) => domainMatchesSteamStore(cookie.domain))
    .map((cookie) => ({ name: cookie.name, value: cookie.value }));
  const storeHeader = compactCookiePairs(storePairs).join("; ");
  return {
    exportedAt: new Date().toISOString(),
    source: "steam-auth-browser-cdp",
    cookies,
    cookieHeaderByUrl: {
      [STEAM_STORE_COOKIE_URL]: storeHeader,
      [STEAM_STORE_ASYNC_CONFIG_URL]: storeHeader,
    },
  };
}

function writeSession(dataDir, data) {
  completeSteamLogin(dataDir, data);
}

export function hasLoginCookies(cookies) {
  return [...LOGIN_COOKIE_NAMES].every((name) => cookies.some((cookie) =>
    String(cookie.name) === name
      && domainMatchesSteamStore(cookie.domain)
      && !cookieExpired(cookie.expires),
  ));
}

async function hasUsableStoreToken(page) {
  try {
    const evaluated = await page.call("Runtime.evaluate", {
      expression: `fetch(${JSON.stringify(STEAM_STORE_ASYNC_CONFIG_URL)}, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } }).then((response) => response.text())`,
      awaitPromise: true,
      returnByValue: true,
    });
    const token = parseStoreWebApiToken(evaluated?.result?.value);
    return Boolean(token && decodeSteamAccessToken(token).steamId);
  } catch {
    return false;
  }
}

function domainMatchesSteam(domain) {
  const value = String(domain ?? "").replace(/^\./, "").toLowerCase();
  return value === "steampowered.com"
    || value.endsWith(".steampowered.com")
    || value === "steamcommunity.com"
    || value.endsWith(".steamcommunity.com");
}

function domainMatchesSteamStore(domain) {
  const value = String(domain ?? "").replace(/^\./, "").toLowerCase();
  return value === STEAM_STORE_HOST || STEAM_STORE_HOST.endsWith(`.${value}`);
}

function cookieExpired(expires) {
  const timestamp = Number(expires);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp * 1000 <= Date.now();
}

async function closeBrowser(page) {
  try {
    await page.call("Browser.close");
  } catch {
    await page.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("CDP WebSocket closed")));
  }

  static async connect(wsUrl) {
    const url = new URL(wsUrl);
    const socket = await websocketConnect(url);
    return new CdpConnection(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeWebSocketFrame(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async close() {
    this.socket.end();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 0x1) {
        this.onMessage(frame.payload.toString("utf8"));
      } else if (frame.opcode === 0x8) {
        this.socket.end();
      }
    }
  }

  onMessage(message) {
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed.id || !this.pending.has(parsed.id)) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? "CDP command failed"));
    } else {
      pending.resolve(parsed.result ?? {});
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function websocketConnect(url) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const key = randomBytes(16).toString("base64");
    let header = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("connect", () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", function onHandshake(chunk) {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      socket.off("data", onHandshake);
      const text = header.subarray(0, end).toString("utf8");
      if (!text.startsWith("HTTP/1.1 101")) {
        reject(new Error(`WebSocket upgrade failed: ${text.split("\r\n")[0]}`));
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      if (!text.toLowerCase().includes(`sec-websocket-accept: ${accept}`.toLowerCase())) {
        reject(new Error("WebSocket upgrade returned an invalid accept key."));
        socket.destroy();
        return;
      }
      const remaining = header.subarray(end + 4);
      if (remaining.length) {
        socket.unshift(remaining);
      }
      resolve(socket);
    });
  });
}

function encodeWebSocketFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const high = buffer.readUInt32BE(2);
    if (high !== 0) {
      throw new Error("WebSocket frame is too large.");
    }
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  const masked = Boolean(second & 0x80);
  const maskOffset = masked ? 4 : 0;
  if (buffer.length < offset + maskOffset + length) {
    return undefined;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskOffset;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    opcode: first & 0x0f,
    payload,
    bytes: offset + length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[steam-auth] ${message}`);
    process.exitCode = 1;
  });
}
