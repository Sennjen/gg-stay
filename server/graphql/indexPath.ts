import { MAX_SEARCH_LENGTH } from '../../shared/catalog'
import type { IndexMeta } from '../index/document'
import type { IndexQuery } from '../index/GameIndex'
import { toLocalisationInfo, toPriceSummary } from '../index/toGraphql'
import type { GraphQLContext } from './context'
import type { GameCard, GameFilter, GameSort } from './__generated__/resolvers-types'

/**
 * The rules every resolver shares about the price and localisation index: which path answers a
 * request, how old the index is allowed to be, how a filter becomes an index query, and how a
 * RAWG-served page gets its prices attached.
 *
 * Three things are per request rather than per call, and all live in `requestState` below: the
 * index metadata (`meta()` is read once, however many pages one operation asks for); the "the
 * index let us down" warning, which is logged once so a failing store cannot fill the log with
 * one line per field resolver; and the fact of that failure, which stops every later index call
 * in the same request before it is made. One request pays at most one deadline, and the process
 * itself then skips the index for half a minute (`withCircuit`), so a dead store costs a page
 * almost nothing.
 */

/**
 * Index filters that stand or fall with the prices: each one reads a facet or a range the price
 * stage of a run fills. A stale index drops them and names them.
 */
export const PRICE_FILTER_FIELDS = ['priceMaxUah', 'free', 'onSaleMinPercent'] as const

/**
 * Index filters that do not depend on a price at all. Languages are refreshed weekly and the
 * made-in-Ukraine list is editorial, so a price stage that stopped running does not make either
 * of them wrong — they keep taking the index path, and keep their badges, while prices are
 * withheld.
 */
export const INDEX_FACET_FILTER_FIELDS = ['ukrainianLocalisation', 'madeInUkraine'] as const

/** Filters only RAWG can apply. The index has no developer, publisher or tag facet. */
export const RAWG_ONLY_FILTER_FIELDS = ['developers', 'publishers', 'tags'] as const

/** Sorts only the index can order by. */
export const INDEX_SORTS: readonly GameSort[] = ['PRICE_ASC', 'PRICE_DESC', 'DISCOUNT_DESC']

/** `ignoredFilters` names the sort as well, because a dropped sort changes the page just as much. */
export const SORT_FIELD_NAME = 'sort'

/** Past this age the index is not trusted with a price: a stale price is worse than none. */
export const INDEX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** How long an index-served page is kept, keyed by the filter, the sort, the page and the version. */
export const PAGE_CACHE_TTL_SECONDS = 600

const PAGE_CACHE_PREFIX = 'index-page'

export interface IndexState {
  meta: IndexMeta | null
  /** The prices are older than `INDEX_STALE_AFTER_MS`, or the index has none at all. */
  stale: boolean
  /** What `indexUpdatedAt` reports: when the prices were last refreshed, not when a run last ran. */
  updatedAt: string | null
  version: number | null
}

interface RequestState {
  index?: Promise<IndexState>
  warned: boolean
  failed: boolean
}

// Keyed by the context object, which yoga builds once per request.
const requestStates = new WeakMap<GraphQLContext, RequestState>()

function requestState(context: GraphQLContext): RequestState {
  let state = requestStates.get(context)
  if (!state) {
    state = { warned: false, failed: false }
    requestStates.set(context, state)
  }
  return state
}

/**
 * One line per request, at warn level, naming what failed and nothing else — never a URL, never a
 * token. The index is an enhancement: everything that calls this has already fallen back.
 */
export function warnIndexOnce(context: GraphQLContext, what: string, error: unknown): void {
  const state = requestState(context)
  state.failed = true
  if (state.warned) return
  state.warned = true
  const reason = error instanceof Error ? error.message : 'unknown error'
  console.warn(`[index] ${what}: ${reason}`)
}

/**
 * Whether the index has already let this request down. Every entry point checks it first: once
 * one call has timed out, the remaining ones would each cost another deadline to learn the same
 * thing, and a page that is already rendering without prices has nothing left to gain from them.
 */
export function indexFailed(context: GraphQLContext): boolean {
  return requestState(context).failed
}

/** The index metadata, read once per request. An index that cannot answer is simply not stale. */
export function indexState(context: GraphQLContext): Promise<IndexState> {
  const state = requestState(context)
  state.index ??= readIndexState(context)
  return state.index
}

const NO_INDEX: IndexState = { meta: null, stale: false, updatedAt: null, version: null }

async function readIndexState(context: GraphQLContext): Promise<IndexState> {
  if (indexFailed(context)) return NO_INDEX
  let meta: IndexMeta | null = null
  try {
    meta = await context.index.meta()
  } catch (error) {
    warnIndexOnce(context, 'the index metadata could not be read', error)
  }
  if (!meta) return NO_INDEX
  // Staleness is measured on `pricesUpdatedAt`, never on `updatedAt`: every publication moves the
  // latter, while the former only moves when a price stage actually got its answers. A run that
  // keeps publishing while Steam refuses to answer would otherwise look perpetually fresh. An
  // index that has published without ever pricing anything is stale by the same rule.
  const pricesUpdatedAt = meta.pricesUpdatedAt
  const age = pricesUpdatedAt === null ? NaN : Date.parse(context.now) - Date.parse(pricesUpdatedAt)
  return {
    meta,
    stale: !Number.isFinite(age) || age > INDEX_STALE_AFTER_MS,
    updatedAt: pricesUpdatedAt,
    version: meta.version,
  }
}

function has(value: unknown): boolean {
  return value !== undefined && value !== null
}

/**
 * The names of the price-dependent things this request asked for: the price filters it set, plus
 * `sort` when it asked for a price or discount order. An unchecked box narrows nothing, so
 * `free: false` is not a filter — exactly as `planQuery` reads it.
 */
export function priceFiltersUsed(filter: GameFilter | null | undefined, sort: GameSort): string[] {
  const used: string[] = []
  if (filter) {
    if (has(filter.priceMaxUah)) used.push('priceMaxUah')
    if (filter.free === true) used.push('free')
    if (has(filter.onSaleMinPercent)) used.push('onSaleMinPercent')
  }
  if (INDEX_SORTS.includes(sort)) used.push(SORT_FIELD_NAME)
  return used
}

/** The names of the index filters that keep working when the prices have gone stale. */
export function indexFacetFiltersUsed(filter: GameFilter | null | undefined): string[] {
  if (!filter) return []
  const used: string[] = []
  if (has(filter.ukrainianLocalisation)) used.push('ukrainianLocalisation')
  if (filter.madeInUkraine === true) used.push('madeInUkraine')
  return used
}

/** The filter with everything a stale index may not answer taken out of it. */
export function withoutPriceFilters(filter: GameFilter | null | undefined): GameFilter | null {
  if (!filter) return filter ?? null
  const { priceMaxUah: _p, free: _f, onSaleMinPercent: _o, ...rest } = filter
  return rest
}

/** The same cards with their prices withheld, for a page a stale index served. */
export function withoutPrices(cards: GameCard[]): GameCard[] {
  return cards.map((card) => (card.price === null ? card : { ...card, price: null }))
}

/** The names of the filters the index has no facet for, when the index is the one answering. */
export function rawgOnlyFiltersUsed(filter: GameFilter | null | undefined): string[] {
  if (!filter) return []
  return RAWG_ONLY_FILTER_FIELDS.filter((field) => (filter[field] ?? []).length > 0)
}

/**
 * The values of one facet in a fixed order, so two URLs that differ only in the order of a
 * multi-select are one query and one cache entry. Numbers are compared as numbers: `Array.sort`'s
 * default compares them as strings, which would order platform 187 before platform 4 — harmless
 * for an OR group, misleading in a cache key someone will one day read.
 */
function sorted<T extends string | number>(
  values: readonly T[] | null | undefined,
): T[] | undefined {
  if (!values || values.length === 0) return undefined
  return [...values].sort((left, right) =>
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right)),
  )
}

function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value
}

/**
 * The whole filter as an index query — every field the index can express, not only the ones that
 * chose this path. The array facets are sorted, so two URLs that differ only in the order of a
 * multi-select are one query and one cache entry.
 */
export function toIndexQuery(input: {
  filter?: GameFilter | null
  sort: GameSort
  page: number
  pageSize: number
  today: string
}): IndexQuery {
  const filter = input.filter ?? {}
  const search = filter.search?.trim().slice(0, MAX_SEARCH_LENGTH)
  return {
    search: search || undefined,
    genres: sorted(filter.genres),
    platforms: sorted(filter.platforms),
    stores: sorted(filter.stores),
    gameModes: sorted(filter.gameModes),
    ageRating: sorted(filter.ageRating),
    yearFrom: orUndefined(filter.yearFrom),
    yearTo: orUndefined(filter.yearTo),
    upcoming: filter.upcoming ?? undefined,
    today: input.today,
    playtime: orUndefined(filter.playtime),
    metacriticMin: orUndefined(filter.metacriticMin),
    ratingMin: orUndefined(filter.ratingMin),
    priceMaxUah: orUndefined(filter.priceMaxUah),
    free: filter.free ?? undefined,
    onSaleMinPercent: orUndefined(filter.onSaleMinPercent),
    ukrainianLocalisation: orUndefined(filter.ukrainianLocalisation),
    madeInUkraine: filter.madeInUkraine ?? undefined,
    sort: input.sort,
    page: input.page,
    pageSize: input.pageSize,
  }
}

/**
 * The cache key of an index-served page. The published version is part of it, so a publication
 * invalidates every cached page by itself — nothing has to be swept.
 */
export function pageCacheKey(query: IndexQuery, version: number | null): string {
  return `${PAGE_CACHE_PREFIX}:${JSON.stringify({ version, ...query })}`
}

export interface CachedIndexPage {
  items: GameCard[]
  total: number
}

/**
 * Prices, localisation and the made-in-Ukraine flag for cards RAWG produced — one `getMany` for
 * the whole page, whatever a page is made of. A game the index does not hold keeps the nulls the
 * card mapper gave it. Prices are withheld when the index is stale; the language list is not.
 */
export async function attachIndexData(
  context: GraphQLContext,
  cards: GameCard[],
  options: { prices: boolean },
): Promise<void> {
  if (cards.length === 0 || indexFailed(context)) return
  const ids = [...new Set(cards.map((card) => Number(card.id)))].filter((id) => Number.isFinite(id))
  if (ids.length === 0) return

  let documents
  try {
    documents = await context.index.getMany(ids)
  } catch (error) {
    // Never fatal: the page renders without prices, exactly as it does for a game the index has
    // never seen.
    warnIndexOnce(context, 'prices could not be attached to the page', error)
    return
  }

  for (const card of cards) {
    const document = documents.get(Number(card.id))
    if (!document) continue
    card.price = options.prices ? toPriceSummary(document) : null
    card.localisation = toLocalisationInfo(document)
    card.madeInUkraine = document.madeInUkraine
  }
}
