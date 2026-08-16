import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { detectSteamRoot } from "./detectSteamRoot.mjs";
import { countAppManifests, readLibraryFolders } from "./parseLibraryFolders.mjs";
import { readAppManifest } from "./parseAppManifest.mjs";
import { steamBannerArtwork } from "./artwork.mjs";

export function detectSteamLibraries(options = {}) {
  const detected = detectSteamRoot(options);
  if (!detected.root) {
    return { detected, libraries: [] };
  }

  const libraries = readLibraryFolders(detected.root).map((library) => ({
    ...library,
    manifestCount: countAppManifests(library.path),
  }));
  return { detected, libraries };
}

export function scanInstalledGames(options = {}) {
  const libraries = options.libraries?.length
    ? normalizePayloadLibraries(options.libraries)
    : detectSteamLibraries(options).libraries;

  const games = [];
  const errors = [];

  for (const library of libraries) {
    const steamAppsPath = path.join(library.path, "steamapps");
    if (!existsSync(steamAppsPath)) {
      continue;
    }
    const manifestFiles = readdirSync(steamAppsPath).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
    for (const manifestFile of manifestFiles) {
      const manifestPath = path.join(steamAppsPath, manifestFile);
      try {
        const app = readAppManifest(manifestPath);
        games.push({
          ...app,
          libraryPath: library.path,
          manifestPath,
          installPath: path.join(library.path, "steamapps", "common", app.installDir),
          launchUrl: steamLaunchUrl(app.appid),
        });
      } catch (error) {
        errors.push({
          manifestPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  games.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  return { games, errors };
}

export function steamGameToImportCandidate(game) {
  const artwork = steamBannerArtwork(game.appid);
  return {
    id: `steam-${game.appid}`,
    title: game.name,
    source: "steam",
    path: game.installPath,
    installDir: game.installPath,
    executable: game.launchUrl,
    externalIds: {
      steam: game.appid,
    },
    ...artwork,
    action: "add",
    confidence: 100,
  };
}

export function steamLaunchUrl(appid) {
  return `steam://rungameid/${appid}`;
}

function normalizePayloadLibraries(libraries) {
  return libraries
    .map((library) => {
      if (typeof library === "string") {
        return { path: library };
      }
      if (library && typeof library.path === "string") {
        return { path: library.path };
      }
      return null;
    })
    .filter(Boolean)
    .map((library) => ({ path: path.normalize(library.path) }));
}
