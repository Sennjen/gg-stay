import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  type AgeRatingValue,
  type GameModeValue,
  type GameSortValue,
  type PlaytimeValue,
} from '../../shared/catalog'
import type { IndexMeta, IndexedGame } from './document'

/**
 * The port the catalog reads the price and localisation index through, and the port the refresh
 * job writes it through. Both are implemented twice — in memory for tests, development and CI,
 * and over Upstash Redis in production — and one contract suite holds both to the semantics
 * written here.
 *
 * Query semantics, identical in every adapter:
 * - Values selected inside one facet are OR-ed; facets are AND-ed with each other.
 * - Every range is inclusive on both bounds.
 * - `ukrainianLocalisation: ANY` matches Ukrainian text or Ukrainian audio; `TEXT` matches the
 *   text set and `AUDIO` the audio set, neither implying the other.
 * - Games whose price is unknown are excluded whenever the sort is `PRICE_ASC`, `PRICE_DESC` or
 *   `DISCOUNT_DESC`, or whenever a price or discount filter is set. Free games count as priced:
 *   `free: true` matches them, and so does `priceMaxUah`.
 *   Games without a release date are likewise absent from the release-date sorts and range.
 * - `search` is a case-insensitive substring match on the name, applied to the ordered ids before
 *   paging.
 * - `total` is exact; a page past the end returns no ids and the same total.
 * - Ties on the sort score are broken by popularity and then by id, so paging is stable.
 */

export type LocalisationFilter = 'ANY' | 'TEXT' | 'AUDIO'

export interface IndexQuery {
  search?: string
  genres?: string[]
  platforms?: number[]
  stores?: string[]
  gameModes?: GameModeValue[]
  ageRating?: AgeRatingValue[]
  yearFrom?: number
  yearTo?: number
  /** Released after `today`; ignored when `today` is missing. */
  upcoming?: boolean
  /** ISO date the `upcoming` filter is measured against; no adapter reads a clock. */
  today?: string
  playtime?: PlaytimeValue
  metacriticMin?: number
  ratingMin?: number
  priceMaxUah?: number
  free?: boolean
  onSaleMinPercent?: number
  ukrainianLocalisation?: LocalisationFilter
  madeInUkraine?: boolean
  sort?: GameSortValue
  page?: number
  pageSize?: number
}

export interface IndexSearchResult {
  /** The ids of the requested page, in sort order. */
  ids: number[]
  /** The exact number of matches, not only the ones on this page. */
  total: number
  /** The card documents of `ids`, in the same order. */
  games: IndexedGame[]
}

/** The read side: everything a request needs from a published version. */
export interface GameIndex {
  search(query: IndexQuery): Promise<IndexSearchResult>
  getMany(ids: number[]): Promise<Map<number, IndexedGame>>
  getOne(id: number): Promise<IndexedGame | null>
  meta(): Promise<IndexMeta | null>
}

/**
 * The write side, used by the refresh job. A run calls `beginVersion`, writes with `putGames` as
 * often as it likes and ends with `publish`, which swaps the live version in one step; until then
 * readers see only the previous version. App ids and cursors live outside the version and survive
 * publications, so a resolved Steam app id is never resolved twice.
 */
export interface GameIndexWriter {
  beginVersion(): Promise<number>
  putGames(version: number, games: IndexedGame[]): Promise<void>
  publish(version: number, meta: IndexMeta): Promise<void>
  currentVersion(): Promise<number | null>
  /** `null` when the game was never resolved; the empty string when it has no Steam app id. */
  getAppId(rawgId: number): Promise<string | null>
  setAppId(rawgId: number, appId: string): Promise<void>
  getCursor(stage: string): Promise<string | null>
  setCursor(stage: string, cursor: string): Promise<void>
}

export const DEFAULT_SORT: GameSortValue = 'POPULARITY_DESC'

/** The paging an adapter applies: the same clamps the GraphQL layer uses. */
export function resolvePaging(query: IndexQuery): { page: number; pageSize: number } {
  const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const page = Math.min(Math.max(query.page ?? 1, 1), MAX_PAGE)
  return { page, pageSize }
}

/** Whether the query constrains price or discount, which excludes games without a price. */
export function hasPriceConstraint(query: IndexQuery): boolean {
  const sort = query.sort ?? DEFAULT_SORT
  return (
    query.priceMaxUah !== undefined ||
    query.onSaleMinPercent !== undefined ||
    query.free === true ||
    sort === 'PRICE_ASC' ||
    sort === 'PRICE_DESC' ||
    sort === 'DISCOUNT_DESC'
  )
}

/** Case-insensitive substring match on the name, the only text search the index offers. */
export function matchesSearch(name: string, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase()
  if (!needle) return true
  return name.toLowerCase().includes(needle)
}
