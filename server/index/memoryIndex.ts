import type { IndexPlan } from './buildPlan'
import { buildIndexPlan } from './buildPlan'
import type {
  BeginVersionOptions,
  GameIndex,
  GameIndexWriter,
  IndexQuery,
  IndexSearchResult,
} from './GameIndex'
import type { IndexMeta, IndexedGame, IndexedLanguages } from './document'
import type { PlannedRange, QueryPlan } from './queryPlan'
import { planQuery } from './queryPlan'

/** Everything one store holds. A second run against it is another `MemoryGameIndex` over this. */
interface MemoryStore {
  live: StoredVersion | null
  drafts: Map<number, IndexedGame[]>
  lastVersion: number
  previous: IndexMeta | null
  appIds: Map<number, string>
  languages: Map<string, IndexedLanguages>
  cursors: Map<string, string>
  /** The run that may write, or `null` when nobody is writing. */
  lock: string | null
  /** When that run took it, so an operator can take a dead run's lock over. */
  lockedAt: number
}

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

export interface MemoryIndexOptions {
  now?: () => number
  /** How long a lock must have been held before another run may take it over. */
  forceAfterMs?: number
}

/** The one error message a blocked run sees, wherever it is blocked. */
function lockHeldBy(holder: string, heldForMs: number): Error {
  const minutes = Math.round(heldForMs / 60_000)
  return new Error(
    `Another index run (${holder}) has held the write lock for ${minutes} minute(s). ` +
      'Begin the version with { force: true } to take it over.',
  )
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
  private readonly store: MemoryStore
  private readonly runId: string

  private readonly now: () => number
  private readonly forceAfterMs: number

  constructor(store?: MemoryStore, runId?: string, options: MemoryIndexOptions = {}) {
    this.store = store ?? {
      live: null,
      drafts: new Map(),
      lastVersion: 0,
      previous: null,
      appIds: new Map(),
      languages: new Map(),
      cursors: new Map(),
      lock: null,
      lockedAt: 0,
    }
    this.runId = runId ?? `run-${Math.random().toString(36).slice(2, 10)}`
    this.now = options.now ?? Date.now
    this.forceAfterMs = options.forceAfterMs ?? 30 * 60 * 1000
  }

  /** Another run against the same store — what a second job process is, for the write lock. */
  connect(runId: string, options: MemoryIndexOptions = {}): MemoryGameIndex {
    return new MemoryGameIndex(this.store, runId, { now: this.now, ...options })
  }

  private get live(): StoredVersion | null {
    return this.store.live
  }

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
    return this.store.previous ? { ...this.store.previous } : null
  }

  async beginVersion(options: BeginVersionOptions = {}): Promise<number> {
    this.claimLock(options.force === true)
    this.store.lastVersion += 1
    this.store.drafts.set(this.store.lastVersion, [])
    return this.store.lastVersion
  }

  async writeVersion(version: number, games: IndexedGame[]): Promise<void> {
    // Writing a version replaces it whole, so writing the live one would empty the index before
    // it filled it again. A run writes a version it began, never the one readers are on.
    if (this.live?.version === version) {
      throw new Error(`Index version ${version} is published and cannot be rewritten`)
    }
    this.assertLockIsMine()
    if (!this.store.drafts.has(version)) {
      throw new Error(`Index version ${version} was never begun`)
    }
    this.store.drafts.set(version, games.map(clone))
  }

  async publish(version: number, meta: IndexMeta): Promise<void> {
    // Publishing the version that is already live is a no-op that refreshes the run metadata: a
    // job that finishes its checks twice must not make the live version its own predecessor and
    // set its keys to expire.
    if (this.live?.version === version) {
      this.assertLockIsMine()
      this.live.meta = { ...meta }
      this.releaseLock()
      return
    }
    const draft = this.store.drafts.get(version)
    if (!draft) throw new Error(`Index version ${version} was never written`)
    this.assertLockIsHeld()
    if (this.live !== null && version < this.live.version) {
      throw new Error(`Index version ${version} is older than the published ${this.live.version}`)
    }
    // The replaced version would expire on Upstash; here it is simply dropped.
    this.store.previous = this.store.live?.meta ?? null
    this.store.live = store(version, draft, { ...meta })
    this.store.drafts.delete(version)
    this.releaseLock()
  }

  async discardVersion(version: number): Promise<void> {
    if (this.live?.version === version) {
      throw new Error(`Index version ${version} is published and cannot be discarded`)
    }
    this.assertLockIsMine()
    this.store.drafts.delete(version)
    this.releaseLock()
  }

  async currentVersion(): Promise<number | null> {
    return this.live?.version ?? null
  }

  async renewLock(): Promise<void> {
    // Nothing here expires, so renewing only resets when the lock was taken — which is what a
    // forced take-over measures against, so a run that keeps renewing cannot be taken over.
    if (this.store.lock === this.runId) this.store.lockedAt = this.now()
  }

  async allGames(): Promise<IndexedGame[]> {
    return [...(this.live?.plan.docs.values() ?? [])].map(clone)
  }

  async getLanguages(appIds: string[]): Promise<Map<string, IndexedLanguages>> {
    const found = new Map<string, IndexedLanguages>()
    for (const appId of appIds) {
      const record = this.store.languages.get(appId)
      if (record) found.set(appId, { ...record })
    }
    return found
  }

  async setLanguages(entries: Iterable<[string, IndexedLanguages]>): Promise<void> {
    for (const [appId, record] of entries) this.store.languages.set(appId, { ...record })
  }

  async getAppIds(ids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>()
    for (const id of ids) {
      const appId = this.store.appIds.get(id)
      if (appId !== undefined) found.set(id, appId)
    }
    return found
  }

  async setAppIds(entries: Iterable<[number, string]>): Promise<void> {
    for (const [id, appId] of entries) this.store.appIds.set(id, appId)
  }

  async getCursor(stage: string): Promise<string | null> {
    return this.store.cursors.get(stage) ?? null
  }

  async setCursor(stage: string, cursor: string): Promise<void> {
    this.store.cursors.set(stage, cursor)
  }

  async clearCursor(stage: string): Promise<void> {
    this.store.cursors.delete(stage)
  }

  /** One run writes at a time: two overlapping runs would each publish over the other. */
  private claimLock(force: boolean): void {
    const holder = this.store.lock
    if (holder !== null && holder !== this.runId) {
      const heldFor = this.now() - this.store.lockedAt
      if (!force || heldFor < this.forceAfterMs) throw lockHeldBy(holder, heldFor)
    }
    this.store.lock = this.runId
    this.store.lockedAt = this.now()
  }

  /** A lock nobody holds is free to act under; one another run holds is not. */
  private assertLockIsMine(): void {
    if (this.store.lock !== null && this.store.lock !== this.runId) {
      throw lockHeldBy(this.store.lock, this.now() - this.store.lockedAt)
    }
  }

  /** A publication or a discard must hold the lock, not merely find it free. */
  private assertLockIsHeld(): void {
    this.assertLockIsMine()
    if (this.store.lock !== this.runId) {
      throw new Error('This run does not hold the index write lock')
    }
  }

  private releaseLock(): void {
    if (this.store.lock === this.runId) {
      this.store.lock = null
      this.store.lockedAt = 0
    }
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

export function createMemoryGameIndex(options: MemoryIndexOptions = {}): MemoryGameIndex {
  return new MemoryGameIndex(undefined, undefined, options)
}
