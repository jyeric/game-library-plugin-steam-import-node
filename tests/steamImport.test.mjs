import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleAction, IMPORT_PROVIDER_ID, LAUNCH_PROVIDER_ID } from "../src/jsonrpc/handleAction.mjs";
import { parseAppManifest } from "../src/steam/parseAppManifest.mjs";
import { parseLibraryFolders } from "../src/steam/parseLibraryFolders.mjs";
import { scanInstalledGames, steamGameToImportCandidate } from "../src/steam/scanInstalledGames.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureSteamRoot = path.join(__dirname, "fixtures", "Steam");

describe("Steam VDF parsing", () => {
  it("parses modern libraryfolders.vdf entries", () => {
    const libraries = parseLibraryFolders(`
      "libraryfolders"
      {
        "0"
        {
          "path" "D:\\\\SteamLibrary"
          "apps"
          {
            "730" "123"
            "1999520" "456"
          }
        }
      }
    `);

    assert.equal(libraries.length, 1);
    assert.equal(libraries[0].path, path.normalize("D:\\SteamLibrary"));
    assert.deepEqual(libraries[0].appIds, ["730", "1999520"]);
  });

  it("parses appmanifest.acf metadata", () => {
    const app = parseAppManifest(`
      "AppState"
      {
        "appid" "730"
        "name" "Counter-Strike 2"
        "installdir" "Counter-Strike"
      }
    `);

    assert.deepEqual(app, {
      appid: "730",
      name: "Counter-Strike 2",
      installDir: "Counter-Strike",
      stateFlags: "",
    });
  });
});

describe("Steam installed game scan", () => {
  it("scans manifests from a detected STEAM_ROOT", () => {
    const { games, errors } = scanInstalledGames({
      env: { STEAM_ROOT: fixtureSteamRoot },
      platform: process.platform,
    });

    assert.deepEqual(errors, []);
    assert.equal(games.length, 2);
    const counterStrike = games.find((game) => game.appid === "730");
    const winterMemories = games.find((game) => game.appid === "2403320");
    assert.equal(counterStrike.name, "Counter-Strike 2");
    assert.equal(counterStrike.launchUrl, "steam://rungameid/730");
    assert.equal(counterStrike.installPath, path.join(fixtureSteamRoot, "steamapps", "common", "Counter-Strike"));
    assert.equal(winterMemories.name, "冬日树下的回忆");
  });

  it("maps scanned games into import candidates", () => {
    const { games } = scanInstalledGames({
      env: { STEAM_ROOT: fixtureSteamRoot },
      platform: process.platform,
    });
    const candidate = steamGameToImportCandidate(games.find((game) => game.appid === "730"));

    assert.equal(candidate.id, "steam-730");
    assert.equal(candidate.title, "Counter-Strike 2");
    assert.equal(candidate.source, "steam");
    assert.equal(candidate.externalIds.steam, "730");
    assert.equal(candidate.executable, "steam://rungameid/730");
    assert.equal(candidate.confidence, 100);
  });
});

describe("JSON-RPC action handling", () => {
  it("returns detected libraries for imports.acceptLibraries", async () => {
    const previousRoot = process.env.STEAM_ROOT;
    process.env.STEAM_ROOT = fixtureSteamRoot;
    try {
      const result = await handleAction("request-1", { actionId: "detect-libraries", payload: {} });
      assert.equal(result.result.hostApi, "imports.acceptLibraries");
      assert.equal(result.result.payload.providerId, IMPORT_PROVIDER_ID);
      assert.equal(result.result.payload.libraries.length, 1);
      assert.equal(result.result.payload.libraries[0].manifestCount, 2);
    } finally {
      restoreEnv("STEAM_ROOT", previousRoot);
    }
  });

  it("returns candidates for imports.acceptCandidates", async () => {
    const result = await handleAction("request-2", {
      actionId: "read-candidates",
      payload: { libraries: [{ path: fixtureSteamRoot }] },
    });

    assert.equal(result.result.hostApi, "imports.acceptCandidates");
    assert.equal(result.result.payload.providerId, IMPORT_PROVIDER_ID);
    assert.equal(result.result.payload.candidates.length, 2);
    assert.equal(result.result.payload.candidates.find((candidate) => candidate.externalIds.steam === "730").title, "Counter-Strike 2");
    assert.equal(result.result.payload.candidates.find((candidate) => candidate.externalIds.steam === "2403320").title, "冬日树下的回忆");
  });

  it("resolves and requests Steam URL launches", async () => {
    const payload = {
      game: {
        id: "game-1",
        title: "Counter-Strike 2",
        externalIds: { steam: "730" },
      },
      option: {
        providerId: LAUNCH_PROVIDER_ID,
      },
    };

    const resolution = await handleAction("request-3", { actionId: "resolve-launch", payload });
    assert.equal(resolution.result.hostApi, "launch.acceptResolution");
    assert.equal(resolution.result.payload.providerId, LAUNCH_PROVIDER_ID);
    assert.equal(resolution.result.payload.canHandle, true);

    const launch = await handleAction("request-4", { actionId: "request-launch", payload });
    assert.equal(launch.result.hostApi, "launch.acceptRequest");
    assert.equal(launch.result.payload.providerId, LAUNCH_PROVIDER_ID);
    assert.equal(launch.result.payload.url, "steam://rungameid/730");
  });
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
