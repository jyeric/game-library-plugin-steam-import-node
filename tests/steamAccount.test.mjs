import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleAction, ACCOUNT_PROVIDER_ID } from "../src/jsonrpc/handleAction.mjs";
import { parseStoreWebApiToken, decodeSteamAccessToken, getStoreAccessToken } from "../src/steam/accessToken.mjs";
import { readSteamAccountGames } from "../src/steam/accountLibrary.mjs";
import { buildSteamStoreCookieHeader } from "../src/steam/cookies.mjs";
import { sessionFilePath, steamSessionStatus, writeJsonPrivate } from "../src/steam/session.mjs";

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Steam store access tokens", () => {
  it("parses raw or nested store webapi_token values", () => {
    assert.equal(parseStoreWebApiToken("token-value"), "token-value");
    assert.equal(
      parseStoreWebApiToken(JSON.stringify({ response: { data: { webapi_token: "nested-token" } } })),
      "nested-token",
    );
  });

  it("decodes SteamID64 and expiry from access-token JWT payloads", () => {
    const token = fakeSteamToken("76561198000000001", 1893456000);
    const decoded = decodeSteamAccessToken(token);

    assert.equal(decoded.steamId, "76561198000000001");
    assert.equal(decoded.expiresAt, "2030-01-01T00:00:00.000Z");
  });

  it("applies Steam redirect cookies while refreshing the store token", async () => {
    const dataDir = tempDataDir();
    const token = fakeSteamToken("76561198000000001", 1893456000);
    writeJsonPrivate(sessionFilePath(dataDir), {
      exportedAt: new Date().toISOString(),
      cookies: [
        { name: "steamLoginSecure", value: "session-cookie", domain: "store.steampowered.com", path: "/" },
        { name: "sessionid", value: "store-session", domain: "store.steampowered.com", path: "/" },
      ],
    });

    const cookieHeaders = [];
    const fetchImpl = async (_url, options) => {
      cookieHeaders.push(options.headers.Cookie);
      if (cookieHeaders.length === 1) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig",
            "set-cookie": "steamCountry=HK%7Credirected; path=/; secure; HttpOnly; SameSite=None",
          },
        });
      }
      assert.match(options.headers.Cookie, /steamCountry=HK%7Credirected/);
      return jsonResponse({ success: 1, data: { webapi_token: token } });
    };

    const result = await getStoreAccessToken({ dataDir, fetchImpl, forceRefresh: true });

    assert.equal(cookieHeaders.length, 2);
    assert.equal(result.token, token);
    assert.equal(result.steamId, "76561198000000001");
  });

  it("builds store cookie headers without login-domain cookies", () => {
    const header = buildSteamStoreCookieHeader({
      cookies: [
        { name: "steamLoginSecure", value: "store-login", domain: "store.steampowered.com" },
        { name: "steamRefresh_steam", value: "login-refresh", domain: "login.steampowered.com" },
        { name: "wide", value: "wide-cookie", domain: ".steampowered.com" },
      ],
      cookieHeaderByUrl: {
        "https://store.steampowered.com/": "steamRefresh_steam=bad",
      },
    });

    assert.match(header, /steamLoginSecure=store-login/);
    assert.match(header, /wide=wide-cookie/);
    assert.doesNotMatch(header, /steamRefresh_steam/);
  });
});

describe("Steam plugin manifest", () => {
  it("declares the Steam family, concrete providers, logo, and reviewed login command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

    assert.equal(manifest.logoPath, "logo.svg");
    assert.equal(manifest.providerFamilies, undefined);
    assert.equal(manifest.hostApis.includes("tools.requestReviewedCommand"), true);
    assert.equal(manifest.dependencies.runtimes[0].versionRequirement, ">=20 <25");
    assert.equal(
      manifest.dependencies.runtimes[0].install.url,
      "https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip",
    );
    assert.equal(manifest.dependencies.runtimes[0].install.version, "22.23.1");
    assert.equal(manifest.externalTools[0].id, "steam-auth");
    assert.equal(manifest.externalTools[0].executablePath, "<NODE_EXE>");
    assert.deepEqual(
      manifest.providers.map((provider) => [provider.id, provider.capabilities]),
      [
        ["community.steam_import_node:import", ["import"]],
        ["community.steam_import_node:account", ["account-import"]],
        ["community.steam_import_node:launch", ["launch"]],
      ],
    );
    assert.equal(
      manifest.providers.every(
        (provider) => provider.familyId === "steam",
      ),
      true,
    );
    assert.equal(
      manifest.runtimeActions.find((action) => action.id === "read-account-candidates")?.hostApi,
      "accounts.acceptCandidates",
    );
    assert.equal(manifest.hostApis.includes("accounts.acceptStatus"), true);
    assert.equal(
      manifest.runtimeActions.find((action) => action.id === "account-status")?.hostApi,
      "accounts.acceptStatus",
    );
    assert.deepEqual(
      manifest.providers.find((provider) => provider.id === ACCOUNT_PROVIDER_ID)?.runtimeActions,
      {
        "accounts.readCandidates": "read-account-candidates",
        "accounts.status": "account-status",
        "accounts.login": "login",
      },
    );
  });
});

describe("Steam account session status", () => {
  it("returns logged-out state without exposing a missing session", async () => {
    const dataDir = tempDataDir();
    const previous = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = dataDir;
    try {
      const result = await handleAction("steam-account-status-missing", {
        actionId: "account-status",
        payload: {},
      });
      assert.deepEqual(result.result, {
        hostApi: "accounts.acceptStatus",
        payload: {
          providerId: ACCOUNT_PROVIDER_ID,
          loggedIn: false,
          message: "Steam browser login is required.",
        },
      });
    } finally {
      restoreEnv("GAME_LIBRARY_PLUGIN_DATA_DIR", previous);
    }
  });

  it("derives the SteamID from a saved login cookie and returns it after login", async () => {
    const dataDir = tempDataDir();
    const previous = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = dataDir;
    writeJsonPrivate(sessionFilePath(dataDir), {
      exportedAt: new Date().toISOString(),
      cookies: [{
        name: "steamLoginSecure",
        value: "76561198000000001%7C%7Csession-secret",
        domain: "store.steampowered.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
      }],
    });
    try {
      assert.deepEqual(steamSessionStatus(dataDir), {
        loggedIn: true,
        accountId: "76561198000000001",
        message: "Steam browser session is ready.",
      });
      const result = await handleAction("steam-login-complete", {
        actionId: "login",
        payload: {
          runtimeHostResult: {
            hostApi: "tools.requestReviewedCommand",
            payload: { success: true },
          },
        },
      });
      assert.deepEqual(result.result, {
        hostApi: "accounts.acceptStatus",
        payload: {
          providerId: ACCOUNT_PROVIDER_ID,
          loggedIn: true,
          accountId: "76561198000000001",
          message: "Steam browser login completed.",
        },
      });
    } finally {
      restoreEnv("GAME_LIBRARY_PLUGIN_DATA_DIR", previous);
    }
  });
});

describe("Steam account and family library import", () => {
  it("requests the Steam browser login command when no session is saved", async () => {
    const dataDir = tempDataDir();
    const previous = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = dataDir;
    try {
      const result = await handleAction("steam-account-login-required", {
        actionId: "read-account-candidates",
        payload: {},
      });

      assert.equal(result.result.hostApi, "tools.requestReviewedCommand");
      assert.deepEqual(result.result.payload, {
        toolId: "steam-auth",
        commandId: "auth",
        providerId: ACCOUNT_PROVIDER_ID,
        variables: {},
        message: "Steam browser login is required. Confirm the Steam browser login command, complete login, then retry.",
      });
    } finally {
      restoreEnv("GAME_LIBRARY_PLUGIN_DATA_DIR", previous);
    }
  });

  it("keeps the JSON-RPC id when async Steam requests fail", async () => {
    const dataDir = tempDataDir();
    const previousDataDir = process.env.GAME_LIBRARY_PLUGIN_DATA_DIR;
    const previousFetch = globalThis.fetch;
    process.env.GAME_LIBRARY_PLUGIN_DATA_DIR = dataDir;
    writeJsonPrivate(sessionFilePath(dataDir), {
      exportedAt: new Date().toISOString(),
      cookies: [
        {
          name: "steamLoginSecure",
          value: "session-cookie",
          domain: ".steampowered.com",
          path: "/",
        },
      ],
    });
    globalThis.fetch = async () => {
      throw new Error("simulated fetch failed");
    };

    try {
      const result = await handleAction("client-runtime-request-id", {
        actionId: "read-account-candidates",
        payload: {},
      });

      assert.equal(result.id, "client-runtime-request-id");
      assert.equal(result.error.message, "simulated fetch failed");
    } finally {
      restoreEnv("GAME_LIBRARY_PLUGIN_DATA_DIR", previousDataDir);
      globalThis.fetch = previousFetch;
    }
  });

  it("merges owned and family-shared apps from access-token Steam APIs", async () => {
    const dataDir = tempDataDir();
    const token = fakeSteamToken("76561198000000001", 1893456000);
    writeJsonPrivate(sessionFilePath(dataDir), {
      exportedAt: new Date().toISOString(),
      cookies: [
        {
          name: "steamLoginSecure",
          value: "session-cookie",
          domain: ".steampowered.com",
          path: "/",
        },
      ],
    });

    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url: new URL(url), options });
      const parsed = new URL(url);
      if (parsed.hostname === "store.steampowered.com") {
        assert.match(options.headers.Cookie, /steamLoginSecure=session-cookie/);
        return jsonResponse({ webapi_token: token });
      }
      if (parsed.pathname.includes("/IPlayerService/GetOwnedGames/")) {
        assert.equal(parsed.searchParams.get("access_token"), token);
        assert.equal(parsed.searchParams.get("steamid"), "76561198000000001");
        return jsonResponse({
          response: {
            games: [
              { appid: 20, name: "Duplicate Owned" },
              { appid: 10, name: "Owned Game" },
            ],
          },
        });
      }
      if (parsed.pathname.includes("/IFamilyGroupsService/GetFamilyGroupForUser/")) {
        assert.equal(parsed.searchParams.get("include_family_group_response"), "1");
        return jsonResponse({ response: { family_groupid: "123456" } });
      }
      if (parsed.pathname.includes("/IFamilyGroupsService/GetSharedLibraryApps/")) {
        assert.equal(parsed.searchParams.get("family_groupid"), "123456");
        assert.equal(parsed.searchParams.get("include_own"), "0");
        assert.equal(parsed.searchParams.get("include_non_games"), "0");
        assert.equal(parsed.searchParams.get("language"), "schinese");
        return jsonResponse({
          response: {
            apps: [
              { appid: 20, name: "Duplicate Shared", owner_steamids: ["76561198000000002"], exclude_reason: 0, app_type: 1 },
              { appid: 30, name: "Shared Game", owner_steamids: ["76561198000000003"], exclude_reason: 0, app_type: 1 },
              { appid: 40, name: "Excluded Shared", exclude_reason: 1, app_type: 1 },
              { appid: 50, name: "Shared Tool", exclude_reason: 0, app_type: 2 },
            ],
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await readSteamAccountGames(
      { options: { parameters: { language: "zh-CN" } } },
      { dataDir, fetchImpl },
    );

    assert.equal(requests.length, 4);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.externalIds.steam, candidate.title, candidate.confidence]),
      [
        ["20", "Duplicate Owned", 86],
        ["10", "Owned Game", 86],
        ["30", "Shared Game", 82],
      ],
    );
    const shared = result.candidates.find((candidate) => candidate.externalIds.steam === "30");
    assert.match(shared.description, /family-shared/);
    assert.equal(shared.path, "steam://install/30");
    assert.equal(shared.executable, "steam://install/30");
    assert.deepEqual(shared.networkManifest.launchOptions, []);
    assert.deepEqual(shared.externalIdProvenance.steam.ownerSteamIds, ["76561198000000003"]);
  });
});

function tempDataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "steam-plugin-test-"));
  tempDirs.push(dir);
  return dir;
}

function fakeSteamToken(steamId, exp) {
  return [
    base64Url({ alg: "none", typ: "JWT" }),
    base64Url({ sub: steamId, exp }),
    "signature",
  ].join(".");
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
