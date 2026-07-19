import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    assert.ok(response.result.payload.candidates.some((candidate) => candidate.externalIds.steam === "2403320"));
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

  it("returns the live client request id when async account import fails", () => {
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
      const preload = path.join(tempRoot, "fail-fetch.mjs");
      writeFileSync(
        preload,
        "globalThis.fetch = async () => { throw new Error('simulated fetch failed'); };\n",
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
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        { expectResult: false },
      );

      assert.equal(response.id, "community.steam_import_node:read-account-candidates:host-id");
      assert.equal(response.error.message, "simulated fetch failed");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

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
        "launch.acceptResolution",
        "launch.acceptRequest",
        "tools.requestReviewedCommand",
      ],
      ...params,
    },
  });

  const result = spawnSync(process.execPath, [runtimeEntry], {
    cwd: path.dirname(runtimeEntry),
    input: `${request}\n`,
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
  const response = JSON.parse(stdout);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, id);
  if (options.expectResult !== false) {
    assert.ok(response.result, `runtime returned error: ${stdout}`);
  }
  return response;
}
