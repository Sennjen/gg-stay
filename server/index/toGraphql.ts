import { chipPercent } from '../../shared/discount'
import { safeExternalUrl } from '../../shared/url'
import type {
  ExchangeRate,
  Game,
  GameCard,
  Image,
  LocalisationInfo,
  Money,
  PriceSummary,
  StoreOffer,
} from '../graphql/__generated__/resolvers-types'
import { mapCover, positive, toStoreLink } from '../rawg/mappers'
import { platformFamiliesFromIds } from '../rawg/lookups'
import { steamStoreUrl } from '../steam/steam'
import {
  MAX_OFFER_TITLE_LENGTH,
  type IndexedExchangeRate,
  type IndexedGame,
  type IndexedOffer,
} from './document'
import {
  cheaperAtOf,
  hryvniaOf,
  isFreshAt,
  isFreshOffer,
  listedOffers,
  markedCheapest,
  pageOffers,
  wholeHryvnia,
  type PricedRow,
} from './offerRules'

/**
 * The index document turned into what the schema serves. Pure: no clock, no store, no context —
 * the resolvers decide *which* path answers a request, these mappers decide what a document looks
 * like once it has been chosen.
 *
 * Both paths end up rendering the same card for the same game. The RAWG path builds the card with
 * `mapGameCard` and attaches `price`, `cheaperAt`, `localisation` and `madeInUkraine` from the
 * index document; the index path builds the whole card here. The two fields in
 * `RAWG_ONLY_CARD_FIELDS` are the exception, and the only one: the document keeps platform ids and
 * genre slugs rather than their display names, so an index-served card carries neither. Nothing
 * in the catalog reads platforms or genres off a card.
 *
 * `screenshots` is not among them: the document's `preview` is the one screenshot the card's
 * hover preview uses, which is also the only one the RAWG card mapper's four ever get read, so an
 * index-served card keeps the preview.
 */

/** Card fields only the RAWG path can fill. `tests/server/index/toGraphql.test.ts` pins the list. */
export const RAWG_ONLY_CARD_FIELDS = ['platforms', 'genres'] as const

/**
 * The store whose price is the game's own in the index (`IndexedGame.priceUah`): the one a card
 * shows, and the one every filter and sort reads. What GOG and the Microsoft Store charge travels
 * beside it as offers (`IndexedGame.offers`), and only a game page shows those; a card says no
 * more of them than which store is clearly cheaper (`cheaperAtOf`).
 */
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
    ...toStoreLink(PRICE_SOURCE_STORE, url),
    priceUah: priced ? game.priceUah : null,
    regularPriceUah: priced ? regularPriceOf(game) : null,
    discountPercent: priced ? game.discountPercent : null,
    isFree: priced ? game.free : null,
    updatedAt: priced ? game.priceUpdatedAt : null,
  }
}

/**
 * What has to be known before a document's other stores' prices can be used at all: by a game
 * page, to put one on a store's row and to mark the cheapest, and by a card, to say that another
 * store is cheaper (`cheaperAtOf`). Neither comes from the document: the clock is the request's
 * (`GraphQLContext.now`) and the rate is in the index's metadata (`exchangeRateAt`), which the
 * request has read by then.
 */
export interface OfferTerms {
  /** What a price's freshness is read against: thirty-six hours from its date (`isFreshAt`). */
  now: string
  /** What dollar prices are estimated in hryvnia with, or `null` when there is no rate to use. */
  rate: IndexedExchangeRate | null
}

/** Minor units as the schema's `Money`: the main unit, with the minor one as its fraction. */
function toMoney(amount: number, currency: string): Money {
  return { amount: amount / 100, currency }
}

/**
 * What the store calls the product, as the page may show it: plain text, or `null` when the offer
 * carries none. The job trims it and cuts it to `MAX_OFFER_TITLE_LENGTH`; both are done again
 * here, because the document is whatever the store holds and the page lays this text out.
 */
function titleOf(offer: IndexedOffer): string | null {
  if (typeof offer.title !== 'string') return null
  const title = Array.from(offer.title.trim()).slice(0, MAX_OFFER_TITLE_LENGTH).join('').trim()
  return title || null
}

/**
 * The store's row with no price on it, at the offer's own address for the product — or `null`
 * when that address does not pass the allow-list every outbound link passes (`safeExternalUrl`).
 * The address a row carries is the one the check hands back, never the string the document held:
 * what was refused is not passed on, to any caller.
 */
function toOfferLink(offer: Pick<IndexedOffer, 'store' | 'url'>): StoreOffer | null {
  const url = safeExternalUrl(offer.url)
  return url ? toStoreLink(offer.store, url) : null
}

/**
 * A fresh offer as the store's row: the store's own address for the product, what it calls it,
 * and the price in the fields of the currency it charges in.
 *
 * A hryvnia price fills the fields Steam's does, in whole hryvnia. A dollar price fills
 * `foreignPrice` and its neighbour, and `approxUah` when there is a rate — never the hryvnia
 * fields: an estimate is not a price, and nothing that reads `priceUah` may mistake it for one.
 * A free game is `isFree` in either currency and has no estimate: there is nothing to estimate.
 *
 * The regular price is served only when it is above the price as the row states it — in whole
 * hryvnia for a hryvnia store, so a price that rounds onto its regular price strikes nothing
 * through — and a discount only beside such a regular price, and only from 1 to 99 percent
 * (`chipPercent`). Whatever the document says, a row never offers a page a struck price that is
 * not higher, or a chip that says nothing.
 *
 * Freshness is the caller's to have checked (`isFreshOffer`), and so is which row the offer
 * belongs on; `cheapest` is `withCheapest`'s to say, once every row of the page is known.
 *
 * `null` when the offer's address does not pass the allow-list (`toOfferLink`): a row exists to
 * be followed, and there is no row to make of a price without an address to send anyone to. The
 * offers a document is read through have been checked already (`readableOffers`, by way of
 * `pageOffers`), so a caller that went through them never sees it — but the address is checked
 * here and not taken on that word, because this is where it leaves for a page.
 */
export function toStoreOffer(
  offer: IndexedOffer,
  rate: IndexedExchangeRate | null,
): StoreOffer | null {
  const link = toOfferLink(offer)
  if (!link) return null
  const row: StoreOffer = {
    ...link,
    title: titleOf(offer),
    isFree: offer.amount === 0,
    updatedAt: offer.updatedAt,
  }
  if (offer.currency === 'UAH') {
    const price = wholeHryvnia(offer.amount)
    const regular = wholeHryvnia(offer.regularAmount)
    const onSale = regular > price
    return {
      ...row,
      priceUah: price,
      regularPriceUah: onSale ? regular : null,
      discountPercent: chipPercent(offer.discountPercent, onSale) ?? 0,
    }
  }
  const onSale = offer.regularAmount > offer.amount
  const estimate = hryvniaOf(offer, rate)
  return {
    ...row,
    discountPercent: chipPercent(offer.discountPercent, onSale) ?? 0,
    foreignPrice: toMoney(offer.amount, offer.currency),
    foreignRegularPrice: onSale ? toMoney(offer.regularAmount, offer.currency) : null,
    approxUah: estimate?.approximate ? estimate.uah : null,
  }
}

/**
 * The rows of a page RAWG answered, with what the index holds of the other stores' prices put on
 * them: a store RAWG links gains its fresh offer, and with it the store's own address for the
 * product the price is for. Nothing else changes — a store RAWG does not link is not added, a
 * store without a fresh offer keeps the plain link RAWG gave, and the Steam row is left alone
 * (its price is the document's own, see `toSteamOffer`).
 *
 * Should RAWG link one store twice, the first row takes the offer and the second stays a link:
 * there is one price, and two rows quoting it would tie with each other for the cheapest.
 */
export function withStoreOffers(
  rows: StoreOffer[],
  game: IndexedGame | null,
  terms: OfferTerms,
): StoreOffer[] {
  if (!game) return rows
  const offers = new Map(
    pageOffers(game)
      .filter((offer) => isFreshOffer(offer, terms.now))
      .map((offer) => [offer.store as string, offer]),
  )
  if (offers.size === 0) return rows
  return rows.map((row) => {
    const offer = offers.get(row.store)
    if (!offer) return row
    offers.delete(row.store)
    // Without a row of the offer's own there is still the link RAWG gave.
    return toStoreOffer(offer, terms.rate) ?? row
  })
}

/**
 * A row as the cheapest rule weighs it at `now`, or `null` for a row that takes no part: the
 * hryvnia price when the store charges in hryvnia, the estimate when it charges in another
 * currency and there is a rate, and an exact zero for a free game, whatever the currency.
 *
 * A row takes part only while its price is fresh by the date the page shows for it (`isFreshAt`,
 * the offers' own thirty-six hours) — Steam's row included. The page shows Steam's price at any
 * age, under its date, and that is honest; calling it the cheapest, or calling another store the
 * cheapest against it, is a claim about today, and a price from last week does not support one.
 * The index carries a price forward under its old date when Steam stops answering for a game,
 * so this is not a rare row. A price Steam has just given is dated by the request that read it,
 * and is fresh; another store's offer is on its row only while it is.
 */
function pricedRowOf(row: StoreOffer, now: string): PricedRow | null {
  if (!isFreshAt(row.updatedAt, now)) return null
  if (row.priceUah != null) return { store: row.store, uah: row.priceUah, approximate: false }
  if (row.foreignPrice?.amount === 0) return { store: row.store, uah: 0, approximate: false }
  if (row.approxUah != null) return { store: row.store, uah: row.approxUah, approximate: true }
  return null
}

/**
 * Whether the row shows a fresh price that the rule has no amount for: a price in another
 * currency, not free, with no estimate beside it — which is a dollar price while there is no
 * rate. Such a row is not weighed, and it is not out of the way either (`withCheapest`).
 */
function cannotBeWeighed(row: StoreOffer, now: string): boolean {
  const foreign = row.priceUah == null ? row.foreignPrice : null
  return !!foreign && foreign.amount !== 0 && row.approxUah == null && isFreshAt(row.updatedAt, now)
}

/**
 * The same rows with `cheapest` set on the one the page marks (`markedCheapest`), and on no
 * other: the cheapest of the rows whose price is fresh at `now` (`pricedRowOf`), and no row at
 * all when that one is free or when fewer than two are fresh. A row with an older price is still
 * shown, with its age; it is neither marked nor a yardstick for the others.
 *
 * Nothing is marked, either, while some row shows a fresh price that cannot be weighed
 * (`cannotBeWeighed`). With no rate, a dollar price stands on the page as a number nobody can
 * place: it may be the lowest there. Marking the lowest of the rest would put "cheapest" on a
 * row beside a price that may be under it — the reason an estimate that undercuts by too little
 * marks nothing as well.
 *
 * It weighs the rows as the page shows them, so it is applied last: after Steam's row has taken
 * a live price, when it has one, and after the other stores' offers are on theirs.
 */
export function withCheapest(rows: StoreOffer[], now: string): StoreOffer[] {
  const priced = rows.flatMap((row) => {
    const weighed = pricedRowOf(row, now)
    return weighed ? [{ ...weighed, row }] : []
  })
  const silenced = rows.some((row) => cannotBeWeighed(row, now))
  const cheapest = silenced ? null : (markedCheapest(priced)?.row ?? null)
  return rows.map((row) =>
    row.cheapest === (row === cheapest) ? row : { ...row, cheapest: row === cheapest },
  )
}

/**
 * The rate as the page is told it — only when some row was estimated with it. A page with no
 * estimate on it has no use for a rate, and is not handed one.
 */
export function exchangeRateOf(
  rows: readonly StoreOffer[],
  rate: IndexedExchangeRate | null,
): ExchangeRate | null {
  if (!rate || !rows.some((row) => row.approxUah != null)) return null
  return { currency: rate.currency, uah: rate.uah, date: rate.date }
}

function previewImages(preview: string | null): Image[] {
  const image = mapCover(preview)
  return image ? [image] : []
}

/**
 * The whole card, for a page the index serves on its own. `terms` are what `cheaperAt` is worked
 * out with — the request's clock and the rate — and are asked of every caller, so that no path
 * can build a card from a document and leave the field out.
 */
export function toGameCard(game: IndexedGame, terms: OfferTerms): GameCard {
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
    cheaperAt: cheaperAtOf(game, terms.now, terms.rate),
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
 * `stores` begins with the Steam offer when the document both names the game's Steam app and
 * lists Steam among its stores (`steamStorePageOf`) — the address of the store page is built from
 * the app id, and the price fields are `toSteamOffer`'s. After it come the stores the document
 * holds an offer for and lists the game on (`listedOffers`), at the store's own address for the
 * product. With `terms`, an offer that is fresh carries its price (`toStoreOffer`); one that is
 * not is the link alone, and so is every offer when no `terms` are given — which is how a caller
 * withholds them, as it withholds Steam's price, while the index's prices are too old to show.
 * Any other store the document names is left out, as it always was: it is named by slug, and a
 * store without an address is not a link. The cheapest row is marked (`withCheapest`) — with
 * `terms`, which carry the clock the prices' freshness is read against; without them no price of
 * another store is on the page, and nothing is marked. `exchangeRate` is the rate an estimate on
 * the page was made with, if one was.
 *
 * What only RAWG has is left empty rather than guessed: `description` and `website` are null,
 * and the platform, genre, tag, developer and publisher lists are empty, because the document
 * keeps ids and slugs where the page shows names. That is why `partial` is always true here — a
 * page built from the document is, by construction, one RAWG has more to say about. `similar` is
 * its field resolver's to fill, as it is on a page RAWG answered.
 */
export function toGame(game: IndexedGame, terms: OfferTerms | null = null): Game {
  const storePage = steamStorePageOf(game)
  const rows = [
    ...(storePage ? [toSteamOffer(game, storePage)] : []),
    ...listedOffers(game).flatMap((offer) => {
      const fresh = terms !== null && isFreshOffer(offer, terms.now)
      const row = fresh ? toStoreOffer(offer, terms.rate) : toOfferLink(offer)
      return row ? [row] : []
    }),
  ]
  const stores = terms ? withCheapest(rows, terms.now) : rows
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
    stores,
    localisation: toLocalisationInfo(game),
    madeInUkraine: game.madeInUkraine,
    similar: [],
    exchangeRate: exchangeRateOf(stores, terms?.rate ?? null),
    partial: true,
  }
}
