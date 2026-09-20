import type {
  GameCard,
  Image,
  LocalisationInfo,
  PriceSummary,
  StoreOffer,
} from '../graphql/__generated__/resolvers-types'
import { mapCover } from '../rawg/mappers'
import { platformFamiliesFromIds } from '../rawg/lookups'
import type { IndexedGame } from './document'

/**
 * The index document turned into what the schema serves. Pure: no clock, no store, no context —
 * the resolvers decide *which* path answers a request, these mappers decide what a document looks
 * like once it has been chosen.
 *
 * Both paths end up rendering the same card for the same game. The RAWG path builds the card with
 * `mapGameCard` and attaches `price`, `localisation` and `madeInUkraine` from the index document;
 * the index path builds the whole card here. The two fields in `RAWG_ONLY_CARD_FIELDS` are the
 * exception, and the only one: the document keeps platform ids and genre slugs rather than their
 * display names, so an index-served card carries neither. Nothing in the catalog reads platforms
 * or genres off a card.
 *
 * `screenshots` is not among them: the document's `preview` is the one screenshot the card's
 * hover preview uses, which is also the only one the RAWG card mapper's four ever get read, so an
 * index-served card keeps the preview.
 */

/** Card fields only the RAWG path can fill. `tests/server/index/toGraphql.test.ts` pins the list. */
export const RAWG_ONLY_CARD_FIELDS = ['platforms', 'genres'] as const

/** Every price the index knows comes from Steam; other stores are week 4. */
const PRICE_SOURCE_STORE = 'steam'

/**
 * The pre-discount price is served only when there is a discount to explain it: the schema
 * documents `regularUah` as "null when not on sale", and the interface strikes it through.
 */
function regularPriceOf(game: IndexedGame): number | null {
  return game.discountPercent > 0 ? game.regularPriceUah : null
}

/**
 * A price the index cannot date is not served at all. The two always travel together — the run
 * that reads a price stamps it — and a price with no timestamp would be rendered as one that was
 * read just now, which is the one thing a stale-price design must never do.
 */
export function toPriceSummary(game: IndexedGame): PriceSummary | null {
  if (game.priceUah === null || game.priceUpdatedAt === null) return null
  return {
    bestUah: game.priceUah,
    regularUah: regularPriceOf(game),
    bestStore: PRICE_SOURCE_STORE,
    discountPercent: game.discountPercent,
    isFree: game.free,
    updatedAt: game.priceUpdatedAt,
  }
}

/** Null when the game has neither Ukrainian text nor Ukrainian audio: there is no badge to show. */
export function toLocalisationInfo(game: IndexedGame): LocalisationInfo | null {
  const localisation = game.localisation
  if (!localisation) return null
  if (!localisation.text && !localisation.audio) return null
  return { text: localisation.text, audio: localisation.audio, source: localisation.source }
}

/** The game page's Steam offer: the store link RAWG gave, carrying the price the index holds. */
export function toSteamOffer(game: IndexedGame, url: string): StoreOffer {
  const priced = game.priceUah !== null && game.priceUpdatedAt !== null
  return {
    store: PRICE_SOURCE_STORE,
    url,
    priceUah: priced ? game.priceUah : null,
    regularPriceUah: priced ? regularPriceOf(game) : null,
    discountPercent: priced ? game.discountPercent : null,
    isFree: priced ? game.free : null,
    updatedAt: priced ? game.priceUpdatedAt : null,
  }
}

function previewImages(preview: string | null): Image[] {
  const image = mapCover(preview)
  return image ? [image] : []
}

/** The whole card, for a page the index serves on its own. */
export function toGameCard(game: IndexedGame): GameCard {
  return {
    id: String(game.id),
    slug: game.slug,
    name: game.name,
    released: game.released,
    rating: game.rating,
    metacritic: game.metacritic,
    playtime: game.playtime,
    cover: mapCover(game.cover),
    // One element or none: the card reads `screenshots[0]` as its hover preview and nothing else
    // reads a card's screenshots at all. A preview URL whose scheme is not allowed is dropped by
    // `mapCover`, exactly as the cover is.
    screenshots: previewImages(game.preview),
    platformFamilies: platformFamiliesFromIds(game.platforms),
    platforms: [],
    genres: [],
    price: toPriceSummary(game),
    localisation: toLocalisationInfo(game),
    madeInUkraine: game.madeInUkraine,
  }
}
