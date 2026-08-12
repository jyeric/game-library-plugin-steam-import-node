import { response, errorResponse } from "./responses.mjs";
import {
  detectSteamLibraries,
  scanInstalledGames,
  steamGameToImportCandidate,
  steamLaunchUrl,
} from "../steam/scanInstalledGames.mjs";
import {
  ACCOUNT_PROVIDER_ID,
  IMPORT_PROVIDER_ID,
  LAUNCH_PROVIDER_ID,
  readSteamAccountGames,
} from "../steam/accountLibrary.mjs";
import { isSteamLoginRequiredError } from "../steam/accessToken.mjs";
import {
  markSteamLoginRequired,
  markSteamLoginPending,
  steamSessionStatus,
} from "../steam/session.mjs";

const LOGIN_REQUIRED_MESSAGE =
  "Steam browser login is required. Confirm the Steam browser login command, complete login, then retry.";
const LOGIN_PENDING_MESSAGE = "Steam browser login opened. Complete login to continue the account import.";

export async function handleAction(id, params, context = {}) {
  try {
    switch (params?.actionId) {
      case "login":
        return await login(id, params?.payload ?? {});
      case "account-status":
        return accountStatus(id);
      case "detect-libraries":
        return await detectLibraries(id);
      case "read-candidates":
        return await readCandidates(id, params?.payload);
      case "read-account-candidates":
        return await readAccountCandidates(id, params?.payload ?? {}, context);
      case "resolve-launch":
        return await resolveLaunch(id, params?.payload);
      case "request-launch":
        return await requestLaunch(id, params?.payload);
      default:
        return errorResponse(id, `unsupported action: ${params?.actionId ?? "unknown"}`);
    }
  } catch (error) {
    if (isSteamLoginRequiredError(error)) {
      markSteamLoginRequired();
      return loginRequiredError(id, error);
    }
    return errorResponse(id, errorMessage(error));
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

async function readAccountCandidates(id, payload, context) {
  try {
    const { candidates, warnings } = await readSteamAccountGames(payload, {
      fetchImpl: context.fetchImpl,
    });
    return response(id, "accounts.acceptCandidates", {
      providerId: ACCOUNT_PROVIDER_ID,
      candidates,
      warnings,
    });
  } catch (error) {
    if (isSteamLoginRequiredError(error)) {
      markSteamLoginRequired();
      return loginRequiredError(id, error);
    }
    throw error;
  }
}

function login(id, payload) {
  if (hostResult(payload, "tools.requestReviewedCommand")) {
    return response(id, "accounts.acceptStatus", {
      providerId: ACCOUNT_PROVIDER_ID,
      loggedIn: false,
      pending: true,
      message: LOGIN_PENDING_MESSAGE,
    });
  }
  markSteamLoginPending();
  return requestAuthCommand(id, ACCOUNT_PROVIDER_ID);
}

function accountStatus(id) {
  return response(id, "accounts.acceptStatus", {
    providerId: ACCOUNT_PROVIDER_ID,
    ...steamSessionStatus(),
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

function requestAuthCommand(id, providerId) {
  return response(id, "tools.requestReviewedCommand", {
    toolId: "steam-auth",
    commandId: "auth",
    providerId,
    variables: {},
    message: LOGIN_REQUIRED_MESSAGE,
  });
}

function loginRequiredError(id, error) {
  const message = error instanceof Error && error.message
    ? error.message
    : "Steam browser login has expired.";
  return errorResponse(id, message, {
    messageKey: "error.providerLoginRequired",
    messageParams: {
      providerId: ACCOUNT_PROVIDER_ID,
    },
  });
}

function hostResult(payload, hostApi) {
  const result = payload?.runtimeHostResult;
  if (!result) {
    return undefined;
  }
  if (hostApi && result.hostApi !== hostApi) {
    return undefined;
  }
  return result.payload;
}

function errorMessage(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = typeof cause.code === "string" ? cause.code : undefined;
    const message = typeof cause.message === "string" ? cause.message : undefined;
    if (code && message) {
      return `${error.message}: ${code} ${message}`;
    }
    if (message) {
      return `${error.message}: ${message}`;
    }
  }
  return error.message;
}

export { ACCOUNT_PROVIDER_ID, IMPORT_PROVIDER_ID, LAUNCH_PROVIDER_ID };
