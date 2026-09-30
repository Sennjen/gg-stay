import type { GraphQLContext } from '../context'
import { cachedIndexPage, indexFailed, indexState, toIndexQuery, warnIndexOnce } from '../indexPath'
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
 * genre, when the index is unpublished, unavailable or failed earlier in the request, and when its
 * prices are stale (the design hides the row then). Being a field resolver, it costs nothing when
 * a query does not select it, and it can never fail the game page.
 */

export const SIMILAR_SIZE = 8
export const SIMILAR_MIN_GAMES = 4
/** Enough headroom over `SIMILAR_SIZE` for the platform preference to have something to reorder. */
export const SIMILAR_CANDIDATES = 24

export const similar: GameResolvers<GraphQLContext>['similar'] = async (parent, _args, context) => {
  const genres = parent.genres.map((genre) => genre.slug)
  if (genres.length === 0) return []

  const state = await indexState(context)
  if (state.meta === null || state.stale || indexFailed(context)) return []

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
  return ranked.length < SIMILAR_MIN_GAMES ? [] : ranked
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
