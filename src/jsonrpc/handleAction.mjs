import { response, errorResponse } from "./responses.mjs";
import {
  detectSteamLibraries,
  scanInstalledGames,
  steamGameToImportCandidate,
  steamLaunchUrl,
} from "../steam/scanInstalledGames.mjs";

export const IMPORT_PROVIDER_ID = "community.steam_import_node:import";
export const LAUNCH_PROVIDER_ID = "community.steam_import_node:launch";

export function handleAction(id, params) {
  try {
    switch (params?.actionId) {
      case "detect-libraries":
        return detectLibraries(id);
      case "read-candidates":
        return readCandidates(id, params?.payload);
      case "resolve-launch":
        return resolveLaunch(id, params?.payload);
      case "request-launch":
        return requestLaunch(id, params?.payload);
      default:
        return errorResponse(id, `unsupported action: ${params?.actionId ?? "unknown"}`);
    }
  } catch (error) {
    return errorResponse(id, error instanceof Error ? error.message : String(error));
  }
}

function detectLibraries(id) {
  const { detected, libraries } = detectSteamLibraries();
  return response(id, "imports.acceptLibraries", {
    providerId: IMPORT_PROVIDER_ID,
    libraries: libraries.map((library) => ({
      path: library.path,
      manifestCount: library.manifestCount,
    })),
    warning: detected.root ? undefined : detected.reason,
  });
}

function readCandidates(id, payload) {
  const { games, errors } = scanInstalledGames({ libraries: payload?.libraries });
  return response(id, "imports.acceptCandidates", {
    providerId: IMPORT_PROVIDER_ID,
    candidates: games.map(steamGameToImportCandidate),
    warnings: errors,
  });
}

function resolveLaunch(id, payload) {
  return response(id, "launch.acceptResolution", {
    providerId: LAUNCH_PROVIDER_ID,
    canHandle: Boolean(extractSteamAppId(payload)),
  });
}

function requestLaunch(id, payload) {
  const appid = extractSteamAppId(payload);
  if (!appid) {
    return errorResponse(id, "Steam appid was not found on the game or launch option.");
  }
  return response(id, "launch.acceptRequest", {
    providerId: LAUNCH_PROVIDER_ID,
    url: steamLaunchUrl(appid),
  });
}

function extractSteamAppId(payload) {
  const option = payload?.option;
  const game = payload?.game;
  const fromExternalIds = game?.externalIds?.steam ?? game?.external_ids?.steam;
  if (isSteamAppId(fromExternalIds)) {
    return String(fromExternalIds);
  }

  for (const value of [option?.url, option?.executable, option?.path, game?.executable]) {
    const fromUrl = extractSteamAppIdFromUrl(value);
    if (fromUrl) {
      return fromUrl;
    }
  }

  return null;
}

function extractSteamAppIdFromUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^steam:\/\/rungameid\/(\d+)$/i);
  return match?.[1] ?? null;
}

function isSteamAppId(value) {
  return typeof value === "string" || typeof value === "number"
    ? /^\d+$/.test(String(value))
    : false;
}

