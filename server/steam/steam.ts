import type { SteamMovie } from './types'

const STEAM_APP_URL = /^https?:\/\/store\.steampowered\.com\/app\/(\d+)/

/**
 * Extracts the Steam app id from a store page URL, e.g.
 * "https://store.steampowered.com/app/3764200/Resident_Evil_Requiem/" -> "3764200".
 * Returns null for anything that isn't a Steam app URL.
 */
export function steamAppIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const match = STEAM_APP_URL.exec(url)
  return match?.[1] ?? null
}

const STEAM_APP_ID = /^\d+$/

/**
 * The store page of a Steam app, e.g. "292030" -> "https://store.steampowered.com/app/292030/":
 * `steamAppIdFromUrl` the other way round, for a page that knows the app and has no store link to
 * read it from. Returns null for anything that is not a bare run of digits — the value ends up
 * in an `href`, and an app id is the only thing this may put there.
 */
export function steamStoreUrl(appId: string | null | undefined): string | null {
  return appId && STEAM_APP_ID.test(appId) ? `https://store.steampowered.com/app/${appId}/` : null
}

/**
 * Picks a trailer from Steam's `movies` list: the first one marked `highlight`, else the first
 * one, else null when the list is empty.
 */
export function pickTrailer(movies: readonly SteamMovie[] | null | undefined): string | null {
  if (!movies || movies.length === 0) return null
  const highlighted = movies.find((movie) => movie.highlight)
  return (highlighted ?? movies[0])?.hls_h264 ?? null
}
