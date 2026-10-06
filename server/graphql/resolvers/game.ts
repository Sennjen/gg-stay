import { isMadeInUkraine } from '../../../shared/ukrainianStudios'
import type { IndexedGame } from '../../index/document'
import { toLocalisationInfo, toSteamOffer } from '../../index/toGraphql'
import { mapGame } from '../../rawg/mappers'
import type { RawgGameDetail, RawgList, RawgScreenshot, RawgStoreLink } from '../../rawg/types'
import type { SteamPrice } from '../../steam/price'
import { steamAppIdFromUrl } from '../../steam/steam'
import type { GraphQLContext } from '../context'
import { withUpstreamErrors } from '../errors'
import { indexEntry, warnIndexOnce } from '../indexPath'
import type { Game, QueryResolvers, StoreOffer } from '../__generated__/resolvers-types'

/**
 * The game page reads its own index entry: the Steam offer carries the price, and the page gets
 * the language list and the made-in-Ukraine flag.
 *
 * The flag has a second source that needs no index at all: the game's own RAWG developers, checked
 * against the studio list (`shared/ukrainianStudios.ts`). That keeps it right for a game outside
 * the index and while the index is down; the index flag, set by the refresh job from the same
 * list, still counts when RAWG credits a studio under a slug the list does not carry.
 *
 * Prices are refreshed every six hours by the nightly job, so an entry that old — and a game with
 * a Steam store page that the index has never seen at all — is refreshed live from Steam for this
 * one app, and the answer is kept in Nitro storage for the same six hours so the next reader pays
 * nothing. "Steam has no price for this app" is such an answer too, and is kept the same way: a
 * delisted or regionless game would otherwise cost every reader of its page a Steam request that
 * can only say the same thing again. The live read is about the price only: the design refreshes
 * languages weekly, so the language list always comes from the index. Anything that goes wrong
 * keeps the index copy and logs a warning, because this page has to render either way, and the
 * site never writes to Redis.
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

/**
 * What one live read left in the cache: the price, or `null` for "Steam answered, and has no
 * price for this app". Only an answer is ever written — a read that failed leaves nothing, so the
 * next reader asks Steam again.
 */
interface RememberedPrice {
  price: SteamPrice | null
  fetchedAt: string
}

/** The remembered answer as a price to serve, or `null` when what is remembered is that none exists. */
function pricedOrNull(remembered: RememberedPrice): LivePrice | null {
  return remembered.price ? { price: remembered.price, fetchedAt: remembered.fetchedAt } : null
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
  const entry = Number.isFinite(id) ? await indexEntry(context, id) : null
  const appId = links.map((link) => steamAppIdFromUrl(link.url)).find((found) => found !== null)

  const priced = appId ? await refreshedPrice(context, appId, entry) : entry
  return {
    ...mapped,
    stores: withSteamPrice(mapped.stores, priced),
    localisation: entry ? toLocalisationInfo(entry) : null,
    madeInUkraine:
      isMadeInUkraine(mapped.developers.map((developer) => developer.slug)) ||
      (entry?.madeInUkraine ?? false),
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
    const cached = await context.cache.get<RememberedPrice>(key)
    if (cached) return pricedOrNull(cached)

    const prices = await context.steamPrices.fetchPrices([appId])
    const price = prices.get(appId) ?? null
    // Steam answering with no price at all — a regionless or delisted app, or an entry that does
    // not parse — is not a fresher price; the index copy stays. Neither is one without an amount.
    // It is an answer all the same, and is remembered as one, so the next reader of this page
    // does not wait for Steam to give it again.
    const remembered: RememberedPrice = {
      price: price && Number.isFinite(price.priceUah) ? price : null,
      fetchedAt: context.now,
    }
    await context.cache.set(key, remembered, LIVE_PRICE_TTL_SECONDS)
    return pricedOrNull(remembered)
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
