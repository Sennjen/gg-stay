import type { GameSortValue } from '#shared/catalog'
import type { GamesQuery } from '~/graphql/__generated__/operations'
import {
  DEFAULT_SORT,
  parseFilterQuery,
  serializeFilterState,
  type CatalogFilter,
} from '~/utils/filterUrl'

/**
 * The page side of `POST /api/ask`: the answer's shape, and the pure rules that turn whatever the
 * endpoint sent into something the page can render without trusting it — the endpoint is a model
 * pipeline, and a page that renders its output verbatim is one bad answer away from a broken grid.
 */

/** The longest question the endpoint accepts, in characters after trimming. */
export const ASK_MAX_LENGTH = 200

/** The longest interpretation the endpoint sends, in characters; the page holds it to that. */
export const ASK_INTERPRETATION_MAX = 200
/** The longest reason the endpoint sends (80) with room to spare; the page holds it to that. */
export const ASK_REASON_MAX = 120

/** Exactly what a catalog card renders, so the answer's cards go through `GameCard` unchanged. */
export type AskCard = GamesQuery['games']['items'][number]

export interface AskItem {
  card: AskCard
  /** One line on why this game fits, in the question's language; null when there is none. */
  reason: string | null
}

export interface AskAnswer {
  /** `fallback`: the model did not run or failed, and the items are a plain text search. */
  mode: 'structured' | 'fallback'
  /** One sentence on what was searched for; null in fallback. */
  interpretation: string | null
  /** The understood filter, already narrowed to what the catalog's URL layer accepts. */
  filter: CatalogFilter
  catalogUrl: string
  items: AskItem[]
  /**
   * The fields of `filter` (and `sort`, which only `catalogUrl` carries) the catalog could not
   * apply to these cards — `GamePage.ignoredFilters`, with the same names.
   */
  ignoredFilters: string[]
  /**
   * The catalog page the cards came from had stale prices (`GamePage.indexStale`): why a price
   * filter is among `ignoredFilters`. `false` when no page answered.
   */
  indexStale: boolean
  /**
   * The cards came from the price index alone — its most popular games and every Ukrainian
   * studio's — not from the whole catalog (`GamePage.indexedOnly`); the page says so with the
   * catalog's own note. `false` when no page answered.
   */
  indexedOnly: boolean
  tookMs: number
}

/** The question as the route carries it: the first `q` value, trimmed. Never cut. */
export function normaliseAskQuery(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Seconds to wait, from a `Retry-After` header. Only the delta-seconds form is read: the HTTP-date
 * form would need a clock read to turn into "in N seconds", and the page says "in a minute"
 * instead. Zero is reported as one, because "try again in 0 seconds" reads like a bug.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  const raw = value?.trim()
  if (!raw || !/^\d{1,6}$/.test(raw)) return null
  return Math.max(Number(raw), 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The answer's filter as the catalog would read it from its own URL: serialised and parsed back
 * through the same functions `/games` uses, so an unknown enum, a malformed slug or an
 * out-of-range number is dropped here exactly as it would be from a hand-edited link, and the
 * chips can only ever show what the catalog link would apply.
 */
export function toCatalogFilter(filter: unknown): CatalogFilter {
  if (!isRecord(filter)) return {}
  try {
    const query = serializeFilterState({
      filter: filter as CatalogFilter,
      sort: DEFAULT_SORT,
      page: 1,
    })
    return parseFilterQuery(query).filter
  } catch {
    // A field of the wrong type (`genres: "action"`) makes the serialiser throw: nothing usable.
    return {}
  }
}

const CATALOG_PATH = /^(?:\/en)?\/games\/?$/

/**
 * The query of the "Open in the catalog" link. The path is always the page's own localised
 * `/games` (the caller adds it), and the query is re-validated through the URL layer, so the link
 * can neither leave the site nor carry anything the catalog would not read. A `catalogUrl` that
 * is not a catalog URL at all falls back to the answer's own filter.
 */
export function askCatalogQuery(catalogUrl: string, filter: CatalogFilter): Record<string, string> {
  let url: URL | null
  try {
    url = new URL(catalogUrl, 'http://catalog.invalid')
  } catch {
    url = null
  }
  if (url && /^https?:$/.test(url.protocol) && CATALOG_PATH.test(url.pathname)) {
    const state = parseFilterQuery(Object.fromEntries(url.searchParams))
    return serializeFilterState({ ...state, page: 1 })
  }
  return serializeFilterState({ filter, sort: DEFAULT_SORT, page: 1 })
}

/** Trimmed text, at most `max` characters (counted in code points), or null when there is none. */
function textOrNull(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? Array.from(text).slice(0, max).join('') : null
}

/**
 * A card as the endpoint sends it: the server's `GameCard`, a superset of what `GameCard.vue`
 * renders, so it is passed through untouched. Only an item with no card at all is dropped.
 */
function toCard(value: unknown): AskCard | null {
  if (!isRecord(value)) return null
  const { id, slug, name } = value
  if (typeof id !== 'string' || typeof slug !== 'string' || typeof name !== 'string') return null
  return value as unknown as AskCard
}

/** The answer, checked and normalised; null when it is not an answer at all. */
export function normaliseAskAnswer(raw: unknown): AskAnswer | null {
  if (!isRecord(raw)) return null
  if (raw.mode !== 'structured' && raw.mode !== 'fallback') return null
  if (!Array.isArray(raw.items)) return null
  const filter = toCatalogFilter(raw.filter)
  const items = (raw.items as unknown[]).flatMap((item): AskItem[] => {
    if (!isRecord(item)) return []
    const card = toCard(item.card)
    return card ? [{ card, reason: textOrNull(item.reason, ASK_REASON_MAX) }] : []
  })
  const ignoredFilters = Array.isArray(raw.ignoredFilters)
    ? (raw.ignoredFilters as unknown[]).filter((name): name is string => typeof name === 'string')
    : []
  return {
    mode: raw.mode,
    interpretation: textOrNull(raw.interpretation, ASK_INTERPRETATION_MAX),
    filter,
    catalogUrl: typeof raw.catalogUrl === 'string' ? raw.catalogUrl : '',
    items,
    ignoredFilters,
    indexStale: raw.indexStale === true,
    indexedOnly: raw.indexedOnly === true,
    tookMs: typeof raw.tookMs === 'number' ? raw.tookMs : 0,
  }
}

/** The sort the answer's catalog URL asked for and the catalog could not apply, or null. */
export function askIgnoredSort(
  catalogUrl: string,
  ignored: readonly string[],
): GameSortValue | null {
  if (!ignored.includes('sort')) return null
  try {
    const { sort } = parseFilterQuery(
      Object.fromEntries(new URL(catalogUrl, 'http://catalog.invalid').searchParams),
    )
    return sort === DEFAULT_SORT ? null : sort
  } catch {
    return null
  }
}
