import {
  asRecord,
  discountPercentOf,
  NO_CACHE,
  STORE_MAX_ATTEMPTS,
  STORE_MIN_INTERVAL_MS,
  storeTitle,
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
 *
 * **Three questions, one line.** The catalog is asked what a batch of products costs
 * (`products`), and — only for a game RAWG's link gave no price for (`storeFallbacks.ts`) — what a
 * batch of products is related to (`details`) and what the store sells under a name (`search`).
 * All three leave through one transport and so through one limiter: a request a second to
 * Microsoft, whichever of the three it is.
 */

const PRODUCTS_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products'
const SEARCH_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest'

/**
 * Product ids a request. The catalog answered 190 in one request and no ceiling was found; a
 * hundred keeps one answer under a megabyte and makes a failed request cost a tenth of a refresh,
 * which is the size Steam's price chunks have for the same reason.
 */
export const MICROSOFT_IDS_PER_REQUEST = 100

/**
 * Product ids a request when nothing is filtered out (`details`). Without `actionFilter` the
 * catalog answers with the whole record of every product it knows, sold or not — some 60 kB each:
 * ten products were 595 kB on 2026-10-13, where a hundred asked for with the filter are under a
 * megabyte. Twenty keeps such an answer the weight the price read's already is.
 */
export const MICROSOFT_DETAIL_IDS_PER_REQUEST = 20

/** A hundred ids were answered in about a second; fifteen is for a slow day. */
const TIMEOUT_MS = 15_000

/** A search was answered in under half a second, in a few hundred bytes; ten is for a slow day. */
const SEARCH_TIMEOUT_MS = 10_000

/** The longest name a search is sent. A game's name is a few dozen characters. */
const MAX_SEARCH_NAME_LENGTH = 200

/** The market whose prices are read, and whose product pages are linked. */
const MARKET = 'UA'
const CURRENCY = 'UAH'

/**
 * `actionFilter=Purchase` asks for what can be bought and nothing else: a product, an edition or
 * an availability without a purchase is left out of the answer, which is a third of the bytes and
 * changes nothing the rule below reads — it looks for the purchase itself either way.
 *
 * `languages=uk-UA,en-US` is an order of preference, and it decides one thing: the language of
 * the product's title and description. Microsoft answers in Ukrainian where the publisher wrote
 * the listing in Ukrainian and in English otherwise, which is what its own page for Ukraine does
 * — the page an offer links to. It has no say in the price: the market has.
 */
function productsUrl(ids: readonly string[]): string {
  return (
    `${PRODUCTS_URL}?bigIds=${ids.join(',')}` +
    `&market=${MARKET}&languages=uk-UA,en-US&actionFilter=Purchase`
  )
}

/**
 * The same products with nothing filtered out: every product the catalog knows for the market,
 * sold or not, with what it is related to. It is the only way to ask about a product that cannot
 * be bought — which is every product this is asked about.
 */
function detailsUrl(ids: readonly string[]): string {
  return `${PRODUCTS_URL}?bigIds=${ids.join(',')}&market=${MARKET}&languages=uk-UA,en-US`
}

/**
 * The store's own search, as its storefront's search box asks it: what it sells in Ukraine under
 * a name, among games. The name is somebody else's text and goes into the query encoded, whatever
 * it holds.
 */
function searchUrl(name: string): string {
  return (
    `${SEARCH_URL}?market=${MARKET}&languages=uk-UA,en-US&productFamilyNames=Games` +
    `&query=${encodeURIComponent(name)}`
  )
}

/** A name as a fixture is named after it: `Grand Theft Auto V` is `grand-theft-auto-v`. */
function fixtureSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The catalog's answer about a batch of product ids, as Microsoft gave it. */
export type MicrosoftProductsFetch = (ids: string[]) => Promise<unknown>

/** The catalog's answer to a search for a name, as Microsoft gave it. */
export type MicrosoftSearchFetch = (name: string) => Promise<unknown>

/** The two questions only a game without a price is asked about (`storeFallbacks.ts`). */
export interface MicrosoftCatalogFetch {
  /** A batch of products with nothing filtered out: what each is, and what it is related to. */
  details: MicrosoftProductsFetch
  /** What the store sells in Ukraine under a name. */
  search: MicrosoftSearchFetch
}

/** Everything the job asks the Microsoft Store, on one line (`createMicrosoftFetches`). */
export interface MicrosoftFetches extends MicrosoftCatalogFetch {
  /** What a batch of products costs: only what can be bought (`actionFilter=Purchase`). */
  products: MicrosoftProductsFetch
}

type MicrosoftRequest =
  | { kind: 'products'; ids: string[] }
  | { kind: 'details'; ids: string[] }
  | { kind: 'search'; name: string }

/**
 * Microsoft's share of the shared transport: one transport for all three questions, so that the
 * limiter is one and two requests to Microsoft are never closer than a second, whichever two.
 *
 * **A search is sent once.** A price read retries a timeout or a 5xx like every transport of this
 * project; a search does not. It is a request a game, a hundred and fifty of them in a run, to an
 * endpoint nobody documents for us: one that fails is left for the next run that finds the store
 * due, not asked again in this one.
 *
 * In fixture mode every price batch is answered with the one recorded answer
 * (`tests/fixtures/microsoft/products.json`) and every unfiltered batch with the other
 * (`details.json`), out of which a caller reads the products it asked about — as the recorded
 * Steam prices are served. A search is answered with the recording named after what was searched
 * for (`search-prey.json`).
 */
export function createMicrosoftFetches(runtime: StoreUpstreamRuntime): MicrosoftFetches {
  const ask = createUpstreamFetch<MicrosoftRequest>(
    {
      source: 'MICROSOFT',
      minIntervalMs: STORE_MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: STORE_MAX_ATTEMPTS,
      buildUrl: (request) =>
        request.kind === 'search'
          ? searchUrl(request.name)
          : request.kind === 'details'
            ? detailsUrl(request.ids)
            : productsUrl(request.ids),
      cacheKey: (request) =>
        request.kind === 'search'
          ? `search/${request.name}`
          : `${request.kind}/${request.ids.join(',')}`,
      fixtureName: (request) =>
        request.kind === 'search' ? `search-${fixtureSlug(request.name)}` : request.kind,
      ttlFor: () => 0,
      limitsFor: (request) =>
        request.kind === 'search' ? { timeoutMs: SEARCH_TIMEOUT_MS, maxAttempts: 1 } : undefined,
    },
    { ...runtime, cache: NO_CACHE },
  )
  return {
    products: (ids) => ask({ kind: 'products', ids }),
    details: (ids) => ask({ kind: 'details', ids }),
    search: (name) =>
      ask({ kind: 'search', name: Array.from(name).slice(0, MAX_SEARCH_NAME_LENGTH).join('') }),
  }
}

/** The price read alone, for a caller that asks the catalog nothing else. */
export function createMicrosoftProductsFetch(
  runtime: StoreUpstreamRuntime,
): MicrosoftProductsFetch {
  return createMicrosoftFetches(runtime).products
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

/** An ISO timestamp that says which zone it is in — `Z`, or an offset — with any fraction. */
const ZONED_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

/**
 * A catalog timestamp (`2026-10-15T09:59:59.0000000Z`) as epoch milliseconds, or `null`.
 *
 * Only one that names its zone. `Date.parse` reads a date-time without one as local time, so the
 * same answer would open and close its windows at different moments on a runner in UTC and on a
 * laptop in Kyiv — and a window is what decides whether a price is today's. The catalog has
 * always written `Z`; a timestamp that does not is one this job does not know how to read.
 */
function instantOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const stamp = ZONED_TIMESTAMP.exec(value)
  if (!stamp) return null
  // The catalog writes seven fractional digits; three are all a date carries, and all `Date`
  // promises to read.
  const millis = (stamp[2] ?? '').slice(0, 3).padEnd(3, '0')
  const instant = Date.parse(`${stamp[1]}.${millis}${stamp[3]}`)
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
 * What Microsoft calls a product, in the language it answered in: `ProductTitle` of the answer's
 * localised properties, as plain text, or `null` when there is none.
 *
 * The answer carries the listing in one language — the best match for the `languages` that were
 * asked for, Ukrainian before English (`productsUrl`) — so the title is the one on the product's
 * page for Ukraine, which is where the offer leads. Should an answer ever carry several, the same
 * preference picks among them: the Ukrainian one, then an English one, then whichever comes first.
 * A title in Ukrainian will not match a game's English name letter for letter; it is still what
 * the store calls the thing it is selling, and says which edition that is.
 */
export function microsoftProductTitle(product: unknown): string | null {
  const localised = asRecord(product)?.LocalizedProperties
  if (!Array.isArray(localised)) return null
  const titled = localised.flatMap((entry) => {
    const title = storeTitle(asRecord(entry)?.ProductTitle)
    const language = asRecord(entry)?.Language
    return title === null
      ? []
      : [{ title, language: typeof language === 'string' ? language.toLowerCase() : '' }]
  })
  const preferred =
    titled.find((entry) => entry.language.startsWith('uk')) ??
    titled.find((entry) => entry.language.startsWith('en')) ??
    titled[0]
  return preferred?.title ?? null
}

/** The year from which a catalog date is its way of saying it has none (`9998-12-30`). */
const NO_DATE_YEAR = 9000

/** What the catalog says of a product in the market that was asked for, or `undefined`. */
function marketProperties(product: unknown): Record<string, unknown> | undefined {
  const properties = asRecord(product)?.MarketProperties
  if (!Array.isArray(properties)) return undefined
  return properties
    .map((entry) => asRecord(entry))
    .find((entry) => Array.isArray(entry?.Markets) && entry.Markets.includes(MARKET))
}

/**
 * The group the catalog files a product under (`Properties.ProductGroupId`), or `null` when it
 * states none. The editions of one game share it — the "Resident Evil Village" nobody can buy and
 * the one on sale are both in the group the catalog calls VILLAGE — and an older product often
 * has none (Terraria). It is only ever compared with another product's, never sent or shown.
 */
function microsoftProductGroup(product: unknown): string | null {
  const group = asRecord(asRecord(product)?.Properties)?.ProductGroupId
  return typeof group === 'string' && group.trim() !== '' ? group : null
}

/**
 * When the catalog says a product was first released in the market (`OriginalReleaseDate`), as
 * epoch milliseconds, or `null` when it does not say so in a way this job reads. It is the date
 * of the listing, not of the game: the "Resident Evil Village" on sale is dated 2026. A product
 * the catalog has no date for is dated `9998-12-30`; any year from 9000 on is read as that, which
 * is no date at all.
 */
function microsoftReleasedAt(product: unknown): number | null {
  const at = instantOf(marketProperties(product)?.OriginalReleaseDate)
  return at !== null && new Date(at).getUTCFullYear() < NO_DATE_YEAR ? at : null
}

/** What kind of product the catalog says it is (`ProductKind`), or `null`. */
function kindOf(product: unknown): string | null {
  const kind = asRecord(product)?.ProductKind
  return typeof kind === 'string' && kind !== '' ? kind : null
}

/**
 * A product Microsoft sells in Ukraine: what anyone pays for it, what the store calls it, and the
 * two things a product found by another way than RAWG's link is judged by (`storeFallbacks.ts`) —
 * its group and the date of its listing.
 */
export interface MicrosoftProduct {
  price: MicrosoftPrice
  title: string | null
  /** `ProductKind`: `Game` for a game, `Durable` for an add-on; `null` when it states none. */
  kind: string | null
  group: string | null
  releasedAt: number | null
}

/**
 * What one answer says about each of the ids it was asked for: the product's price and title, or
 * `null` for a product that is absent — Microsoft does not know the id, or does not sell the
 * product in Ukraine — and for one that is there without a price anyone can pay.
 *
 * An answer that is not an object with a `Products` list says nothing about any of them, and is
 * not read as "none of these is sold": it is thrown as the upstream failure it is, so the caller
 * keeps the offers it had.
 */
export function parseMicrosoftProducts(
  body: unknown,
  ids: readonly string[],
  now: number,
): Map<string, MicrosoftProduct | null> {
  const products = asRecord(body)?.Products
  if (!Array.isArray(products)) throw new UpstreamError('MICROSOFT', 'ERROR')

  const found = new Map<string, MicrosoftProduct | null>(ids.map((id) => [id, null]))
  for (const product of products) {
    const id = asRecord(product)?.ProductId
    if (typeof id !== 'string' || !found.has(id.toUpperCase())) continue
    const price = microsoftPurchasePrice(product, now)
    found.set(
      id.toUpperCase(),
      price
        ? {
            price,
            title: microsoftProductTitle(product),
            kind: kindOf(product),
            group: microsoftProductGroup(product),
            releasedAt: microsoftReleasedAt(product),
          }
        : null,
    )
  }
  return found
}

/** A product id as the catalog spells one: twelve letters and digits. */
const PRODUCT_ID = /^[0-9a-z]{12}$/i

/**
 * What the catalog relates a product to, as far as the job follows it.
 *
 * A product that is a bundle names what it contains as its `Parent`s, and a product names every
 * bundle that contains it as a `Bundle`. So from a bundle nobody can buy any more, its parents
 * lead to the content it was made of, and their bundles to every other product made of the same
 * content — the one on sale among them.
 */
export interface MicrosoftRelations {
  /** What the store calls the product; `null` when it states no title. */
  title: string | null
  /** The group the catalog files it under; `null` when it states none. */
  group: string | null
  /** The ids of its `Parent` relations, in the catalog's order, each once. */
  parents: string[]
  /** The ids of its `Bundle` relations, in the catalog's order, each once. */
  bundles: string[]
}

/** The ids one kind of relation names, upper-cased, each once, and only those that are ids. */
function relatedIds(related: unknown, kind: string): string[] {
  if (!Array.isArray(related)) return []
  const ids = related.flatMap((entry) => {
    const relation = asRecord(entry)
    const id = relation?.RelatedProductId
    // An id is about to be part of a request: nothing that is not one is passed on.
    return relation?.RelationshipType === kind && typeof id === 'string' && PRODUCT_ID.test(id)
      ? [id.toUpperCase()]
      : []
  })
  return [...new Set(ids)]
}

/**
 * What one unfiltered answer says about each of the ids it was asked for: the product's title,
 * its group and its relations, or `null` for a product the answer leaves out — one Microsoft does
 * not know for Ukraine.
 *
 * An answer that is not an object with a `Products` list says nothing about any of them, and is
 * thrown as the upstream failure it is, as `parseMicrosoftProducts` throws it.
 */
export function parseMicrosoftRelations(
  body: unknown,
  ids: readonly string[],
): Map<string, MicrosoftRelations | null> {
  const products = asRecord(body)?.Products
  if (!Array.isArray(products)) throw new UpstreamError('MICROSOFT', 'ERROR')

  const found = new Map<string, MicrosoftRelations | null>(ids.map((id) => [id, null]))
  for (const product of products) {
    const id = asRecord(product)?.ProductId
    if (typeof id !== 'string' || !found.has(id.toUpperCase())) continue
    const related = marketProperties(product)?.RelatedProducts
    found.set(id.toUpperCase(), {
      title: microsoftProductTitle(product),
      group: microsoftProductGroup(product),
      parents: relatedIds(related, 'Parent'),
      bundles: relatedIds(related, 'Bundle'),
    })
  }
  return found
}

/** A product the store's search answered with: its id, and what the store calls it. */
export interface MicrosoftSearchResult {
  id: string
  title: string
}

/**
 * The games a search answered with, in the store's order, each once.
 *
 * The answer is `Results[]`, a set a product, each with its `ProductFamilyName` and `Products[]`
 * of `ProductId`, `Type` and `Title`. Only a product of the `Games` family whose `Type` is `Game`
 * is kept — an add-on is a `Durable` — with an id that is one and a title that reads as one. That
 * is a first sieve and no more: the store files an upgrade and a soundtrack under `Game` as well,
 * and what tells them from the game is their title (`titleMatch.ts`).
 *
 * A search that found nothing is `{"Results": []}`, and comes out as no games. An answer that is
 * not an object with a `Results` list says nothing, and is thrown as the upstream failure it is:
 * read as "the store sells nothing by that name", it would put the game's next search off by
 * thirty days.
 */
export function parseMicrosoftSearch(body: unknown): MicrosoftSearchResult[] {
  const results = asRecord(body)?.Results
  if (!Array.isArray(results)) throw new UpstreamError('MICROSOFT', 'ERROR')

  const games = new Map<string, MicrosoftSearchResult>()
  for (const entry of results) {
    const result = asRecord(entry)
    if (result?.ProductFamilyName !== 'Games' || !Array.isArray(result.Products)) continue
    for (const candidate of result.Products) {
      const product = asRecord(candidate)
      const id = product?.ProductId
      const title = storeTitle(product?.Title)
      if (product?.Type !== 'Game' || typeof id !== 'string' || !PRODUCT_ID.test(id)) continue
      if (title === null || games.has(id.toUpperCase())) continue
      games.set(id.toUpperCase(), { id: id.toUpperCase(), title })
    }
  }
  return [...games.values()]
}

/**
 * The name a product's page is addressed by, made from what the store calls the product, for a
 * product RAWG's link did not name: lower case, a hyphen for every space, and nothing but
 * letters, digits and hyphens — "Grand Theft Auto V Enhanced (PC)" is
 * `grand-theft-auto-v-enhanced-pc`. That is how the store's own addresses are made, as far as
 * RAWG's links show them (`forza-horizon-5-standard-edition`).
 *
 * The id is what the address is found by; the name is there because the address has a place for
 * one. A title with nothing left in it — one in another script — is `game`.
 */
export function microsoftProductName(title: string | null): string {
  const name = (title ?? '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200)
    .replace(/-+$/, '')
  return name === '' ? 'game' : name
}

/**
 * The product's page for Ukraine: the address RAWG's own link has — `microsoft.com`, `/p/`, the
 * name and the id — under the Ukrainian locale, where the price is the hryvnia one, and without
 * the tracking query the link came with.
 */
export function microsoftProductUrl(product: NonNullable<IndexedStoreRefs['microsoft']>): string {
  return `https://www.microsoft.com/uk-ua/p/${product.name}/${product.id.toLowerCase()}`
}
