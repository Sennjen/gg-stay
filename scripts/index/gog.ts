import { gogSlugFromUrl, isGogSlug } from './storeRefs'
import {
  asRecord,
  discountPercentOf,
  NO_CACHE,
  STORE_MAX_ATTEMPTS,
  STORE_MIN_INTERVAL_MS,
  storeTitle,
  type StoreUpstreamRuntime,
} from './storeUpstream'
import { createUpstreamFetch } from '../../server/upstream/createUpstreamFetch'
import { safeExternalUrl } from '../../shared/url'

/**
 * What GOG charges a buyer in Ukraine, read from the catalog its own storefront is built on.
 *
 * GOG prices Ukraine in US dollars and has regional prices of its own, so the catalog is asked
 * for `countryCode=UA` and `currencyCode=USD` and the answer is taken as it stands: dollars, in
 * cents, never converted here.
 *
 * **There is no asking for a game.** The catalog has no filter by slug or by id — it ignores both
 * without a word and answers with everything — and its search is a fuzzy match on titles, one
 * request a game. So the price of a set of slugs is read by walking the catalog and matching
 * slugs locally, which is exact: a slug names one product.
 *
 * **What is walked** is `productType=in:game,pack`: games and their editions, without add-ons and
 * extras. That is not only thrift. One query pages through 10 000 products at the most, whatever
 * `productCount` says, and the whole catalog is past that (12 878 on 2026-10-12, against 8 250
 * games and packs); a walk of everything would end at ten thousand and look complete. A hundred a
 * page is the most the endpoint was seen to give without complaint (200 is refused), so a walk is
 * 83 requests, a second apart.
 *
 * **A walk is checked, not trusted** (`walkGogCatalog`), because nothing documents this endpoint
 * and "a product was not in the catalog" is read downstream as "GOG does not sell it". A walk
 * that cannot prove it saw every product it was promised fails whole, and the offers already
 * published stand until the next one.
 *
 * Every fact here was established on 2026-10-12 and is written down in
 * `docs/specs/2026-10-12-other-store-prices-design.md`, "Verified".
 */

const CATALOG_URL = 'https://catalog.gog.com/v1/catalog'

/** Products a page; the most the endpoint answered without refusing the request. */
export const GOG_PAGE_SIZE = 100

/**
 * The most pages a walk will ask for, whatever the catalog says it has: what 10 000 products —
 * all one query can page through — come to at `GOG_PAGE_SIZE`. An answer that claims more is not
 * one this walk can finish, and it says so after one request rather than after a hundred.
 */
export const GOG_MAX_PAGES = 100

/** A page is some 300 kB and was answered in under a second; ten is for a slow day. */
const TIMEOUT_MS = 10_000

/**
 * The query, written out rather than assembled: `:` and `,` are sent as they are, which is how
 * the storefront sends them and how every probe was made. `order=asc:title` because a title does
 * not move when a sale starts in the middle of a walk; popularity and price both do.
 */
function catalogUrl(page: number): string {
  return (
    `${CATALOG_URL}?countryCode=UA&currencyCode=USD&locale=en-US` +
    `&productType=in:game,pack&order=asc:title&limit=${GOG_PAGE_SIZE}&page=${page}`
  )
}

/** One page of the catalog, as GOG answered it. */
export type GogCatalogFetch = (page: number) => Promise<unknown>

/**
 * GOG's share of the shared transport. In fixture mode page 1 is the recorded answer
 * (`tests/fixtures/gog/catalog.json`), which says it is the only page.
 */
export function createGogCatalogFetch(runtime: StoreUpstreamRuntime): GogCatalogFetch {
  const fetchPage = createUpstreamFetch<{ page: number }>(
    {
      source: 'GOG',
      minIntervalMs: STORE_MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: STORE_MAX_ATTEMPTS,
      buildUrl: ({ page }) => catalogUrl(page),
      cacheKey: ({ page }) => `catalog/page-${page}`,
      fixtureName: ({ page }) => (page === 1 ? 'catalog' : `catalog-page-${page}`),
      ttlFor: () => 0,
    },
    { ...runtime, cache: NO_CACHE },
  )
  return (page) => fetchPage({ page })
}

export interface GogPrice {
  /** What is charged now, in cents. */
  amount: number
  /** The price without the discount, in cents; never below `amount`. */
  regularAmount: number
  discountPercent: number
}

/** One product of the catalog, as far as the job reads it. */
export interface GogProduct {
  id: string
  slug: string
  /** What GOG calls the product (`title`), as plain text; `null` when it sent none. */
  title: string | null
  /** `null` when GOG states no price — a game not yet released — or one that cannot be read. */
  price: GogPrice | null
  /** GOG's own address for the product, or `null` when what it sent is not that. */
  url: string | null
}

export interface GogCatalogPage {
  /** How many pages the catalog says this query has. */
  pages: number
  /** How many products it says the query matches. */
  productCount: number
  /** The products a reference could name: those whose slug is a slug (`isGogSlug`). */
  products: GogProduct[]
  /**
   * The ids of the products that are on the page under a slug no game page could have. They are
   * products all the same — the walk counts them, and knows them again by their ids — but nothing
   * else of them is kept, and their slug goes nowhere.
   */
  unnamed: string[]
}

/** A money object's amount in cents, or `null` unless it is `{ amount: "12.34", currency: "USD" }`. */
function centsOf(value: unknown): number | null {
  const money = asRecord(value)
  if (!money || money.currency !== 'USD' || typeof money.amount !== 'string') return null
  const match = /^(\d{1,7})\.(\d{2})$/.exec(money.amount)
  // From the digits, not through a float: "17.49" is 1749, and 17.49 * 100 is 1748.9999999999998.
  return match ? Number(match[1]) * 100 + Number(match[2]) : null
}

/**
 * A product's price, strictly: `finalMoney` and `baseMoney`, both in US dollars — the currency
 * that was asked for — and both amounts as GOG writes them, a decimal string with two places.
 * Anything else is no price: a missing `price` (a game that is not out yet), another currency,
 * an amount that is a number or has one decimal. Never zero by default — a zero here is a game
 * GOG gives away, and only GOG saying `"0.00"` makes one.
 *
 * The discount is counted from the two amounts rather than read from GOG's label (`"-40%"`); the
 * two agreed on every discounted product checked, and the amounts are what a visitor is shown.
 */
export function parseGogPrice(value: unknown): GogPrice | null {
  const price = asRecord(value)
  if (!price) return null
  const amount = centsOf(price.finalMoney)
  const base = centsOf(price.baseMoney)
  if (amount === null || base === null) return null
  const regularAmount = Math.max(amount, base)
  return { amount, regularAmount, discountPercent: discountPercentOf(amount, regularAmount) }
}

/** GOG's `storeLink`, when it is a safe link to the game page of this very slug; else `null`. */
function storeLinkOf(value: unknown, slug: string): string | null {
  const url = safeExternalUrl(typeof value === 'string' ? value : null)
  return url !== null && gogSlugFromUrl(url) === slug ? url : null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * One page as the walk needs it, or an `Error` saying what was wrong with it. A page has to be an
 * object with `pages`, `productCount` and a `products` list in which every entry has an id and a
 * slug: a page that is anything less cannot be counted, and a walk that cannot be counted cannot
 * tell a product GOG does not sell from one it failed to read.
 *
 * A product's price, link and title are read leniently in the other direction: one that cannot
 * be read is a product without it, never a page that failed.
 *
 * **A slug is kept only if it is one** (`isGogSlug`: lower-case letters, digits, underscores).
 * Every slug of the catalog that was ever seen is, and a reference can hold no other, so a
 * product under anything else could never be matched: it is counted, for the walk's proof, and
 * dropped (`unnamed`). That is also what keeps a store's raw text out of the job's log. A slug is
 * the one thing of GOG's this module ever prints — in the error about a product that came twice
 * — and the log is a runner's standard output, where a line break followed by `::` begins a
 * command. What is printed is therefore always text this job could have written itself.
 */
export function parseGogCatalogPage(body: unknown): GogCatalogPage {
  const page = asRecord(body)
  if (!page) throw new Error('GOG answered a catalog page that is not an object')
  const { pages, productCount, currentlyShownProductCount: shown, products } = page
  if (!isCount(pages) || !isCount(productCount) || !Array.isArray(products)) {
    throw new Error('GOG answered a catalog page without its counts or its products')
  }
  // The ceiling of what one query pages through. Past it the last products are never served,
  // and the walk would be short of them without knowing.
  if (isCount(shown) && shown < productCount) {
    throw new Error(
      `GOG lists ${productCount} products and pages through ${shown} of them: ` +
        'the catalog has outgrown one walk',
    )
  }

  const named: GogProduct[] = []
  const unnamed: string[] = []
  for (const entry of products) {
    const product = asRecord(entry)
    const id = product?.id
    const slug = product?.slug
    if (typeof id !== 'string' || id === '' || typeof slug !== 'string' || slug === '') {
      throw new Error('GOG answered a catalog page with a product that has no id or no slug')
    }
    if (!isGogSlug(slug)) {
      unnamed.push(id)
      continue
    }
    named.push({
      id,
      slug,
      title: storeTitle(product!.title),
      price: parseGogPrice(product!.price),
      url: storeLinkOf(product!.storeLink, slug),
    })
  }
  return { pages, productCount, products: named, unnamed }
}

export interface GogCatalogWalk {
  /** Every product of the catalog, by slug. */
  products: Map<string, GogProduct>
  /** Requests the walk made: one a page. */
  pages: number
}

/**
 * Walks the catalog from the first page to the last and returns it whole, or throws.
 *
 * "Whole" is proved, page by page and at the end:
 *
 * - every page repeats the first page's `pages` and `productCount` — a catalog that changed size
 *   under the walk has shifted, and a product may have slipped between two pages unseen;
 * - no id and no slug comes twice — the other sign of a shift, and a slug that named two products
 *   would not name a price;
 * - the products received number exactly `productCount`.
 *
 * A product was added to GOG during a two-minute walk perhaps once in a hundred walks; that walk
 * fails, nothing is published from it, and the next run walks again. The alternative is a walk
 * that quietly loses a game's price for half a day, and nobody could tell which.
 *
 * What this does not prove: that nothing changed. One product removed before the walk's position
 * and another added after it, both inside the same second between two requests, leave the count
 * as it was and repeat nothing, and the product that slid across the page boundary is never
 * seen. It takes two changes of the catalog in one second of a two-minute walk, it costs one game
 * its GOG price until the next read, and no check that is cheaper than a second walk catches it.
 *
 * `onPage` is called after each page, for a caller that has a lock to keep alive.
 */
export async function walkGogCatalog(
  fetchPage: GogCatalogFetch,
  onPage: () => Promise<void> = async () => {},
): Promise<GogCatalogWalk> {
  const first = parseGogCatalogPage(await fetchPage(1))
  if (first.pages < 1 || first.productCount < 1) {
    throw new Error('GOG answered a catalog with no products in it')
  }
  if (first.pages > GOG_MAX_PAGES) {
    throw new Error(`GOG answered a catalog of ${first.pages} pages, more than one walk covers`)
  }

  const products = new Map<string, GogProduct>()
  const ids = new Set<string>()
  let received = 0

  for (let number = 1; number <= first.pages; number += 1) {
    const page = number === 1 ? first : parseGogCatalogPage(await fetchPage(number))
    if (page.pages !== first.pages || page.productCount !== first.productCount) {
      throw new Error(`the GOG catalog changed size during the walk, at page ${number}`)
    }
    for (const product of page.products) {
      if (ids.has(product.id) || products.has(product.slug)) {
        throw new Error(`the GOG catalog repeated ${product.slug} at page ${number}`)
      }
      ids.add(product.id)
      products.set(product.slug, product)
    }
    for (const id of page.unnamed) {
      // Named by nothing of GOG's own: its slug is the reason it is here, and is not printed.
      if (ids.has(id)) throw new Error(`the GOG catalog repeated a product at page ${number}`)
      ids.add(id)
    }
    received += page.products.length + page.unnamed.length
    await onPage()
  }

  if (received !== first.productCount) {
    throw new Error(
      `the GOG catalog promised ${first.productCount} products and the walk received ${received}`,
    )
  }
  return { products, pages: first.pages }
}
