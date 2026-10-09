import { resolveLocalizedDescription } from '../../steam/description'
import { steamAppIdFromUrl } from '../../steam/steam'
import type { SteamAppDetailsResponse } from '../../steam/types'
import { leaveRunning, outlasts } from '../budget'
import type { GameResolvers } from '../__generated__/resolvers-types'

// Same 24h TTL as the landing resolver's Steam trailer lookup: the response is shared (one cache
// entry per app id, see server/steam/steamFetch.ts), so both features age out together.
const STEAM_TTL = 86_400

/**
 * How long the Ukrainian description waits for Steam before the page goes out with RAWG's text.
 *
 * Steam's store is asked for a whole app here, through a transport that gives a request five
 * seconds and one retry and sends one request every second and a half. Left unbounded, that is
 * ten seconds and more that a game page can spend on a paragraph it already has in English. Past
 * the budget the page is better served now than complete later: the request is not cancelled, so
 * its answer is on its way into the cache either way.
 */
export const STEAM_DESCRIPTION_BUDGET_MS = 1_500

/**
 * Resolves the localized description for a `Game`. This is a field resolver (not part of the
 * `game` query resolver) specifically so the Steam call only happens when the field is actually
 * selected: the English page and the catalog never touch Steam.
 *
 * The Steam call is given `STEAM_DESCRIPTION_BUDGET_MS`. An answer inside it is used as before,
 * and so is a failure inside it; once it is spent the field falls back to the RAWG text, exactly
 * as it does for a game with no Steam page, and the request is left running — its response is
 * cached for a day, so the next reader of this page gets the Ukrainian text at once. A
 * description that fell back is not a partial answer: the page has a description, in English.
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
    const fetching = context.steam(appId, { ttl: STEAM_TTL })
    if (await outlasts(fetching, STEAM_DESCRIPTION_BUDGET_MS)) {
      leaveRunning(context, fetching)
      return resolveLocalizedDescription(locale, rawgDescription, null)
    }
    const response = (await fetching) as SteamAppDetailsResponse
    const details = response[appId]
    const data = details?.success ? (details.data ?? null) : null
    return resolveLocalizedDescription(locale, rawgDescription, data)
  } catch {
    // A missing Steam page, a failed request, or a rate limit must never fail the `game` query —
    // this field simply falls back to the RAWG text, same as "no Steam link".
    return resolveLocalizedDescription(locale, rawgDescription, null)
  }
}
