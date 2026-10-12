import { safeExternalUrl } from '../../shared/url'
import {
  OFFER_STORES,
  type IndexMeta,
  type IndexedExchangeRate,
  type IndexedGame,
  type IndexedOffer,
} from './document'

/**
 * What the site makes of the prices the refresh job publishes for the stores other than Steam
 * (`IndexedGame.offers`, `IndexMeta.exchangeRate`): which of them is still a price, what it comes
 * to in hryvnia, and which of a game's prices is the cheapest.
 *
 * Pure, like the mappers beside it (`toGraphql.ts`): no store, no context, and no clock of its
 * own — the request's one clock (`GraphQLContext.now`) is handed in. The site never asks GOG, the
 * Microsoft Store or the bank anything; everything here is read off what the index already gave
 * the page.
 *
 * Every rule fails to "no price". The stores document none of the endpoints the job reads, and a
 * document is whatever the store holds under its key, so nothing is taken on trust: an offer the
 * site cannot date, cannot read or would not link to is not shown as a price at all, and never as
 * a wrong one.
 */

/**
 * How old an offer may be and still be a price: thirty-six hours from the read it is dated by.
 *
 * The job reads each store twice a day, so a healthy offer is under twelve hours old; thirty-six
 * lets two reads in a row fail before a page stops quoting the store. The job itself never drops
 * an offer for its age — a store that keeps failing leaves its old offers on the documents, under
 * their old dates — so this is the only place an old price is told from a current one.
 */
export const OFFER_FRESH_FOR_MS = 36 * 60 * 60 * 1000

/**
 * How old the bank's rate may be and still be a rate: seven days from the read it is dated by.
 *
 * It is the refresh job's own rule (`RATE_KEPT_MS`, `scripts/index/offers.ts`), applied here a
 * second time on purpose. The job drops a rate after seven days without a successful read, but
 * only while it runs: if the job stops altogether, the metadata keeps the last rate it wrote for
 * as long as nothing overwrites it. The site therefore measures the age itself, and estimates
 * nothing with a rate the job would have dropped.
 */
export const EXCHANGE_RATE_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How far below the lowest exact price an estimate has to be before it is called the cheapest:
 * five percent. The estimate is made at the National Bank's official rate, and the buyer's bank
 * converts at its own, which is usually a percent or three above it — so an estimate that only
 * just undercuts a hryvnia price says nothing about which of the two the buyer would pay less
 * for.
 */
export const APPROXIMATE_MARGIN_PERCENT = 5

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Milliseconds from `iso` to `now`, or `NaN` when either is not a timestamp. `NaN` fails every
 * comparison it enters, which is what makes "cannot be dated" read as "too old" below.
 */
function ageAt(iso: unknown, now: string): number {
  return typeof iso === 'string' ? Date.parse(now) - Date.parse(iso) : Number.NaN
}

/** A whole, non-negative number of minor units: the only kind of amount the job writes. */
function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A whole percent from 0 to 100: the only kind of discount the job writes. */
function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
}

/**
 * The rate the metadata carries, when it is one the site may estimate with at `now`; `null`
 * otherwise — no metadata, no rate in it, a rate read more than `EXCHANGE_RATE_KEPT_MS` ago or at
 * a moment that cannot be read, or one that is not a rate at all (another currency, a value that
 * is not a positive number, a day that is not a day). Exactly seven days old is still a rate, as
 * it is for the job.
 */
export function exchangeRateAt(
  meta: Pick<IndexMeta, 'exchangeRate'> | null | undefined,
  now: string,
): IndexedExchangeRate | null {
  const rate = meta?.exchangeRate
  if (!rate || rate.currency !== 'USD') return null
  if (!Number.isFinite(rate.uah) || rate.uah <= 0) return null
  if (typeof rate.date !== 'string' || !ISO_DAY.test(rate.date)) return null
  return ageAt(rate.readAt, now) <= EXCHANGE_RATE_KEPT_MS ? rate : null
}

/**
 * Whether what the document holds under `offers` is an offer this build knows how to show: one of
 * the stores it knows, in one of the two currencies it knows, with amounts that are amounts — the
 * regular one never below the current one — a discount that is a percent, and an address that
 * passes the allow-list every outbound link passes (`safeExternalUrl`).
 *
 * A newer refresh job may publish stores and currencies this build has never heard of, and those
 * are passed over rather than guessed at: a price in a currency the page cannot name is not one
 * it can show.
 */
function isReadableOffer(offer: IndexedOffer): boolean {
  return (
    typeof offer === 'object' &&
    offer !== null &&
    (OFFER_STORES as readonly string[]).includes(offer.store) &&
    (offer.currency === 'USD' || offer.currency === 'UAH') &&
    isAmount(offer.amount) &&
    isAmount(offer.regularAmount) &&
    offer.regularAmount >= offer.amount &&
    isPercent(offer.discountPercent) &&
    safeExternalUrl(offer.url) !== null
  )
}

/**
 * The offers the document holds that this build can show (`isReadableOffer`), at most one a
 * store — the first, should a document ever carry two.
 *
 * Nothing here looks at an offer's age: one that is too old to be a price still names the store's
 * own page for the product (`isFreshOffer`).
 */
export function readableOffers(game: Pick<IndexedGame, 'offers'>): IndexedOffer[] {
  const offers = Array.isArray(game.offers) ? game.offers : []
  const seen = new Set<string>()
  return offers.filter((offer) => {
    if (!isReadableOffer(offer) || seen.has(offer.store)) return false
    seen.add(offer.store)
    return true
  })
}

/**
 * The offers a page built from the document alone may show a store for: the readable ones, for a
 * store RAWG lists the game on (`IndexedGame.stores`).
 *
 * The second condition is the one `steamStorePageOf` asks of the Steam link, for the same reason.
 * An offer says what a store charged for the product a permanent mapping names, not that the game
 * is on that store today — and a page RAWG answers shows a store only when RAWG links it. Asking
 * for both keeps the two pages of one game from disagreeing about where it is sold. A page RAWG
 * answered needs no such check: its rows are RAWG's own links.
 */
export function listedOffers(game: Pick<IndexedGame, 'stores' | 'offers'>): IndexedOffer[] {
  return readableOffers(game).filter((offer) => game.stores.includes(offer.store))
}

/**
 * Whether the offer is still a price at `now`: read no more than `OFFER_FRESH_FOR_MS` ago. An
 * offer whose date cannot be read is not fresh — it would otherwise be shown as one read just
 * now, which is the one thing a dated price must never do.
 */
export function isFreshOffer(offer: Pick<IndexedOffer, 'updatedAt'>, now: string): boolean {
  return ageAt(offer.updatedAt, now) <= OFFER_FRESH_FOR_MS
}

/**
 * The offers that are prices at `now` for anything built from the document alone — a card, the
 * page the index answers by itself: listed (`listedOffers`), and fresh.
 */
export function freshOffers(
  game: Pick<IndexedGame, 'stores' | 'offers'>,
  now: string,
): IndexedOffer[] {
  return listedOffers(game).filter((offer) => isFreshOffer(offer, now))
}

/**
 * Kopecks as whole hryvnia, rounded to the nearest one — every price on the site is a whole
 * number of hryvnia, and the Microsoft Store charges kopecks during a sale (508.20 ₴ is shown as
 * 508 ₴).
 */
export function wholeHryvnia(kopecks: number): number {
  return Math.round(kopecks / 100)
}

/** One store's price as the cheapest rule weighs it. */
export interface PricedRow {
  store: string
  /** Whole hryvnia: what the store charges, or what its price comes to at the bank's rate. */
  uah: number
  /** The amount is an estimate made with the rate, not a sum the store charges. */
  approximate: boolean
}

/**
 * What an offer comes to in whole hryvnia, and whether that is the store's own sum or an estimate;
 * `null` when it cannot be said — a dollar price with no rate to estimate it with.
 *
 * A hryvnia price is the store's own, rounded to a hryvnia (`wholeHryvnia`). A dollar price is an
 * estimate at the bank's rate, rounded the same way. A free game is neither: nothing times any
 * rate is nothing, so it is an exact 0 with or without a rate.
 */
export function hryvniaOf(
  offer: Pick<IndexedOffer, 'amount' | 'currency'>,
  rate: Pick<IndexedExchangeRate, 'uah'> | null,
): Pick<PricedRow, 'uah' | 'approximate'> | null {
  if (offer.currency === 'UAH') return { uah: wholeHryvnia(offer.amount), approximate: false }
  if (offer.amount === 0) return { uah: 0, approximate: false }
  return rate ? { uah: wholeHryvnia(offer.amount * rate.uah), approximate: true } : null
}

/**
 * The cheapest of a game's priced rows, or `null` when none of them may be called that.
 *
 * It is the row with the lowest hryvnia amount, exact or approximate, under three conditions:
 *
 * - **There is something to be cheaper than.** Fewer than two rows, and nothing is marked.
 * - **It is alone at the bottom.** When two rows share the lowest amount, neither is the cheapest.
 * - **An estimate has to win clearly.** When the lowest amount is approximate and some row is
 *   exact, the estimate must be at least `APPROXIMATE_MARGIN_PERCENT` below the lowest exact
 *   amount. One that undercuts it by less wins nothing — and neither does the exact row above
 *   it, because the page shows a lower number right beside it. An exact amount that is the lowest
 *   needs no margin: the estimate above it errs, if anything, on the low side.
 *
 * The rule is about amounts alone. Which edition a store's link leads to plays no part in it (a
 * row's title is there to say so), and neither does the order of the rows.
 *
 * Shared by the game page, which weighs the rows it shows — Steam's live price included — and by
 * anything else that has to say which store is cheapest for a document.
 */
export function cheapestRow<Row extends PricedRow>(rows: readonly Row[]): Row | null {
  if (rows.length < 2) return null
  const lowest = rows.reduce((best, row) => (row.uah < best.uah ? row : best))
  if (rows.some((row) => row !== lowest && row.uah === lowest.uah)) return null
  if (!lowest.approximate) return lowest

  const exact = rows.filter((row) => !row.approximate)
  if (exact.length === 0) return lowest
  const lowestExact = Math.min(...exact.map((row) => row.uah))
  // Whole numbers on both sides, so "at least five percent below" has no rounding of its own.
  return lowest.uah * 100 <= lowestExact * (100 - APPROXIMATE_MARGIN_PERCENT) ? lowest : null
}
