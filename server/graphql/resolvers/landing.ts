import { mapGameCard } from '../../rawg/mappers'
import { dateRange, pickFeatured, pickTopRated } from '../../rawg/landing'
import type { RawgGameListItem, RawgList, RawgMovie, RawgStoreLink } from '../../rawg/types'
import { pickTrailer, steamAppIdFromUrl } from '../../steam/steam'
import type { SteamAppDetailsResponse } from '../../steam/types'
import { withUpstreamErrors } from '../errors'
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
    const movies = (await context.rawg(`games/${id}/movies`, undefined, {
      ttl: LANDING_TTL,
    })) as RawgList<RawgMovie>
    const first = movies.results?.[0]
    return first?.data?.['480'] ?? first?.data?.max ?? null
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
    const stores = (await context.rawg(`games/${slug}/stores`)) as RawgList<RawgStoreLink>
    const steamLink = (stores.results ?? []).find((link) => steamAppIdFromUrl(link.url) !== null)
    const appId = steamAppIdFromUrl(steamLink?.url)
    if (!appId) return null
    const response = (await context.steam(appId, {
      ttl: LANDING_TTL,
    })) as SteamAppDetailsResponse
    const details = response[appId]
    if (!details?.success) return null
    return pickTrailer(details.data?.movies)
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

    return {
      featured,
      carousel: carouselItems.slice(0, CAROUSEL_LIMIT).map(mapGameCard),
      newReleases: (newReleasesPage.results ?? []).slice(0, NEW_RELEASES_LIMIT).map(mapGameCard),
      topRated: pickTopRated(lastYearItems, TOP_RATED_LIMIT).map(mapGameCard),
      totalGames: carouselPage.count ?? 0,
    }
  })
