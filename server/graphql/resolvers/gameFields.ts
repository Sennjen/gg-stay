import { resolveLocalizedDescription } from '../../steam/description'
import { steamAppIdFromUrl } from '../../steam/steam'
import type { SteamAppDetailsResponse } from '../../steam/types'
import type { GameResolvers } from '../__generated__/resolvers-types'

// Same 24h TTL as the landing resolver's Steam trailer lookup: the response is shared (one cache
// entry per app id, see server/steam/steamFetch.ts), so both features age out together.
const STEAM_TTL = 86_400

/**
 * Resolves the localized description for a `Game`. This is a field resolver (not part of the
 * `game` query resolver) specifically so the Steam call only happens when the field is actually
 * selected: the English page and the catalog never touch Steam.
 */
export const localizedDescription: GameResolvers['localizedDescription'] = async (
  parent,
  { locale },
  context,
) => {
  const rawgDescription = parent.description ?? null

  if (locale !== 'uk') return resolveLocalizedDescription(locale, rawgDescription, null)

  const steamLink = (parent.stores ?? []).find((offer) => offer.store === 'steam')
  const appId = steamAppIdFromUrl(steamLink?.url)
  if (!appId) return resolveLocalizedDescription(locale, rawgDescription, null)

  try {
    const response = (await context.steam(appId, { ttl: STEAM_TTL })) as SteamAppDetailsResponse
    const details = response[appId]
    const data = details?.success ? (details.data ?? null) : null
    return resolveLocalizedDescription(locale, rawgDescription, data)
  } catch {
    // A missing Steam page, a failed request, or a rate limit must never fail the `game` query —
    // this field simply falls back to the RAWG text, same as "no Steam link".
    return resolveLocalizedDescription(locale, rawgDescription, null)
  }
}
