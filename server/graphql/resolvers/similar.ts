import type { GraphQLContext } from '../context'
import {
  cachedIndexPage,
  indexFailed,
  indexState,
  toIndexQuery,
  warnIndexOnce,
  withoutPrices,
} from '../indexPath'
import type { GameCard, GameResolvers, PlatformFamily } from '../__generated__/resolvers-types'

/**
 * `Game.similar`: games from the index that share at least one genre with the page's game.
 *
 * One index query — the game's genres as an OR-ed facet, most popular first — asks for
 * `SIMILAR_CANDIDATES` games, and the ranking happens here: the game itself is dropped, and the
 * games on a platform family the page's game is also on move ahead of the rest, each group keeping
 * its popularity order. One query plus an in-process pass costs one round trip, where asking the
 * index for the platform-sharing games first and topping up with a second query would cost two
 * for a preference that only reorders a list this short.
 *
 * Hidden — an empty list — when fewer than `SIMILAR_MIN_GAMES` qualify, when the game has no
 * genre, or when the index is unpublished, unavailable or failed earlier in the request. Stale
 * prices do not hide the row: it reads no price, so the cards are served without theirs, like the
 * made-in-Ukraine and Ukrainian shelves. Being a field resolver, it costs nothing when a query
 * does not select it, and it can never fail the game page.
 */

export const SIMILAR_SIZE = 8
export const SIMILAR_MIN_GAMES = 4
/** Enough headroom over `SIMILAR_SIZE` for the platform preference to have something to reorder. */
export const SIMILAR_CANDIDATES = 24

export const similar: GameResolvers<GraphQLContext>['similar'] = async (parent, _args, context) => {
  const genres = parent.genres.map((genre) => genre.slug)
  if (genres.length === 0) return []

  const state = await indexState(context)
  if (state.meta === null || indexFailed(context)) return []

  const query = toIndexQuery({
    filter: { genres },
    sort: 'POPULARITY_DESC',
    page: 1,
    pageSize: SIMILAR_CANDIDATES,
    today: context.today,
  })
  let candidates: GameCard[]
  try {
    candidates = (await cachedIndexPage(context, query, state.version)).items
  } catch (error) {
    warnIndexOnce(context, 'similar games could not be read', error)
    return []
  }

  const ranked = rankSimilar(parent.id, parent.platformFamilies, candidates)
  if (ranked.length < SIMILAR_MIN_GAMES) return []
  return state.stale ? withoutPrices(ranked) : ranked
}

/** The candidates without the game itself, platform-sharing ones first, cut to `SIMILAR_SIZE`. */
export function rankSimilar(
  gameId: string,
  families: readonly PlatformFamily[],
  candidates: readonly GameCard[],
): GameCard[] {
  // `OTHER` is not a family anyone plays on together, so it never counts as shared.
  const own = new Set<PlatformFamily>(families.filter((family) => family !== 'OTHER'))
  const others = candidates.filter((card) => card.id !== gameId)
  const shares = (card: GameCard) => card.platformFamilies.some((family) => own.has(family))
  return [...others.filter(shares), ...others.filter((card) => !shares(card))].slice(
    0,
    SIMILAR_SIZE,
  )
}
