import type {
  AgeRatingValue,
  GameModeValue,
  GameSortValue,
  LocalisationValue,
  PlaytimeValue,
} from '../../shared/catalog'
import type { IndexMeta, IndexedGame, IndexedLanguages } from './document'

/**
 * The port the catalog reads the price and localisation index through, and the port the refresh
 * job writes it through. Both are implemented twice — in memory for tests, development and CI,
 * and over Upstash Redis in production — and one contract suite holds both to the semantics
 * written here.
 *
 * Query semantics, identical in every adapter:
 * - Values selected inside one facet are OR-ed; facets are AND-ed with each other. `free: false`
 *   narrows nothing, like an unchecked box.
 * - Every range is inclusive on both bounds.
 * - `ukrainianLocalisation: ANY` matches Ukrainian text or Ukrainian audio; `TEXT` matches the
 *   text set and `AUDIO` the audio set, neither implying the other.
 * - Games whose price is unknown are excluded whenever the sort is `PRICE_ASC`, `PRICE_DESC` or
 *   `DISCOUNT_DESC`, or whenever a price or discount filter is set. Free games count as priced:
 *   `free: true` matches them, and so does `priceMaxUah`. Games without a release date are
 *   likewise absent from the release-date sorts and range.
 *   Games without a rating or a Metacritic score are NOT excluded from those sorts — they are
 *   ordered last, at zero — which differs from the RAWG path, where `metacritic=70,100` drops
 *   them. A caller that mixes the two paths has to know this.
 * - `total` is exact; a page past the end returns no ids and the same total. The page size is
 *   clamped to `MAX_PAGE_SIZE` and the page to `MAX_PAGE`.
 * - Ties on the sort score are broken by popularity and then by id, in both directions, so paging
 *   is stable. The writer bakes that order into the rank scores of the order sets
 *   (`server/index/buildPlan.ts`), because a store cannot be asked to sort by our rule.
 * - `search` is a case-insensitive substring of the name, applied to the ordered ids before
 *   paging, so the total stays exact. It is executed by reading the version's folded names — one
 *   key, `namesKey(version)` — matching in the application and intersecting the matches with the
 *   rest of the query: two round trips when a query searches, one when it does not. Matching
 *   3 000 short strings in the process is cheaper than any alternative Upstash offers, and the
 *   names key is immutable for the life of a version, so it caches.
 *
 * A read is served by whatever version `idx:current` points at when it starts. `search` followed
 * by `getMany` can therefore straddle a publication: the second call may miss ids the first one
 * returned. The catalog treats a missing document as "this game is not in the index", which is
 * exactly how it treats a game outside the 3 000.
 */

export type LocalisationFilter = LocalisationValue

export interface IndexQuery {
  search?: string
  genres?: string[]
  platforms?: number[]
  stores?: string[]
  gameModes?: GameModeValue[]
  ageRating?: AgeRatingValue[]
  yearFrom?: number
  yearTo?: number
  /** Released strictly after `today`; planning it without `today` throws. */
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
 * The write side, used by the refresh job.
 *
 * A run calls `beginVersion`, then `writeVersion` with every game it indexed — the whole set at
 * once, because the order sets are ranked across all of them — and ends with `publish`, which
 * moves the pointer in one step and marks the version it replaced for expiry. Until then readers
 * see only the previous version. A run that fails its own checks (the design refuses a run that
 * ends below half the previous game count) calls `discardVersion` instead, so a refused run leaves
 * nothing behind; `meta()` is what that check reads, and `previousMeta()` reports the version the
 * last publish replaced.
 *
 * A run takes the write lock when it begins a version and gives it back when it publishes or
 * discards. A second run that finds the lock held is refused, and told who holds it and for how
 * long; `beginVersion({ force: true })` takes over a lock that has been held past the adapter's
 * limit, which is how an operator recovers from a run that died holding it.
 *
 * Three edges a retried run runs into. Publishing the version that is already live only refreshes
 * its metadata — it does not make that version its own predecessor, and none of its keys are set
 * to expire. Discarding the live version is refused, because that would empty the index. Rewriting
 * the live version is refused for the same reason: `writeVersion` replaces a version whole, so it
 * would empty the index before filling it again, and readers would see it half-written.
 *
 * App ids and cursors live outside the version and survive publications, so a Steam app id is
 * resolved once in the life of the index. Both are batched: a run touches 3 000 games and a REST
 * round trip per game is not affordable.
 */
export interface BeginVersionOptions {
  /**
   * Take over a write lock that has been held longer than the adapter allows. Only a human sets
   * this, through the workflow's `force_unlock` input, after a run died holding the lock.
   */
  force?: boolean
}

/** What one run cost the store, when the adapter counts it. Reported in the job summary. */
export interface IndexWriteStats {
  /** HTTP requests made to the store. */
  requests: number
  /** Redis commands sent inside them. */
  commands: number
  /** Bytes of command payload written, as the request bodies measure them. */
  bytes: number
}

export interface GameIndexWriter {
  beginVersion(options?: BeginVersionOptions): Promise<number>
  writeVersion(version: number, games: IndexedGame[]): Promise<void>
  publish(version: number, meta: IndexMeta): Promise<void>
  /** Drops the draft and releases the writer lock, whether or not the draft is known. */
  discardVersion(version: number): Promise<void>
  /**
   * Gives this run's write lock a fresh life without changing what it holds, and does nothing
   * when the run does not hold it. `writeVersion` refreshes the lock as it goes, but every long
   * stage of a refresh — the candidate walk, the app-id lookups, the hour-long language sweep —
   * happens before `writeVersion` is reached, so the job renews the lock itself between stages
   * and between batches. Without it the lock's life would have to cover a whole run, and a run
   * that died would block the next one for that long.
   */
  renewLock(): Promise<void>
  currentVersion(): Promise<number | null>
  /** The published version's meta — the blue/green check compares against it. */
  meta(): Promise<IndexMeta | null>
  /** The meta of the version the last publish replaced, or `null` when there was none. */
  previousMeta(): Promise<IndexMeta | null>
  /**
   * Every document of the published version, in no particular order; empty when nothing is
   * published. `--mode=prices` and `--mode=languages` rebuild from these, so they never ask RAWG
   * for a catalog they already hold.
   */
  allGames(): Promise<IndexedGame[]>
  /** Only the ids that were resolved appear; the empty string means "has no Steam app id". */
  getAppIds(ids: number[]): Promise<Map<number, string>>
  setAppIds(entries: Iterable<[number, string]>): Promise<void>
  /**
   * Steam language records by app id, outside the version prefix. Only the app ids that have a
   * record appear. The refresh job's work list is "no record, or a record older than a week", so
   * every app the job reads is saved the moment it is read and no run repeats another's work.
   */
  getLanguages(appIds: string[]): Promise<Map<string, IndexedLanguages>>
  setLanguages(entries: Iterable<[string, IndexedLanguages]>): Promise<void>
  getCursor(stage: string): Promise<string | null>
  setCursor(stage: string, cursor: string): Promise<void>
  clearCursor(stage: string): Promise<void>
  /**
   * What this adapter has written since it was created, when it counts — the job prints it in the
   * summary so the free tier's command and storage budgets can be watched. Optional: an adapter
   * that counts nothing simply does not implement it.
   */
  stats?(): IndexWriteStats | null
}

export const DEFAULT_SORT: GameSortValue = 'POPULARITY_DESC'
