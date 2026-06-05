import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { findCaseInsensitive, parseKeyValues } from "./keyValues.mjs";

export function parseLibraryFolders(text) {
  const root = parseKeyValues(text);
  const libraryFolders = findCaseInsensitive(root, "libraryfolders");
  if (!libraryFolders || typeof libraryFolders !== "object") {
    return [];
  }

  const libraries = [];
  for (const [key, value] of Object.entries(libraryFolders)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      libraries.push({ path: value.trim(), appIds: [] });
      continue;
    }
    if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) {
      libraries.push({
        path: value.path.trim(),
        appIds: Object.keys(value.apps ?? {}).filter((item) => /^\d+$/.test(item)),
      });
    }
  }

  return dedupeLibraries(libraries);
}

export function readLibraryFolders(steamRoot) {
  const rootLibrary = { path: steamRoot, appIds: [] };
  const libraryFoldersPath = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!existsSync(libraryFoldersPath)) {
    return [rootLibrary];
  }

  const parsed = parseLibraryFolders(readFileSync(libraryFoldersPath, "utf8"));
  return dedupeLibraries([rootLibrary, ...parsed]);
}

export function countAppManifests(libraryPath) {
  const steamAppsPath = path.join(libraryPath, "steamapps");
  if (!existsSync(steamAppsPath)) {
    return 0;
  }
  return readdirSync(steamAppsPath).filter((name) => /^appmanifest_\d+\.acf$/i.test(name)).length;
}

function dedupeLibraries(libraries) {
  const seen = new Set();
  const result = [];
  for (const library of libraries) {
    const normalized = path.normalize(library.path);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...library, path: normalized });
    }
  }
  return result;
}

