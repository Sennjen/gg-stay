import type {
  Game,
  GameCard,
  Image,
  LocalisationInfo,
  PriceSummary,
  StoreOffer,
} from '../graphql/__generated__/resolvers-types'
import { mapCover, positive } from '../rawg/mappers'
import { platformFamiliesFromIds } from '../rawg/lookups'
import { steamStoreUrl } from '../steam/steam'
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

/**
 * The address of the game's Steam store page, when a page built from the document may offer it;
 * `null` when it may not.
 *
 * It takes both of two things. The document has to name the game's Steam app, because there is no
 * address without it. And it has to list Steam among the stores RAWG has the game on: the app id
 * says which Steam app the game is, not that the game is on Steam today — the refresh job keeps it
 * from a permanent mapping (`IndexedGame.steamAppId`) — while a page RAWG answers shows a Steam
 * link only when RAWG lists one. Asking for both keeps the two pages of one game from disagreeing
 * about where it is sold: the page built from the index never shows a Steam link that the page
 * built from RAWG would not.
 */
export function steamStorePageOf(game: IndexedGame): string | null {
  return game.stores.includes(PRICE_SOURCE_STORE) ? steamStoreUrl(game.steamAppId) : null
}

/**
 * The whole game page, for a page the index answers on its own — which it does when RAWG's own
 * answer about the game is late or has failed (`server/graphql/resolvers/game.ts`).
 *
 * It is the page the document can honestly fill. What the document carries is served as it
 * stands: the identity, the cover, the release date, the scores, the playtime, the age rating,
 * the game modes, the platform families, the language list and the made-in-Ukraine flag.
 * `ratingsCount` reads zero as unknown, as the RAWG mapper does, so the two pages agree about a
 * game nobody has rated. `screenshots` is the one preview the document keeps, or nothing.
 *
 * `stores` is a single Steam offer when the document both names the game's Steam app and lists
 * Steam among its stores (`steamStorePageOf`) — the address of the store page is built from the
 * app id, and the price fields are `toSteamOffer`'s — and empty otherwise: the document names its
 * other stores by slug, and a store without an address is not a link.
 *
 * What only RAWG has is left empty rather than guessed: `description` and `website` are null,
 * and the platform, genre, tag, developer and publisher lists are empty, because the document
 * keeps ids and slugs where the page shows names. That is why `partial` is always true here — a
 * page built from the document is, by construction, one RAWG has more to say about. `similar` is
 * its field resolver's to fill, as it is on a page RAWG answered.
 */
export function toGame(game: IndexedGame): Game {
  const storePage = steamStorePageOf(game)
  return {
    id: String(game.id),
    slug: game.slug,
    name: game.name,
    description: null,
    released: game.released,
    rating: game.rating,
    ratingsCount: positive(game.ratingsCount),
    metacritic: game.metacritic,
    playtime: game.playtime,
    ageRating: game.ageRating,
    gameModes: game.gameModes,
    cover: mapCover(game.cover),
    screenshots: previewImages(game.preview),
    platformFamilies: platformFamiliesFromIds(game.platforms),
    platforms: [],
    genres: [],
    tags: [],
    developers: [],
    publishers: [],
    website: null,
    stores: storePage ? [toSteamOffer(game, storePage)] : [],
    localisation: toLocalisationInfo(game),
    madeInUkraine: game.madeInUkraine,
    similar: [],
    partial: true,
  }
}
