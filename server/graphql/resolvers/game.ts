import type { IndexedGame } from '../../index/document'
import { toLocalisationInfo, toSteamOffer } from '../../index/toGraphql'
import { mapGame } from '../../rawg/mappers'
import type { RawgGameDetail, RawgList, RawgScreenshot, RawgStoreLink } from '../../rawg/types'
import type { SteamPrice } from '../../steam/price'
import { steamAppIdFromUrl } from '../../steam/steam'
import type { GraphQLContext } from '../context'
import { withUpstreamErrors } from '../errors'
import { indexFailed, warnIndexOnce } from '../indexPath'
import type { Game, QueryResolvers, StoreOffer } from '../__generated__/resolvers-types'

/**
 * The game page reads its own index entry: the Steam offer carries the price, and the page gets
 * the language list and the made-in-Ukraine flag.
 *
 * Prices are refreshed every six hours by the nightly job, so an entry that old — and a game with
 * a Steam store page that the index has never seen at all — is refreshed live from Steam for this
 * one app, and the answer is kept in Nitro storage for the same six hours so the next reader pays
 * nothing. The live read is about the price only: the design refreshes languages weekly, so the
 * language list always comes from the index. Anything that goes wrong keeps the index copy and
 * logs a warning, because this page has to render either way, and the site never writes to Redis.
 *
 * The read goes through `fetchPrices([appId])`, which is the only Steam path in this project that
 * never caches (`steamPriceFetch.ts`'s `NO_CACHE`). The per-app transport beside it keeps its
 * answers for twenty-four hours, so a "refresh" through it would very often hand back a day-old
 * body — and the whole point of this call is that the timestamp on the price is true. What is
 * cached is this resolver's own six-hour entry, and it carries the moment the fetch actually
 * happened, which is what `updatedAt` is stamped with.
 */

/** How old an index price may be before the page refreshes that one game from Steam. */
export const PRICE_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000
const LIVE_PRICE_TTL_SECONDS = 6 * 60 * 60
const LIVE_PRICE_PREFIX = 'steam-price'

interface LivePrice {
  price: SteamPrice
  /**
   * When this price was actually read from Steam — the moment the uncached fetch returned, kept
   * in the cache entry beside the price, so a reader served from the cache six hours later still
   * stamps `updatedAt` with the read rather than with its own request time.
   */
  fetchedAt: string
}

export const game: QueryResolvers['game'] = (_parent, { slug }, context) =>
  withUpstreamErrors(async () => {
    const path = `games/${encodeURIComponent(slug)}`
    const [detail, storeLinks, screenshots] = await Promise.all([
      context.rawg(path) as Promise<RawgGameDetail>,
      // Store links are an enhancement: the page still renders without them.
      (context.rawg(`${path}/stores`) as Promise<RawgList<RawgStoreLink>>).catch(() => null),
      // Same pattern: screenshots are an enhancement, not required to render the page.
      (context.rawg(`${path}/screenshots`) as Promise<RawgList<RawgScreenshot>>).catch(() => null),
    ])
    const links = storeLinks?.results ?? []
    const mapped = mapGame(detail, links, screenshots?.results ?? [])
    return attachIndexEntry(context, mapped, links)
  })

async function attachIndexEntry(
  context: GraphQLContext,
  mapped: Game,
  links: RawgStoreLink[],
): Promise<Game> {
  const id = Number(mapped.id)
  const entry = Number.isFinite(id) ? await readEntry(context, id) : null
  const appId = links.map((link) => steamAppIdFromUrl(link.url)).find((found) => found !== null)

  const priced = appId ? await refreshedPrice(context, appId, entry) : entry
  return {
    ...mapped,
    stores: withSteamPrice(mapped.stores, priced),
    localisation: entry ? toLocalisationInfo(entry) : null,
    madeInUkraine: entry?.madeInUkraine ?? false,
  }
}

async function readEntry(context: GraphQLContext, id: number): Promise<IndexedGame | null> {
  if (indexFailed(context)) return null
  try {
    return await context.index.getOne(id)
  } catch (error) {
    warnIndexOnce(context, 'the game page could not read its index entry', error)
    return null
  }
}

/** The index entry with a fresher price on it, or the entry unchanged when none was needed. */
async function refreshedPrice(
  context: GraphQLContext,
  appId: string,
  entry: IndexedGame | null,
): Promise<IndexedGame | null> {
  if (entry && !needsRefresh(context, entry)) return entry

  const live = await livePrice(context, appId)
  if (!live) return entry

  return {
    ...(entry ?? emptyEntryFor(appId)),
    priceUah: live.price.priceUah,
    regularPriceUah: live.price.regularPriceUah,
    discountPercent: live.price.discountPercent,
    free: live.price.isFree,
    priceUpdatedAt: live.fetchedAt,
  }
}

function needsRefresh(context: GraphQLContext, entry: IndexedGame): boolean {
  if (entry.priceUpdatedAt === null) return true
  const age = Date.parse(context.now) - Date.parse(entry.priceUpdatedAt)
  return !Number.isFinite(age) || age > PRICE_REFRESH_AFTER_MS
}

async function livePrice(context: GraphQLContext, appId: string): Promise<LivePrice | null> {
  const key = `${LIVE_PRICE_PREFIX}:${appId}`
  try {
    // The cache read is inside the guard on purpose: a storage driver that throws must cost this
    // page a Steam request, never a 500.
    const cached = await context.cache.get<LivePrice>(key)
    if (cached) return cached

    const prices = await context.steamPrices.fetchPrices([appId])
    const price = prices.get(appId) ?? null
    // Steam answering with no price at all — a regionless app, or an entry that does not parse —
    // is not a fresher price; the index copy stays. Neither is one without an amount.
    if (!price || !Number.isFinite(price.priceUah)) return null
    const live: LivePrice = { price, fetchedAt: context.now }
    await context.cache.set(key, live, LIVE_PRICE_TTL_SECONDS)
    return live
  } catch (error) {
    warnIndexOnce(context, 'the live Steam price could not be read', error)
    return null
  }
}

/**
 * A price for a game the index has never held needs somewhere to sit. Everything else on this
 * shape stays empty: it is the price that was fetched, not a card.
 */
function emptyEntryFor(appId: string): IndexedGame {
  return {
    id: 0,
    slug: appId,
    name: '',
    cover: null,
    preview: null,
    released: null,
    popularity: 0,
    platforms: [],
    genres: [],
    stores: ['steam'],
    gameModes: [],
    ageRating: null,
    rating: null,
    ratingsCount: 0,
    metacritic: null,
    playtime: null,
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: null,
  }
}

/** The Steam link keeps its URL and gains the price; every other store stays a plain link. */
function withSteamPrice(offers: StoreOffer[], entry: IndexedGame | null): StoreOffer[] {
  if (!entry) return offers
  return offers.map((offer) => (offer.store === 'steam' ? toSteamOffer(entry, offer.url) : offer))
}
