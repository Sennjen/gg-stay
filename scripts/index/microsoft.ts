import {
  asRecord,
  discountPercentOf,
  NO_CACHE,
  STORE_MAX_ATTEMPTS,
  STORE_MIN_INTERVAL_MS,
  type StoreUpstreamRuntime,
} from './storeUpstream'
import type { IndexedStoreRefs } from '../../server/index/document'
import { createUpstreamFetch } from '../../server/upstream/createUpstreamFetch'
import { UpstreamError } from '../../server/upstream/errors'

/**
 * What the Microsoft Store — Xbox and PC — charges a buyer in Ukraine, read from the display
 * catalog its own storefronts are built on. Microsoft prices Ukraine in hryvnia, so the catalog
 * is asked for `market=UA` and an answer in any other currency is no price.
 *
 * **Most products RAWG links have no price here, and that is the answer.** Of the products behind
 * the thirty most popular games RAWG lists on the Xbox store, five were sold in Ukraine on
 * 2026-10-12; the rest are sold elsewhere and not here, or are editions Microsoft no longer sells
 * anywhere. A product that is not sold is not an error and not a failure: it is a game with no
 * Microsoft price.
 *
 * **The rule that picks the price** (`microsoftPurchasePrice`) is the whole of this module's risk,
 * because the catalog says "0" in four ways that are not a price: a subscriber's entitlement, a
 * trial, a licence, and the placeholder of a product that is not sold. It was established on
 * thirty-five products and is written down in
 * `docs/specs/2026-10-12-other-store-prices-design.md`, "Verified".
 */

const PRODUCTS_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products'

/**
 * Product ids a request. The catalog answered 190 in one request and no ceiling was found; a
 * hundred keeps one answer under a megabyte and makes a failed request cost a tenth of a refresh,
 * which is the size Steam's price chunks have for the same reason.
 */
export const MICROSOFT_IDS_PER_REQUEST = 100

/** A hundred ids were answered in about a second; fifteen is for a slow day. */
const TIMEOUT_MS = 15_000

/** The market whose prices are read, and whose product pages are linked. */
const MARKET = 'UA'
const CURRENCY = 'UAH'

/**
 * `actionFilter=Purchase` asks for what can be bought and nothing else: a product, an edition or
 * an availability without a purchase is left out of the answer, which is a third of the bytes and
 * changes nothing the rule below reads — it looks for the purchase itself either way.
 */
function productsUrl(ids: readonly string[]): string {
  return (
    `${PRODUCTS_URL}?bigIds=${ids.join(',')}` +
    `&market=${MARKET}&languages=uk-UA,en-US&actionFilter=Purchase`
  )
}

/** The catalog's answer about a batch of product ids, as Microsoft gave it. */
export type MicrosoftProductsFetch = (ids: string[]) => Promise<unknown>

/**
 * Microsoft's share of the shared transport. In fixture mode every batch is answered with the one
 * recorded answer (`tests/fixtures/microsoft/products.json`), out of which a caller reads the
 * products it asked about — as the recorded Steam prices are served.
 */
export function createMicrosoftProductsFetch(
  runtime: StoreUpstreamRuntime,
): MicrosoftProductsFetch {
  const fetchProducts = createUpstreamFetch<{ ids: string[] }>(
    {
      source: 'MICROSOFT',
      minIntervalMs: STORE_MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: STORE_MAX_ATTEMPTS,
      buildUrl: ({ ids }) => productsUrl(ids),
      cacheKey: ({ ids }) => `products/${ids.join(',')}`,
      fixtureName: () => 'products',
      ttlFor: () => 0,
    },
    { ...runtime, cache: NO_CACHE },
  )
  return (ids) => fetchProducts({ ids })
}

export interface MicrosoftPrice {
  /** What is charged now, in kopecks. */
  amount: number
  /** The price without the discount, in kopecks; never below `amount`. */
  regularAmount: number
  discountPercent: number
}

/** A catalog price in hryvnia as kopecks, or `null` unless it is a sum of whole kopecks. */
function kopecksOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  const kopecks = Math.round(value * 100)
  // 19.99 * 100 is 1998.9999999999998, so the product is rounded and then checked: a sum with
  // a third decimal is not a hryvnia price, and is not rounded into one.
  return Math.abs(value * 100 - kopecks) < 1e-6 && Number.isSafeInteger(kopecks) ? kopecks : null
}

/** A catalog timestamp (`2026-10-15T09:59:59.0000000Z`) as epoch milliseconds, or `null`. */
function instantOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  // The catalog writes seven fractional digits; three are all a date carries, and all `Date`
  // promises to read.
  const instant = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(instant) ? instant : null
}

/** Whether the catalog said anything in a field: it leaves out what does not apply. */
function isStated(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * The price anyone in Ukraine can buy one availability at, or `null` when it is not that. Every
 * condition is one of the ways the catalog was seen to say something else:
 *
 * - `Actions` without `Purchase` — a licence a subscriber already holds, a gift, a detail page,
 *   and the whole of a product that is not sold in the market, whose "price" reads `USD 0.0`;
 * - `RemediationRequired`, or any `Remediations` — the subscriber's price: 0 for a game in Game
 *   Pass, and the catalog's way of naming the subscription to sell first;
 * - an `AffirmationId` — an entitlement that comes with a subscription;
 * - `Markets` without `UA`, or a window (`Conditions.StartDate` to `EndDate`) that does not hold
 *   now — a price of another market or another week;
 * - a `CurrencyCode` other than `UAH`, or amounts that are not sums of whole kopecks.
 */
function purchasePriceOf(availability: unknown, now: number): MicrosoftPrice | null {
  const record = asRecord(availability)
  if (!record) return null
  if (!Array.isArray(record.Actions) || !record.Actions.includes('Purchase')) return null
  if (isStated(record.RemediationRequired) && record.RemediationRequired !== false) return null
  if (isStated(record.Remediations)) {
    if (!Array.isArray(record.Remediations) || record.Remediations.length > 0) return null
  }
  if (isStated(record.AffirmationId)) return null
  if (!Array.isArray(record.Markets) || !record.Markets.includes(MARKET)) return null

  const conditions = asRecord(record.Conditions)
  const start = instantOf(conditions?.StartDate)
  const end = instantOf(conditions?.EndDate)
  if (start === null || end === null || now < start || now > end) return null

  const price = asRecord(asRecord(record.OrderManagementData)?.Price)
  if (!price || price.CurrencyCode !== CURRENCY) return null
  const amount = kopecksOf(price.ListPrice)
  const msrp = kopecksOf(price.MSRP)
  if (amount === null || msrp === null) return null
  const regularAmount = Math.max(amount, msrp)
  return { amount, regularAmount, discountPercent: discountPercentOf(amount, regularAmount) }
}

/**
 * The price of one product: what anyone pays for its full edition today, or `null`.
 *
 * A product id is an edition — a deluxe edition is another product, with another id — so the
 * "standard edition" is simply the product RAWG's link names, and nothing here chooses between
 * editions. What it does choose between is the product's SKUs and their availabilities:
 *
 * - only a SKU whose `SkuType` is `full` and which is not flagged a trial. A trial SKU can be
 *   "purchased" for 0, and a game with a free trial is not a free game. (`IsBundle` decides
 *   nothing: it is true of standard editions too. A pre-order SKU is a full one: before release
 *   its price is what anyone pays.)
 * - only an availability anyone can buy at (`purchasePriceOf`).
 *
 * Every priced product seen had exactly one such availability. Should there be several, they have
 * to agree to the kopeck — the same price offered on two platforms is one price — and when they do
 * not, there is no telling which one a visitor would be charged, so there is no price: a missing
 * price costs a link without a number, and a wrong one costs the site its point.
 *
 * A free game is the same availability at 0, and comes out as a price of 0.
 */
export function microsoftPurchasePrice(product: unknown, now: number): MicrosoftPrice | null {
  const skus = asRecord(product)?.DisplaySkuAvailabilities
  if (!Array.isArray(skus)) return null

  let found: MicrosoftPrice | null = null
  for (const entry of skus) {
    const sku = asRecord(asRecord(entry)?.Sku)
    const availabilities = asRecord(entry)?.Availabilities
    if (!sku || sku.SkuType !== 'full' || !Array.isArray(availabilities)) continue
    if (asRecord(sku.Properties)?.IsTrial === true) continue

    for (const availability of availabilities) {
      const price = purchasePriceOf(availability, now)
      if (!price) continue
      if (found && (found.amount !== price.amount || found.regularAmount !== price.regularAmount)) {
        return null
      }
      found = price
    }
  }
  return found
}

/**
 * What one answer says about each of the ids it was asked for: a price, or `null` for a product
 * that is absent — Microsoft does not know the id, or does not sell the product in Ukraine — and
 * for one that is there without a price anyone can pay.
 *
 * An answer that is not an object with a `Products` list says nothing about any of them, and is
 * not read as "none of these is sold": it is thrown as the upstream failure it is, so the caller
 * keeps the offers it had.
 */
export function parseMicrosoftProducts(
  body: unknown,
  ids: readonly string[],
  now: number,
): Map<string, MicrosoftPrice | null> {
  const products = asRecord(body)?.Products
  if (!Array.isArray(products)) throw new UpstreamError('MICROSOFT', 'ERROR')

  const prices = new Map<string, MicrosoftPrice | null>(ids.map((id) => [id, null]))
  for (const product of products) {
    const id = asRecord(product)?.ProductId
    if (typeof id !== 'string' || !prices.has(id.toUpperCase())) continue
    prices.set(id.toUpperCase(), microsoftPurchasePrice(product, now))
  }
  return prices
}

/**
 * The product's page for Ukraine: the address RAWG's own link has — `microsoft.com`, `/p/`, the
 * name and the id — under the Ukrainian locale, where the price is the hryvnia one, and without
 * the tracking query the link came with.
 */
export function microsoftProductUrl(product: NonNullable<IndexedStoreRefs['microsoft']>): string {
  return `https://www.microsoft.com/uk-ua/p/${product.name}/${product.id.toLowerCase()}`
}
