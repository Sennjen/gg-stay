import type {
  GameIndex,
  GameIndexWriter,
  IndexQuery,
  IndexSearchResult,
  LocalisationFilter,
} from './GameIndex'
import { DEFAULT_SORT, hasPriceConstraint, matchesSearch, resolvePaging } from './GameIndex'
import type { IndexMeta, IndexSortField, IndexedGame } from './document'
import { INDEX_SORT_FIELDS, nameRanks, releasedScore, sortScoreOf } from './document'
import {
  ageRatingFacetKey,
  facetKeysOf,
  freeFacetKey,
  gameModeFacetKey,
  genreFacetKey,
  localisationFacetKey,
  madeInUkraineFacetKey,
  platformFacetKey,
  playtimeFacetKey,
  pricedFacetKey,
  sortDescendingOf,
  sortFieldOf,
  storeFacetKey,
} from './keys'

/**
 * The in-memory adapter: the same faceted model as the Upstash one, built out of `Set`s and
 * sorted arrays instead of Redis sets and sorted sets. A query unions the values inside a facet,
 * intersects the facets, cuts the ranges out of the sorted arrays by binary search and then walks
 * the sort order — the shape of the Redis pipeline, not a linear scan over every game. That is
 * what makes the shared contract suite worth running against it.
 *
 * It serves tests, development without Upstash credentials and CI. Everything lives in the
 * process, so a restart empties it.
 */

interface ScoredId {
  id: number
  score: number
}

interface SortOrder {
  ascending: ScoredId[]
  descending: ScoredId[]
}

interface PublishedVersion {
  version: number
  games: Map<number, IndexedGame>
  facets: Map<string, Set<number>>
  orders: Map<IndexSortField, SortOrder>
  meta: IndexMeta
}

const EMPTY_RESULT: IndexSearchResult = { ids: [], total: 0, games: [] }

function clone(game: IndexedGame): IndexedGame {
  return JSON.parse(JSON.stringify(game)) as IndexedGame
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** First index whose score is at least `min`, by binary search over the ascending array. */
function lowerBound(entries: ScoredId[], min: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle]!.score < min) low = middle + 1
    else high = middle
  }
  return low
}

/** First index whose score is greater than `max`. */
function upperBound(entries: ScoredId[], max: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle]!.score <= max) low = middle + 1
    else high = middle
  }
  return low
}

function byScoreThenPopularity(
  popularity: Map<number, number>,
  descending: boolean,
): (left: ScoredId, right: ScoredId) => number {
  return (left, right) => {
    if (left.score !== right.score) {
      return descending ? right.score - left.score : left.score - right.score
    }
    const leftPopularity = popularity.get(left.id) ?? 0
    const rightPopularity = popularity.get(right.id) ?? 0
    if (leftPopularity !== rightPopularity) return rightPopularity - leftPopularity
    return left.id - right.id
  }
}

function buildVersion(version: number, games: IndexedGame[], meta: IndexMeta): PublishedVersion {
  const facets = new Map<string, Set<number>>()
  for (const game of games) {
    for (const key of facetKeysOf(version, game)) {
      let set = facets.get(key)
      if (!set) facets.set(key, (set = new Set()))
      set.add(game.id)
    }
  }

  const popularity = new Map(games.map((game) => [game.id, game.popularity]))
  const ranks = nameRanks(games)
  const orders = new Map<IndexSortField, SortOrder>()
  for (const field of INDEX_SORT_FIELDS) {
    const entries: ScoredId[] = []
    for (const game of games) {
      const score = field === 'name' ? (ranks.get(game.id) ?? null) : sortScoreOf(game, field)
      if (score !== null) entries.push({ id: game.id, score })
    }
    orders.set(field, {
      ascending: [...entries].sort(byScoreThenPopularity(popularity, false)),
      descending: [...entries].sort(byScoreThenPopularity(popularity, true)),
    })
  }

  return {
    version,
    games: new Map(games.map((game) => [game.id, game])),
    facets,
    orders,
    meta,
  }
}

export class MemoryGameIndex implements GameIndex, GameIndexWriter {
  private live: PublishedVersion | null = null
  private drafts = new Map<number, Map<number, IndexedGame>>()
  private lastVersion = 0
  private appIds = new Map<number, string>()
  private cursors = new Map<string, string>()

  async search(query: IndexQuery): Promise<IndexSearchResult> {
    const live = this.live
    if (!live) return { ...EMPTY_RESULT }

    const constraints = this.constraintsOf(live, query)
    const sort = query.sort ?? DEFAULT_SORT
    const order = live.orders.get(sortFieldOf(sort))!
    const entries = sortDescendingOf(sort) ? order.descending : order.ascending

    const candidates = intersect(constraints)
    const matched: number[] = []
    for (const entry of entries) {
      if (candidates && !candidates.has(entry.id)) continue
      const game = live.games.get(entry.id)
      if (!game || !matchesSearch(game.name, query.search)) continue
      matched.push(entry.id)
    }

    const { page, pageSize } = resolvePaging(query)
    const ids = matched.slice((page - 1) * pageSize, page * pageSize)
    return {
      ids,
      total: matched.length,
      games: ids.map((id) => clone(live.games.get(id)!)),
    }
  }

  async getMany(ids: number[]): Promise<Map<number, IndexedGame>> {
    const live = this.live
    const found = new Map<number, IndexedGame>()
    if (!live) return found
    for (const id of ids) {
      const game = live.games.get(id)
      if (game) found.set(id, clone(game))
    }
    return found
  }

  async getOne(id: number): Promise<IndexedGame | null> {
    const game = this.live?.games.get(id)
    return game ? clone(game) : null
  }

  async meta(): Promise<IndexMeta | null> {
    return this.live ? { ...this.live.meta } : null
  }

  async beginVersion(): Promise<number> {
    this.lastVersion += 1
    this.drafts.set(this.lastVersion, new Map())
    return this.lastVersion
  }

  async putGames(version: number, games: IndexedGame[]): Promise<void> {
    const draft = this.drafts.get(version)
    if (!draft) throw new Error(`Unknown index version ${version}`)
    for (const game of games) draft.set(game.id, clone(game))
  }

  async publish(version: number, meta: IndexMeta): Promise<void> {
    const draft = this.drafts.get(version)
    if (!draft) throw new Error(`Unknown index version ${version}`)
    this.live = buildVersion(version, [...draft.values()], { ...meta })
    this.drafts.delete(version)
  }

  async currentVersion(): Promise<number | null> {
    return this.live?.version ?? null
  }

  async getAppId(rawgId: number): Promise<string | null> {
    return this.appIds.get(rawgId) ?? null
  }

  async setAppId(rawgId: number, appId: string): Promise<void> {
    this.appIds.set(rawgId, appId)
  }

  async getCursor(stage: string): Promise<string | null> {
    return this.cursors.get(stage) ?? null
  }

  async setCursor(stage: string, cursor: string): Promise<void> {
    this.cursors.set(stage, cursor)
  }

  /**
   * One id set per constraint: a union inside each facet, a slice of a sorted array for each
   * range. They are intersected afterwards, which is the `SUNIONSTORE` + `ZINTERSTORE` pair the
   * Upstash adapter runs.
   */
  private constraintsOf(live: PublishedVersion, query: IndexQuery): Set<number>[] {
    const version = live.version
    const sets: Set<number>[] = []
    const union = (keys: string[]): void => {
      const merged = new Set<number>()
      for (const key of keys) for (const id of live.facets.get(key) ?? []) merged.add(id)
      sets.push(merged)
    }

    if (query.genres?.length) union(query.genres.map((genre) => genreFacetKey(version, genre)))
    if (query.platforms?.length)
      union(query.platforms.map((platform) => platformFacetKey(version, platform)))
    if (query.stores?.length) union(query.stores.map((store) => storeFacetKey(version, store)))
    if (query.gameModes?.length)
      union(query.gameModes.map((mode) => gameModeFacetKey(version, mode)))
    if (query.ageRating?.length)
      union(query.ageRating.map((rating) => ageRatingFacetKey(version, rating)))
    if (query.playtime) union([playtimeFacetKey(version, query.playtime)])
    if (query.madeInUkraine) union([madeInUkraineFacetKey(version)])
    if (query.free) union([freeFacetKey(version)])
    if (query.ukrainianLocalisation) union(localisationKeys(version, query.ukrainianLocalisation))
    if (hasPriceConstraint(query)) union([pricedFacetKey(version)])

    const range = (field: IndexSortField, min: number, max: number): void => {
      const entries = live.orders.get(field)!.ascending
      sets.push(
        new Set(
          entries
            .slice(lowerBound(entries, min), upperBound(entries, max))
            .map((entry) => entry.id),
        ),
      )
    }

    if (query.metacriticMin !== undefined)
      range('metacritic', query.metacriticMin, Number.POSITIVE_INFINITY)
    if (query.ratingMin !== undefined) range('rating', query.ratingMin, Number.POSITIVE_INFINITY)
    if (query.priceMaxUah !== undefined) range('price', Number.NEGATIVE_INFINITY, query.priceMaxUah)
    if (query.onSaleMinPercent !== undefined)
      range('discount', query.onSaleMinPercent, Number.POSITIVE_INFINITY)

    // The release-date range is cut out of `s:released`, as the design says, so the per-year
    // facets stay a writer-side detail rather than a hundred-key union at read time.
    if (query.upcoming && query.today) {
      range('released', releasedScore(nextDay(query.today)), Number.POSITIVE_INFINITY)
    } else if (query.yearFrom !== undefined || query.yearTo !== undefined) {
      range(
        'released',
        query.yearFrom === undefined ? Number.NEGATIVE_INFINITY : Date.UTC(query.yearFrom, 0, 1),
        query.yearTo === undefined ? Number.POSITIVE_INFINITY : Date.UTC(query.yearTo, 11, 31),
      )
    }

    return sets
  }
}

function localisationKeys(version: number, filter: LocalisationFilter): string[] {
  if (filter === 'TEXT') return [localisationFacetKey(version, 'text')]
  if (filter === 'AUDIO') return [localisationFacetKey(version, 'audio')]
  return [localisationFacetKey(version, 'text'), localisationFacetKey(version, 'audio')]
}

/** `null` means "no constraint at all", which is not the same as "an empty set of matches". */
function intersect(sets: Set<number>[]): Set<number> | null {
  if (sets.length === 0) return null
  const ordered = [...sets].sort((left, right) => left.size - right.size)
  let result = ordered[0]!
  for (const set of ordered.slice(1)) {
    const next = new Set<number>()
    for (const id of result) if (set.has(id)) next.add(id)
    result = next
    if (result.size === 0) break
  }
  return result
}

export function createMemoryGameIndex(): MemoryGameIndex {
  return new MemoryGameIndex()
}
