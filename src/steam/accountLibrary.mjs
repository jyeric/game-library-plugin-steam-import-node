import { clearTokenCache, getStoreAccessToken, isSteamLoginRequiredError } from "./accessToken.mjs";
import { clearSteamLoginState } from "./session.mjs";

export const PLUGIN_ID = "community.steam_import_node";
export const IMPORT_PROVIDER_ID = `${PLUGIN_ID}:import`;
export const ACCOUNT_PROVIDER_ID = `${PLUGIN_ID}:account`;
export const LAUNCH_PROVIDER_ID = `${PLUGIN_ID}:launch`;

const STEAM_API_BASE = "https://api.steampowered.com";
const REQUEST_TIMEOUT_MS = 30000;

export async function readSteamAccountGames(payload = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dataDir = options.dataDir;
  const language = steamLanguage(payload?.options?.parameters?.language ?? payload?.options?.language ?? payload?.language);
  const explicitSteamId = steamIdFromPayload(payload);
  const firstToken = await getStoreAccessToken({ dataDir, fetchImpl });
  try {
    const result = await readSteamAccountGamesWithToken(firstToken, {
      fetchImpl,
      language,
      steamId: explicitSteamId ?? firstToken.steamId,
    });
    clearSteamLoginState(dataDir);
    return result;
  } catch (error) {
    if (!isUnauthorizedSteamApiError(error)) {
      throw error;
    }
    clearTokenCache(dataDir);
    const refreshed = await getStoreAccessToken({ dataDir, fetchImpl, forceRefresh: true });
    const result = await readSteamAccountGamesWithToken(refreshed, {
      fetchImpl,
      language,
      steamId: explicitSteamId ?? refreshed.steamId,
    });
    clearSteamLoginState(dataDir);
    return result;
  }
}

async function readSteamAccountGamesWithToken(tokenInfo, options) {
  const owned = await fetchOwnedGames(tokenInfo.token, options);
  const warnings = [];
  let shared = [];
  try {
    const familyGroup = await fetchFamilyGroupForUser(tokenInfo.token, options);
    if (familyGroup?.familyGroupId) {
      shared = await fetchSharedLibraryApps(tokenInfo.token, familyGroup.familyGroupId, options);
    }
  } catch (error) {
    if (isSteamLoginRequiredError(error) || isUnauthorizedSteamApiError(error)) {
      throw error;
    }
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  return {
    candidates: mergedSteamGames(owned, shared).map(steamAccountGameToImportCandidate),
    warnings,
  };
}

async function fetchOwnedGames(accessToken, options) {
  const url = steamApiUrl("IPlayerService", "GetOwnedGames", "v1", accessToken, {
    steamid: options.steamId,
    include_appinfo: "1",
    include_played_free_games: "1",
    format: "json",
  });
  const root = await fetchSteamJson(url, "GetOwnedGames", options.fetchImpl);
  return ownedGamesFromResponse(root);
}

async function fetchFamilyGroupForUser(accessToken, options) {
  const url = steamApiUrl("IFamilyGroupsService", "GetFamilyGroupForUser", "v1", accessToken, {
    steamid: options.steamId,
    include_family_group_response: "1",
    format: "json",
  });
  const root = await fetchSteamJson(url, "GetFamilyGroupForUser", options.fetchImpl);
  return familyGroupFromResponse(root);
}

async function fetchSharedLibraryApps(accessToken, familyGroupId, options) {
  const url = steamApiUrl("IFamilyGroupsService", "GetSharedLibraryApps", "v1", accessToken, {
    family_groupid: familyGroupId,
    include_own: "0",
    include_excluded: "0",
    include_free: "1",
    include_non_games: "0",
    language: options.language,
    max_apps: "50000",
    steamid: options.steamId,
    format: "json",
  });
  const root = await fetchSteamJson(url, "GetSharedLibraryApps", options.fetchImpl);
  return sharedAppsFromResponse(root);
}

async function fetchSteamJson(url, label, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "GET",
    signal: timeoutSignal(),
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "game-library-steam-plugin/0.2",
    },
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new SteamApiHttpError(`${label} requires a valid Steam access token; HTTP ${response.status}.`, response.status);
  }
  if (!response.ok) {
    throw new SteamApiHttpError(`${label} failed with HTTP ${response.status || "unknown"}.`, response.status);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} response was not valid JSON: ${error.message}`);
  }
}

function steamApiUrl(service, method, version, accessToken, params) {
  const url = new URL(`${STEAM_API_BASE}/${service}/${method}/${version}/`);
  url.searchParams.set("access_token", accessToken);
  for (const [key, value] of Object.entries(params)) {
    const text = stringValue(value);
    if (text) {
      url.searchParams.set(key, text);
    }
  }
  return url.toString();
}

function ownedGamesFromResponse(root) {
  const games = root?.response?.games;
  if (!Array.isArray(games)) {
    return [];
  }
  return games
    .map((game) => ({
      appid: steamAppId(game?.appid),
      name: stringValue(game?.name),
      relation: "owned",
    }))
    .filter((game) => game.appid);
}

function familyGroupFromResponse(root) {
  const response = root?.response ?? root;
  if (!response || response.is_not_member_of_any_group === true) {
    return undefined;
  }
  const familyGroupId = stringValue(response.family_groupid) ?? stringValue(response.familyGroupId);
  if (!familyGroupId || familyGroupId === "0") {
    return undefined;
  }
  return { familyGroupId };
}

function sharedAppsFromResponse(root) {
  const apps = root?.response?.apps ?? root?.apps;
  if (!Array.isArray(apps)) {
    return [];
  }
  return apps
    .filter((app) => Number(app?.exclude_reason ?? 0) === 0)
    .filter((app) => app?.app_type === undefined || app?.app_type === null || Number(app.app_type) === 1)
    .map((app) => ({
      appid: steamAppId(app?.appid),
      name: stringValue(app?.name),
      ownerSteamIds: Array.isArray(app?.owner_steamids)
        ? app.owner_steamids.map(stringValue).filter(Boolean)
        : [],
      relation: "family-shared",
    }))
    .filter((game) => game.appid);
}

function mergedSteamGames(owned, shared) {
  const byAppId = new Map();
  for (const game of owned) {
    byAppId.set(game.appid, game);
  }
  for (const game of shared) {
    if (!byAppId.has(game.appid)) {
      byAppId.set(game.appid, game);
    }
  }
  return [...byAppId.values()].sort((left, right) => {
    const leftTitle = left.name ?? `Steam app ${left.appid}`;
    const rightTitle = right.name ?? `Steam app ${right.appid}`;
    return leftTitle.localeCompare(rightTitle, undefined, { sensitivity: "base" })
      || left.appid.localeCompare(right.appid);
  });
}

export function steamAccountGameToImportCandidate(game) {
  const appid = game.appid;
  const installUri = `steam://install/${appid}`;
  const title = game.name ?? `Steam app ${appid}`;
  const shared = game.relation === "family-shared";
  return {
    id: `steam-account-${appid}`,
    title,
    source: "steam",
    path: installUri,
    executable: installUri,
    description: shared
      ? "Steam family-shared library game detected through a logged-in Steam web session."
      : "Owned Steam account-library game detected through a logged-in Steam web session.",
    externalIds: {
      steam: appid,
    },
    externalIdProvenance: shared
      ? {
          steam: {
            source: "steam-family-shared-library",
            ownerSteamIds: game.ownerSteamIds ?? [],
          },
        }
      : {
          steam: {
            source: "steam-owned-library",
          },
        },
    action: "add",
    confidence: shared ? 82 : 86,
    networkManifest: {
      manifestLocation: `https://store.steampowered.com/app/${appid}/`,
      manifestVersion: "steam-account-v1",
      metadataIds: {
        steam: appid,
      },
      downloads: [],
      acquisitionPlans: [],
      launchOptions: [],
      saveProfileHints: [],
    },
  };
}

function steamIdFromPayload(payload) {
  return stringValue(payload?.steamId)
    ?? stringValue(payload?.steamid)
    ?? stringValue(payload?.accountId)
    ?? stringValue(payload?.options?.parameters?.steamId)
    ?? stringValue(payload?.options?.parameters?.steamid);
}

function steamLanguage(value) {
  const text = stringValue(value)?.toLowerCase();
  if (!text) {
    return "english";
  }
  if (text === "zh-cn" || text === "zh-hans" || text === "schinese") {
    return "schinese";
  }
  if (text === "zh-tw" || text === "zh-hant" || text === "tchinese") {
    return "tchinese";
  }
  if (text.startsWith("ja")) return "japanese";
  if (text.startsWith("ko")) return "koreana";
  if (text.startsWith("fr")) return "french";
  if (text.startsWith("de")) return "german";
  if (text.startsWith("es")) return "spanish";
  if (text.startsWith("it")) return "italian";
  if (text.startsWith("pt-br")) return "brazilian";
  if (text.startsWith("pt")) return "portuguese";
  if (text.startsWith("ru")) return "russian";
  return "english";
}

function steamAppId(value) {
  const text = stringValue(value);
  return text && /^\d+$/.test(text) ? text : undefined;
}

function timeoutSignal() {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }
  return undefined;
}

function isUnauthorizedSteamApiError(error) {
  return error instanceof SteamApiHttpError && (error.status === 401 || error.status === 403);
}

class SteamApiHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SteamApiHttpError";
    this.status = status;
  }
}

function stringValue(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}
