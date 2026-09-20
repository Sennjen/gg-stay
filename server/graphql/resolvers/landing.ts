import { safeExternalUrl } from '../../../shared/url'
import { mapGameCard } from '../../rawg/mappers'
import { dateRange, pickFeatured, pickTopRated } from '../../rawg/landing'
import type { RawgGameListItem, RawgList, RawgMovie, RawgStoreLink } from '../../rawg/types'
import { pickTrailer, steamAppIdFromUrl } from '../../steam/steam'
import type { SteamAppDetailsResponse } from '../../steam/types'
import { withUpstreamErrors } from '../errors'
import { attachIndexData, indexState } from '../indexPath'
import type { GraphQLContext } from '../context'
import type { QueryResolvers } from '../__generated__/resolvers-types'

// The landing page is cached server-side for 24h (see docs/specs/2026-09-19-redesign-design.md,
// "Server additions"): a page view should not reach RAWG on every request.
const LANDING_TTL = 86_400
const CAROUSEL_SIZE = 40
const CAROUSEL_LIMIT = 24
const NEW_RELEASES_WINDOW_DAYS = 90
const TOP_RATED_WINDOW_DAYS = 365
const NEW_RELEASES_LIMIT = 8
const TOP_RATED_LIMIT = 8

async function fetchGamesList(
  context: GraphQLContext,
  params: Record<string, string | number | undefined>,
): Promise<RawgList<RawgGameListItem>> {
  return context.rawg('games', params, { ttl: LANDING_TTL }) as Promise<RawgList<RawgGameListItem>>
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

export const landing: QueryResolvers['landing'] = (_parent, _args, context) =>
  withUpstreamErrors(async () => {
    const { today } = context
    // Started before the lists are fetched, awaited after them: the index enhances this page and
    // must not be a step in front of it, so its latency overlaps RAWG's instead of adding to it.
    const pending = indexState(context)
    const [carouselPage, lastYearPage, newReleasesPage] = await Promise.all([
      fetchGamesList(context, { ordering: '-added', page_size: CAROUSEL_SIZE }),
      fetchGamesList(context, {
        ordering: '-added',
        page_size: CAROUSEL_SIZE,
        dates: dateRange(today, TOP_RATED_WINDOW_DAYS),
      }),
      fetchGamesList(context, {
        ordering: '-added',
        page_size: NEW_RELEASES_LIMIT,
        dates: dateRange(today, NEW_RELEASES_WINDOW_DAYS),
      }),
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

    const page = {
      featured,
      carousel: carouselItems.slice(0, CAROUSEL_LIMIT).map(mapGameCard),
      newReleases: (newReleasesPage.results ?? []).slice(0, NEW_RELEASES_LIMIT).map(mapGameCard),
      topRated: pickTopRated(lastYearItems, TOP_RATED_LIMIT).map(mapGameCard),
      totalGames: carouselPage.count ?? 0,
    }

    // Every card of every row in one index read, the featured game and the carousel included: the
    // rows render `GameCard` and show a price line, and a game that appears in two of them must
    // not be looked up twice. A stale index withholds the prices and keeps the language lists,
    // exactly as it does in the catalog.
    const state = await pending
    const cards = [
      ...(page.featured ? [page.featured.game] : []),
      ...page.carousel,
      ...page.newReleases,
      ...page.topRated,
    ]
    await attachIndexData(context, cards, { prices: !state.stale })
    return page
  })
