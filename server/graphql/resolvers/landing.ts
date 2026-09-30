import {
  SHELF_MIN_GAMES,
  SHELF_SIZE,
  SHELVES,
  type ShelfDefinition,
  type ShelfIdValue,
} from '../../../shared/shelves'
import { safeExternalUrl } from '../../../shared/url'
import { filterToParams } from '../../rawg/filterToParams'
import { mapGameCard } from '../../rawg/mappers'
import { dateRange, pickFeatured } from '../../rawg/landing'
import { rawgListOrThrow } from '../../rawg/rawgFetch'
import type { RawgGameListItem, RawgList, RawgMovie, RawgStoreLink } from '../../rawg/types'
import { pickTrailer, steamAppIdFromUrl } from '../../steam/steam'
import type { SteamAppDetailsResponse } from '../../steam/types'
import { withUpstreamErrors } from '../errors'
import {
  attachIndexData,
  cachedIndexPage,
  indexFailed,
  indexState,
  toIndexQuery,
  warnIndexOnce,
  withoutPrices,
  type IndexState,
} from '../indexPath'
import type { GraphQLContext } from '../context'
import type { GameCard, QueryResolvers, Shelf } from '../__generated__/resolvers-types'

// The landing page is cached server-side for 24h (see docs/specs/2026-09-19-redesign-design.md,
// "Server additions"): a page view should not reach RAWG on every request.
const LANDING_TTL = 86_400
const CAROUSEL_SIZE = 40
const CAROUSEL_LIMIT = 24
// The featured game is picked from the last year's most added games.
const FEATURED_WINDOW_DAYS = 365

async function fetchGamesList(
  context: GraphQLContext,
  params: Record<string, string | number | undefined>,
): Promise<RawgList<RawgGameListItem>> {
  return rawgListOrThrow(await context.rawg('games', params, { ttl: LANDING_TTL }))
}

async function fetchRawgClipUrl(
  context: GraphQLContext,
  id: number | undefined,
): Promise<string | null> {
  if (id === undefined) return null
  try {
    // No explicit `ttl` here: `ttlFor('games/{id}/movies')` already resolves to 86 400s
    // (any `games/…` sub-path), the same value as `LANDING_TTL` — see `server/rawg/rawgFetch.ts`.
    const movies = (await context.rawg(`games/${id}/movies`)) as RawgList<RawgMovie>
    const first = movies.results?.[0]
    // The clip URL ends up as a media source in the client; run it through the same scheme
    // allow-list as every other third-party URL rather than trusting the upstream record.
    return safeExternalUrl(first?.data?.['480'] ?? first?.data?.max)
  } catch {
    // Trailers are an enhancement: a missing or failed clip must not fail the landing query.
    return null
  }
}

/**
 * RAWG has no clips for most recent games. As a fallback, look up the featured game's Steam
 * store link (already cached 24h by path via `games/{slug}/stores`), extract the Steam app id and
 * ask Steam for its trailer. Every failure on this path resolves to null — trailers are an
 * enhancement, never something that should fail or slow down the rest of the landing query.
 */
async function fetchSteamClipUrl(
  context: GraphQLContext,
  slug: string | undefined,
): Promise<string | null> {
  if (!slug) return null
  try {
    // Encoded like every other slug that goes into a path (see resolvers/game.ts): the value
    // comes from RAWG's own response, but the two adjacent resolvers should not differ on it.
    const path = `games/${encodeURIComponent(slug)}/stores`
    const stores = (await context.rawg(path)) as RawgList<RawgStoreLink>
    const steamLink = (stores.results ?? []).find((link) => steamAppIdFromUrl(link.url) !== null)
    const appId = steamAppIdFromUrl(steamLink?.url)
    if (!appId) return null
    const response = (await context.steam(appId, {
      ttl: LANDING_TTL,
    })) as SteamAppDetailsResponse
    const details = response[appId]
    if (!details?.success) return null
    return safeExternalUrl(pickTrailer(details.data?.movies))
  } catch {
    return null
  }
}

async function fetchClip(
  context: GraphQLContext,
  item: RawgGameListItem,
): Promise<{ clipUrl: string | null; clipSource: 'RAWG' | 'STEAM' | null }> {
  const rawgClip = await fetchRawgClipUrl(context, item.id)
  if (rawgClip) return { clipUrl: rawgClip, clipSource: 'RAWG' }
  const steamClip = await fetchSteamClipUrl(context, item.slug)
  if (steamClip) return { clipUrl: steamClip, clipSource: 'STEAM' }
  return { clipUrl: null, clipSource: null }
}

/**
 * The landing page: the featured game, the ring and five shelves (see `shared/shelves.ts`).
 *
 * Everything the index contributes overlaps RAWG instead of queueing behind it. The metadata read
 * starts first, beside the RAWG lists; the three index shelves start the moment it answers — all
 * three at once, one round of searches — and the one document read that prices the RAWG-served
 * cards runs beside them. A page view costs the index at most three round trips, whatever it
 * holds, and a store that has failed once in this request is not asked again (`indexFailed`).
 *
 * The index shelves are left out when the index cannot answer; the sale shelf, the only one that
 * reads a price, is left out while the prices are stale too, and the other two keep their games
 * with the prices withheld. A shelf with fewer than four games is left out. Nothing here fails the
 * landing because of the index.
 */
export const landing: QueryResolvers['landing'] = (_parent, _args, context) =>
  withUpstreamErrors(async () => {
    const { today } = context
    // The one clock read of this request is `today`; the year every shelf is measured against is
    // taken from it, never from a clock of its own.
    const year = Number(today.slice(0, 4))
    const pending = indexState(context)
    const indexShelvesPending = pending.then((state) => readIndexShelves(context, state, year))

    const rawgShelves = SHELVES.filter((shelf) => shelf.source === 'rawg')
    const [carouselPage, lastYearPage, ...rawgShelfPages] = await Promise.all([
      fetchGamesList(context, { ordering: '-added', page_size: CAROUSEL_SIZE }),
      fetchGamesList(context, {
        ordering: '-added',
        page_size: CAROUSEL_SIZE,
        dates: dateRange(today, FEATURED_WINDOW_DAYS),
      }),
      ...rawgShelves.map((shelf) => fetchGamesList(context, rawgShelfParams(shelf, year, today))),
    ])

    const carouselItems = (carouselPage.results ?? []).filter((item) => item.background_image)
    const lastYearItems = lastYearPage.results ?? []

    const featuredItem = pickFeatured(lastYearItems) ?? carouselItems[0] ?? null
    const featured = featuredItem
      ? {
          game: mapGameCard(featuredItem),
          ...(await fetchClip(context, featuredItem)),
        }
      : null
    const carousel = carouselItems.slice(0, CAROUSEL_LIMIT).map(mapGameCard)
    const shelfGames = new Map<ShelfIdValue, GameCard[]>(
      rawgShelves.map((shelf, position) => [
        shelf.id,
        (rawgShelfPages[position]?.results ?? []).slice(0, SHELF_SIZE).map(mapGameCard),
      ]),
    )

    // Every RAWG-served card in one index read, the featured game and the carousel included: the
    // shelves render `GameCard` with a price line, and a game on two shelves is looked up once. A
    // stale index withholds the prices and keeps the language lists, exactly as in the catalog.
    const state = await pending
    const rawgCards = [
      ...(featured ? [featured.game] : []),
      ...carousel,
      ...[...shelfGames.values()].flat(),
    ]
    const [indexShelves] = await Promise.all([
      indexShelvesPending,
      attachIndexData(context, rawgCards, { prices: !state.stale }),
    ])
    for (const [id, games] of indexShelves) shelfGames.set(id, games)

    const shelves: Shelf[] = SHELVES.map((shelf) => ({
      id: shelf.id,
      games: shelfGames.get(shelf.id) ?? [],
    })).filter((shelf) => shelf.games.length >= SHELF_MIN_GAMES)

    return { featured, carousel, shelves, totalGames: carouselPage.count ?? 0 }
  })

/** A RAWG shelf's request: the catalog's own translation of the shelf's filter and sort. */
function rawgShelfParams(shelf: ShelfDefinition, year: number, today: string) {
  const { filter, sort } = shelf.query(year)
  return filterToParams({ filter, sort, page: 1, pageSize: SHELF_SIZE, today })
}

/**
 * The index shelves that may be shown, read concurrently — one round of searches. A shelf whose
 * search fails is simply absent; the first failure is logged once for the whole request.
 */
async function readIndexShelves(
  context: GraphQLContext,
  state: IndexState,
  year: number,
): Promise<Map<ShelfIdValue, GameCard[]>> {
  // No metadata: nothing is published, the index is not configured, or it has already failed in
  // this request. Either way there is nothing to ask it for.
  if (state.meta === null || indexFailed(context)) return new Map()
  const wanted = SHELVES.filter(
    (shelf) => shelf.source === 'index' && !(shelf.dependsOnPrices && state.stale),
  )
  const answers = await Promise.all(
    wanted.map(async (shelf): Promise<[ShelfIdValue, GameCard[]]> => {
      const { filter, sort } = shelf.query(year)
      const query = toIndexQuery({
        filter,
        sort,
        page: 1,
        pageSize: SHELF_SIZE,
        today: context.today,
      })
      try {
        const page = await cachedIndexPage(context, query, state.version)
        return [shelf.id, state.stale ? withoutPrices(page.items) : page.items]
      } catch (error) {
        warnIndexOnce(context, 'a landing shelf could not be read', error)
        return [shelf.id, []]
      }
    }),
  )
  return new Map(answers)
}
