import { toGameCard } from '../../index/toGraphql'
import type { GraphQLContext } from '../context'
import {
  cachedIndexPage,
  indexEntry,
  indexFailed,
  indexState,
  toIndexQuery,
  warnIndexOnce,
  withoutPrices,
} from '../indexPath'
import type {
  Game,
  GameCard,
  GameResolvers,
  PlatformFamily,
} from '../__generated__/resolvers-types'

/**
 * `Game.similar`: the games the refresh job ranked as most like this one, or, when it ranked none
 * for it, games from the index that share at least one genre with it.
 *
 * The ranked list lives on the game's own index document (`similar`, computed over the whole index
 * by `scripts/index/similarity.ts`), and the game page has already read that document, so the row
 * costs one `getMany` for the listed ids. The list's order is kept; an id the version no longer
 * holds — a read that straddled a publication — is skipped.
 *
 * Without a list — a document published before the job computed them, or a game outside the
 * index — one index query takes the game's genres as an OR-ed facet, most popular first, and asks
 * for `SIMILAR_CANDIDATES` games; the game itself is dropped and games on a platform family the
 * page's game is also on move ahead of the rest, each group keeping its popularity order. One
 * query plus an in-process pass costs one round trip, where asking the index for the
 * platform-sharing games first and topping up with a second query would cost two for a preference
 * that only reorders a list this short.
 *
 * Hidden — an empty list — when fewer than `SIMILAR_MIN_GAMES` qualify, when the fallback has no
 * genre to ask by, or when the index is unpublished, unavailable or failed earlier in the request.
 * Stale prices do not hide the row: it reads no price, so the cards are served without theirs,
 * like the made-in-Ukraine and Ukrainian shelves. Being a field resolver, it costs nothing when a
 * query does not select it, and it can never fail the game page.
 */

export const SIMILAR_SIZE = 8
export const SIMILAR_MIN_GAMES = 4
/** Enough headroom over `SIMILAR_SIZE` for the platform preference to have something to reorder. */
export const SIMILAR_CANDIDATES = 24

export const similar: GameResolvers<GraphQLContext>['similar'] = async (parent, _args, context) => {
  const state = await indexState(context)
  if (state.meta === null || indexFailed(context)) return []

  const id = Number(parent.id)
  const entry = Number.isFinite(id) ? await indexEntry(context, id) : null
  if (indexFailed(context)) return []

  const cards = entry?.similar
    ? await storedSimilar(context, id, entry.similar)
    : await sameGenre(context, parent, state.version)
  if (cards === null || cards.length < SIMILAR_MIN_GAMES) return []
  return state.stale ? withoutPrices(cards) : cards
}

/** The stored list as cards, in its order, without the ids the version does not hold. */
async function storedSimilar(
  context: GraphQLContext,
  gameId: number,
  ids: readonly number[],
): Promise<GameCard[] | null> {
  const wanted = ids.filter((id) => id !== gameId).slice(0, SIMILAR_SIZE)
  if (wanted.length === 0) return []
  try {
    const documents = await context.index.getMany(wanted)
    return wanted.flatMap((id) => {
      const document = documents.get(id)
      return document ? [toGameCard(document)] : []
    })
  } catch (error) {
    warnIndexOnce(context, 'similar games could not be read', error)
    return null
  }
}

/** The fallback: the most popular games sharing a genre, platform-sharing ones first. */
async function sameGenre(
  context: GraphQLContext,
  parent: Pick<Game, 'id' | 'genres' | 'platformFamilies'>,
  version: number | null,
): Promise<GameCard[] | null> {
  const genres = parent.genres.map((genre) => genre.slug)
  if (genres.length === 0) return []

  const query = toIndexQuery({
    filter: { genres },
    sort: 'POPULARITY_DESC',
    page: 1,
    pageSize: SIMILAR_CANDIDATES,
    today: context.today,
  })
  try {
    const candidates = (await cachedIndexPage(context, query, version)).items
    return rankSimilar(parent.id, parent.platformFamilies, candidates)
  } catch (error) {
    warnIndexOnce(context, 'similar games could not be read', error)
    return null
  }
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
