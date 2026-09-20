import type { IndexPlan } from './buildPlan'
import { buildIndexPlan } from './buildPlan'
import type { GameIndex, GameIndexWriter, IndexQuery, IndexSearchResult } from './GameIndex'
import type { IndexMeta, IndexedGame } from './document'
import type { PlannedRange, QueryPlan } from './queryPlan'
import { planQuery } from './queryPlan'

/**
 * The in-memory adapter: a thin executor of the same two plans the Upstash adapter runs. A
 * publication is `buildIndexPlan`'s output stored in maps instead of Redis keys; a query is
 * `planQuery`'s output executed as set unions, set intersections, binary-searched range slices
 * and one ascending walk of an order set. No semantics live here — that is the point: whatever
 * this adapter answers, the Upstash one answers too.
 *
 * It serves tests, development without Upstash credentials and CI. Everything lives in the
 * process, so a restart empties it.
 */

interface StoredVersion {
  version: number
  plan: IndexPlan
  facets: Map<string, Set<number>>
  /** Order key → ids in rank order. */
  orders: Map<string, number[]>
  /** Range key → `[id, value]` pairs, ascending by value, for the binary-searched trims. */
  ranges: Map<string, [number, number][]>
  meta: IndexMeta
}

const EMPTY_RESULT: IndexSearchResult = { ids: [], total: 0, games: [] }

function clone(game: IndexedGame): IndexedGame {
  return structuredClone(game)
}

/** First index whose value is at least `min`. */
function lowerBound(entries: [number, number][], min: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle]![1] < min) low = middle + 1
    else high = middle
  }
  return low
}

/** First index whose value is greater than `max`. */
function upperBound(entries: [number, number][], max: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle]![1] <= max) low = middle + 1
    else high = middle
  }
  return low
}

function store(version: number, games: IndexedGame[], meta: IndexMeta): StoredVersion {
  const plan = buildIndexPlan(version, games)
  const facets = new Map([...plan.facets].map(([key, ids]) => [key, new Set(ids)]))
  const orders = new Map(
    [...plan.orders].map(([key, entries]) => [
      key,
      [...entries].sort((left, right) => left[1] - right[1]).map(([id]) => id),
    ]),
  )
  const ranges = new Map(
    [...plan.ranges].map(([key, entries]) => [
      key,
      [...entries].sort((left, right) => left[1] - right[1]),
    ]),
  )
  return { version, plan, facets, orders, ranges, meta }
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

export class MemoryGameIndex implements GameIndex, GameIndexWriter {
  private live: StoredVersion | null = null
  private drafts = new Map<number, IndexedGame[]>()
  private lastVersion = 0
  private previous: IndexMeta | null = null
  private appIds = new Map<number, string>()
  private cursors = new Map<string, string>()

  async search(query: IndexQuery): Promise<IndexSearchResult> {
    const live = this.live
    if (!live) return { ...EMPTY_RESULT }

    const plan = planQuery(live.version, query)
    const candidates = intersect(this.constraintSets(live, plan))
    const names = live.plan.names
    const matched: number[] = []
    for (const id of live.orders.get(plan.order) ?? []) {
      if (candidates && !candidates.has(id)) continue
      if (plan.search && !(names.get(id) ?? '').includes(plan.search)) continue
      matched.push(id)
    }

    const ids = matched.slice(plan.offset, plan.offset + plan.limit)
    return {
      ids,
      total: matched.length,
      games: ids.map((id) => clone(live.plan.docs.get(id)!)),
    }
  }

  async getMany(ids: number[]): Promise<Map<number, IndexedGame>> {
    const found = new Map<number, IndexedGame>()
    const live = this.live
    if (!live) return found
    for (const id of ids) {
      const game = live.plan.docs.get(id)
      if (game) found.set(id, clone(game))
    }
    return found
  }

  async getOne(id: number): Promise<IndexedGame | null> {
    const game = this.live?.plan.docs.get(id)
    return game ? clone(game) : null
  }

  async meta(): Promise<IndexMeta | null> {
    return this.live ? { ...this.live.meta } : null
  }

  async previousMeta(): Promise<IndexMeta | null> {
    return this.previous ? { ...this.previous } : null
  }

  async beginVersion(): Promise<number> {
    this.lastVersion += 1
    this.drafts.set(this.lastVersion, [])
    return this.lastVersion
  }

  async writeVersion(version: number, games: IndexedGame[]): Promise<void> {
    if (!this.drafts.has(version)) throw new Error(`Unknown index version ${version}`)
    this.drafts.set(version, games.map(clone))
  }

  async publish(version: number, meta: IndexMeta): Promise<void> {
    // Publishing the version that is already live is a no-op that refreshes the run metadata: a
    // job that finishes its checks twice must not make the live version its own predecessor and
    // set its keys to expire.
    if (this.live?.version === version) {
      this.live.meta = { ...meta }
      return
    }
    const draft = this.drafts.get(version)
    if (!draft) throw new Error(`Unknown index version ${version}`)
    // The replaced version would expire on Upstash; here it is simply dropped.
    this.previous = this.live?.meta ?? null
    this.live = store(version, draft, { ...meta })
    this.drafts.delete(version)
  }

  async discardVersion(version: number): Promise<void> {
    if (this.live?.version === version) {
      throw new Error(`Index version ${version} is published and cannot be discarded`)
    }
    this.drafts.delete(version)
  }

  async currentVersion(): Promise<number | null> {
    return this.live?.version ?? null
  }

  async getAppIds(ids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>()
    for (const id of ids) {
      const appId = this.appIds.get(id)
      if (appId !== undefined) found.set(id, appId)
    }
    return found
  }

  async setAppIds(entries: Iterable<[number, string]>): Promise<void> {
    for (const [id, appId] of entries) this.appIds.set(id, appId)
  }

  async getCursor(stage: string): Promise<string | null> {
    return this.cursors.get(stage) ?? null
  }

  async setCursor(stage: string, cursor: string): Promise<void> {
    this.cursors.set(stage, cursor)
  }

  async clearCursor(stage: string): Promise<void> {
    this.cursors.delete(stage)
  }

  /** The versions this adapter still holds — a test's way of seeing that a publish freed one. */
  retainedVersions(): number[] {
    return this.live ? [this.live.version] : []
  }

  /** One id set per facet group and per range, to be intersected. */
  private constraintSets(live: StoredVersion, plan: QueryPlan): Set<number>[] {
    const sets: Set<number>[] = []
    for (const group of plan.facetGroups) {
      const union = new Set<number>()
      for (const key of group) for (const id of live.facets.get(key) ?? []) union.add(id)
      sets.push(union)
    }
    for (const range of plan.ranges) sets.push(this.rangeSet(live, range))
    return sets
  }

  private rangeSet(live: StoredVersion, range: PlannedRange): Set<number> {
    const entries = live.ranges.get(range.key) ?? []
    const from = lowerBound(entries, range.min)
    const to = upperBound(entries, range.max)
    return new Set(entries.slice(from, to).map(([id]) => id))
  }
}

export function createMemoryGameIndex(): MemoryGameIndex {
  return new MemoryGameIndex()
}
