import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const fixtureSteamRoot = path.join(__dirname, "fixtures", "Steam");
const runtimeEntry = path.join(pluginRoot, "runtime", "provider.mjs");

describe("Node JSON-RPC runtime host compatibility", () => {
  it("returns parseable JSON for detect-libraries", () => {
    const response = executeRuntime({
      id: "detect-libraries",
      params: {
        actionId: "detect-libraries",
        payload: {},
      },
    });

    assert.equal(response.result.hostApi, "imports.acceptLibraries");
    assert.equal(response.result.payload.providerId, "community.steam_import_node:import");
    assert.equal(response.result.payload.libraries.length, 1);
    assert.equal(response.result.payload.libraries[0].manifestCount, 2);
  });

  it("returns parseable JSON for read-candidates with a normal path", () => {
    const response = executeRuntime({
      id: "read-candidates",
      params: {
        actionId: "read-candidates",
        payload: { libraries: [{ path: fixtureSteamRoot }] },
      },
    });

    assert.equal(response.result.hostApi, "imports.acceptCandidates");
    assert.equal(response.result.payload.candidates.length, 2);
    const candidate = response.result.payload.candidates.find((item) => item.externalIds.steam === "2403320");
    assert.ok(candidate);
    assert.equal(candidate.artwork.banner.source, "provider");
    assert.equal(candidate.artwork.banner.providerId, "steam");
    assert.equal(candidate.artwork.banner.externalId, "2403320");
    assert.equal(candidate.artwork.banner.cachedPath, candidate.bannerUrl);
  });

  it("ignores stale wrapper stdin files and answers the live request id", () => {
    const staleDir = mkdtempSync(path.join(tmpdir(), "steam-runtime-stale-"));
    try {
      const staleRequest = path.join(staleDir, "request.json");
      writeFileSync(
        staleRequest,
        JSON.stringify({
          jsonrpc: "2.0",
          id: "stale-id",
          method: "executeAction",
          params: {
            pluginId: "community.steam_import_node",
            actionId: "detect-libraries",
            payload: {},
            hostApis: [],
          },
        }),
        "utf8",
      );

      const response = executeRuntime(
        {
          id: "live-id",
          params: {
            actionId: "resolve-launch",
            payload: {
              game: { externalIds: { steam: "730" } },
              option: {},
            },
          },
        },
        {
          STEAM_IMPORT_PLUGIN_STDIN_FILE: staleRequest,
          STEAM_IMPORT_PLUGIN_STDOUT_FILE: path.join(staleDir, "response.json"),
        },
      );

      assert.equal(response.id, "live-id");
      assert.equal(response.result.hostApi, "launch.acceptResolution");
      assert.equal(response.result.payload.canHandle, true);
    } finally {
      rmSync(staleDir, { recursive: true, force: true });
    }
  });

  it("returns parseable JSON for launch resolution and launch requests", () => {
    const payload = {
      game: {
        id: "game-1",
        title: "Counter-Strike 2",
        externalIds: { steam: "730" },
      },
      option: {
        providerId: "community.steam_import_node:launch",
      },
    };

    const resolution = executeRuntime({
      id: "resolve-launch",
      params: {
        actionId: "resolve-launch",
        payload,
      },
    });
    assert.equal(resolution.result.hostApi, "launch.acceptResolution");
    assert.equal(resolution.result.payload.canHandle, true);

    const launch = executeRuntime({
      id: "request-launch",
      params: {
        actionId: "request-launch",
        payload,
      },
    });
    assert.equal(launch.result.hostApi, "launch.acceptRequest");
    assert.equal(launch.result.payload.url, "steam://rungameid/730");
  });

  it("returns login-required without requesting a reviewed command from a background import", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "steam-runtime-login-required-"));
    try {
      const dataDir = path.join(tempRoot, "plugin-data");
      mkdirSync(dataDir, { recursive: true });
      const response = executeRuntime(
        {
          id: "account-import-login-required",
          params: {
            actionId: "read-account-candidates",
            payload: { providerId: "community.steam_import_node:account" },
          },
        },
        { GAME_LIBRARY_PLUGIN_DATA_DIR: dataDir },
        { expectResult: false, expectedHostCalls: 0 },
      );

      assert.equal(response.error.data.messageKey, "error.providerLoginRequired");
      assert.equal(
        response.error.data.messageParams.providerId,
        "community.steam_import_node:account",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("launches one reviewed login command and returns a pending account status", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "steam-runtime-login-"));
    try {
      const dataDir = path.join(tempRoot, "plugin-data");
      mkdirSync(dataDir, { recursive: true });
      const response = executeRuntime(
        {
          id: "account-login",
          params: {
            actionId: "login",
            payload: { providerId: "community.steam_import_node:account" },
          },
        },
        { GAME_LIBRARY_PLUGIN_DATA_DIR: dataDir },
        {
          expectedHostCalls: 1,
          expectedHostApis: ["tools.requestReviewedCommand"],
          hostResponses: [{
            jsonrpc: "2.0",
            id: "host-1",
            result: { payload: { ok: true, messageKey: "command.pluginProcessLaunched" } },
          }],
        },
      );

      assert.equal(response.result.hostApi, "accounts.acceptStatus");
      assert.deepEqual(response.result.payload, {
        providerId: "community.steam_import_node:account",
        loggedIn: false,
        pending: true,
        message: "Steam browser login opened. Complete login to continue the account import.",
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes account HTTP through the host and keeps the request id on host failure", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "steam-runtime-async-error-"));
    try {
      const dataDir = path.join(tempRoot, "plugin-data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        path.join(dataDir, "steam-session.json"),
        JSON.stringify({
          exportedAt: new Date().toISOString(),
          cookies: [
            {
              name: "steamLoginSecure",
              value: "session-cookie",
              domain: ".steampowered.com",
              path: "/",
            },
          ],
        }),
        "utf8",
      );
      const response = executeRuntime(
        {
          id: "community.steam_import_node:read-account-candidates:host-id",
          params: {
            actionId: "read-account-candidates",
            payload: {
              providerId: "community.steam_import_node:account",
              options: { parameters: {} },
            },
          },
        },
        {
          GAME_LIBRARY_PLUGIN_DATA_DIR: dataDir,
        },
        {
          expectResult: false,
          expectedHostCalls: 1,
          hostResponses: [{
            jsonrpc: "2.0",
            id: "host-1",
            error: { code: -32000, message: "simulated host fetch failed" },
          }],
        },
      );

      assert.equal(response.id, "community.steam_import_node:read-account-candidates:host-id");
      assert.equal(response.error.message, "simulated host fetch failed");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("completes account import through four mediated host HTTP calls", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "steam-runtime-host-http-"));
    try {
      const dataDir = path.join(tempRoot, "plugin-data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        path.join(dataDir, "steam-session.json"),
        JSON.stringify({
          exportedAt: new Date().toISOString(),
          cookies: [{
            name: "steamLoginSecure",
            value: "session-cookie",
            domain: ".steampowered.com",
            path: "/",
          }],
        }),
        "utf8",
      );
      const token = fakeSteamToken("76561198000000001");
      const response = executeRuntime(
        {
          id: "account-import-success",
          params: {
            actionId: "read-account-candidates",
            payload: { options: { parameters: { language: "zh-CN" } } },
          },
        },
        { GAME_LIBRARY_PLUGIN_DATA_DIR: dataDir },
        {
          expectedHostCalls: 4,
          assertHostCalls(hostCalls) {
            assert.equal(hostCalls[0].params.payload.url, "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig");
            assert.equal(hostCalls[0].params.payload.redirect, "manual");
            assert.equal(hostCalls[0].params.payload.includeSetCookie, true);
            assert.match(hostCalls[0].params.payload.headers.cookie, /steamLoginSecure=session-cookie/);
            assert.match(hostCalls[1].params.payload.url, /IPlayerService\/GetOwnedGames/);
            assert.match(hostCalls[2].params.payload.url, /IFamilyGroupsService\/GetFamilyGroupForUser/);
            assert.match(hostCalls[3].params.payload.url, /IFamilyGroupsService\/GetSharedLibraryApps/);
          },
          hostResponses: [
            hostHttpResponse(1, { webapi_token: token }),
            hostHttpResponse(2, { response: { games: [{ appid: 10, name: "Owned Game" }] } }),
            hostHttpResponse(3, { response: { family_groupid: "123456" } }),
            hostHttpResponse(4, {
              response: {
                apps: [{
                  appid: 30,
                  name: "Shared Game",
                  owner_steamids: ["76561198000000003"],
                  exclude_reason: 0,
                  app_type: 1,
                }],
              },
            }),
          ],
        },
      );

      assert.equal(response.result.hostApi, "accounts.acceptCandidates");
      assert.deepEqual(
        response.result.payload.candidates.map((candidate) => candidate.externalIds.steam),
        ["10", "30"],
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function hostHttpResponse(sequence, body) {
  return {
    jsonrpc: "2.0",
    id: `host-${sequence}`,
    result: {
      payload: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: {},
      },
    },
  };
}

function fakeSteamToken(steamId) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: steamId, exp: 1893456000 }), "utf8").toString("base64url");
  return `${header}.${payload}.signature`;
}

function executeRuntime({ id, params }, extraEnv = {}, options = {}) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "executeAction",
    params: {
      pluginId: "community.steam_import_node",
      hostApis: [
        "imports.acceptLibraries",
        "imports.acceptCandidates",
        "accounts.acceptCandidates",
        "accounts.acceptStatus",
        "launch.acceptResolution",
        "launch.acceptRequest",
        "tools.requestReviewedCommand",
        "http.fetchAllowed",
      ],
      ...params,
    },
  });

  const result = spawnSync(process.execPath, [runtimeEntry], {
    cwd: path.dirname(runtimeEntry),
    input: `${[request, ...(options.hostResponses ?? []).map(JSON.stringify)].join("\n")}\n`,
    env: {
      ...process.env,
      ...extraEnv,
      STEAM_ROOT: fixtureSteamRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const stdout = result.stdout.toString("utf8").trim();
  assert.ok(stdout.startsWith("{"), `runtime stdout must start with JSON: ${stdout}`);
  assert.ok(stdout.endsWith("}"), `runtime stdout must end with JSON: ${stdout}`);
  const messages = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const hostCalls = messages.filter((message) => message.method === "host.call");
  if (options.expectedHostCalls !== undefined) {
    assert.equal(hostCalls.length, options.expectedHostCalls);
    if (options.expectedHostApis) {
      assert.deepEqual(hostCalls.map((message) => message.params.apiId), options.expectedHostApis);
    }
  }
  options.assertHostCalls?.(hostCalls);
  const response = messages.at(-1);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, id);
  if (options.expectResult !== false) {
    assert.ok(response.result, `runtime returned error: ${stdout}`);
  }
  return response;
}
