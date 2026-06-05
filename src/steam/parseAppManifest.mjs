import { readFileSync } from "node:fs";
import { findCaseInsensitive, parseKeyValues } from "./keyValues.mjs";

export function parseAppManifest(text) {
  const root = parseKeyValues(text);
  const appState = findCaseInsensitive(root, "AppState");
  if (!appState || typeof appState !== "object") {
    throw new Error("Steam app manifest does not contain AppState.");
  }

  const appid = String(appState.appid ?? "").trim();
  const name = String(appState.name ?? "").trim();
  const installDir = String(appState.installdir ?? "").trim();
  if (!/^\d+$/.test(appid)) {
    throw new Error("Steam app manifest is missing a numeric appid.");
  }
  if (!name) {
    throw new Error(`Steam app ${appid} is missing a name.`);
  }
  if (!installDir) {
    throw new Error(`Steam app ${appid} is missing installdir.`);
  }

  return {
    appid,
    name,
    installDir,
    stateFlags: String(appState.StateFlags ?? appState.stateflags ?? "").trim(),
  };
}

export function readAppManifest(filePath) {
  return parseAppManifest(readFileSync(filePath, "utf8"));
}

