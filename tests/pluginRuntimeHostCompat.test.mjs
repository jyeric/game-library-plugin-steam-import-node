import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(pluginRoot, "runtime");
const fixtureSteamRoot = path.join(__dirname, "fixtures", "Steam");
const runtimeEntry = path.join(runtimeRoot, "provider.ps1");

describe("PowerShell JSON-RPC runtime host compatibility", { skip: process.platform !== "win32" }, () => {
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
    assert.equal(
      response.result.payload.candidates.find((candidate) => candidate.externalIds.steam === "2403320").title,
      "冬日树下的回忆",
    );
  });

  it("returns parseable JSON for read-candidates with a Windows long path prefix", () => {
    const longPath = `\\\\?\\${fixtureSteamRoot}`;
    const response = executeRuntime({
      id: "read-candidates-long-path",
      params: {
        actionId: "read-candidates",
        payload: { libraries: [{ path: longPath }] },
      },
    });

    assert.equal(response.result.hostApi, "imports.acceptCandidates");
    assert.equal(response.result.payload.candidates.length, 2);
    assert.match(
      response.result.payload.candidates.find((candidate) => candidate.externalIds.steam === "2403320").path,
      /^\\\\\?\\/,
    );
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
});

function executeRuntime({ id, params }) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "executeAction",
    params: {
      pluginId: "community.steam_import_node",
      hostApis: [
        "imports.acceptLibraries",
        "imports.acceptCandidates",
        "launch.acceptResolution",
        "launch.acceptRequest",
      ],
      ...params,
    },
  });

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runtimeEntry],
    {
      cwd: runtimeRoot,
      input: `${request}\n`,
      env: {
        ...process.env,
        STEAM_ROOT: fixtureSteamRoot,
        GAME_LIBRARY_NODE: process.execPath,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  const stdout = result.stdout.toString("utf8").trim();
  assert.ok(stdout.startsWith("{"), `runtime stdout must start with JSON: ${stdout}`);
  assert.ok(stdout.endsWith("}"), `runtime stdout must end with JSON: ${stdout}`);
  const response = JSON.parse(stdout);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, id);
  assert.ok(response.result, `runtime returned error: ${stdout}`);
  return response;
}
