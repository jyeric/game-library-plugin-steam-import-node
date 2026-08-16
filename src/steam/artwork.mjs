const STEAM_BANNER_HOST = "https://shared.fastly.steamstatic.com";

/**
 * Returns the Steam library hero URL used as the provider banner preview.
 *
 * The client keeps the provider id and external id separately so it can
 * refresh the URL later, while cachedPath makes the imported candidate
 * immediately renderable in the review and library views.
 */
export function steamBannerArtwork(appid) {
  const externalId = String(appid ?? "").trim();
  if (!/^\d+$/.test(externalId)) {
    return undefined;
  }

  const bannerUrl = steamBannerUrl(externalId);
  return {
    bannerUrl,
    artwork: {
      banner: {
        source: "provider",
        providerId: "steam",
        externalId,
        cachedPath: bannerUrl,
        locked: false,
      },
    },
  };
}

/**
 * Builds the stable Steam library hero URL for one numeric app id.
 */
export function steamBannerUrl(appid) {
  const externalId = String(appid ?? "").trim();
  return `${STEAM_BANNER_HOST}/store_item_assets/steam/apps/${externalId}/library_hero_2x.jpg`;
}
