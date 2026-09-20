import { Redis } from '@upstash/redis'
import type { Requester } from '@upstash/redis'
import { buildIndexPlan } from './buildPlan'
import type { IndexMeta, IndexedGame, IndexedLanguages } from './document'
import type {
  BeginVersionOptions,
  GameIndex,
  GameIndexWriter,
  IndexQuery,
  IndexSearchResult,
  IndexWriteStats,
} from './GameIndex'
import { DEFAULT_SORT } from './GameIndex'
import {
  CURRENT_VERSION_KEY,
  appIdKey,
  cursorKey,
  gameKey,
  languagesKey,
  metaKey,
  namesKey,
  orderKey as orderSetKey,
  versionPrefix,
} from './keys'
import { planQuery } from './queryPlan'
import type { RedisBatch, RedisCommands, RedisResult, RedisUsage } from './redisCommands'
import { commandBytes, createRedisResult, withKeyPrefix, withUsage } from './redisCommands'

/**
 * The Upstash adapter: a thin executor of `buildIndexPlan` and `planQuery`, exactly like the
 * in-memory one. Nothing here decides what a filter means — it decides only how the plan becomes
 * commands, and how few requests that takes.
 *
 * **A read never writes.** The site holds a read-only token, so a page is answered with `SMEMBERS`,
 * `SUNION`, `ZRANGEBYSCORE`, `ZRANGE` and `HGETALL` alone: the sets come back as they are and the
 * intersection happens here. The order set's rank is its position in an ascending read, the exact
 * total is the size of the intersection, the page is a slice of it, and the card documents are one
 * `MGET`. Two requests for a cold cache, one for a warm one.
 *
 * **A published version never changes**, which is what makes that affordable: every set a query
 * reads is immutable for the life of the version, so it is kept in a bounded LRU in this process
 * and the second query that needs it pays nothing. The cache belongs to one version and is dropped
 * whole when `idx:current` moves. The pointer itself is re-read at most every 60 s, so a read that
 * starts inside that window is served by the version the pointer named when it was last read — the
 * same window the port already allows between `search` and `getMany`.
 *
 * **A version is written by one run at a time.** `beginVersion` takes `idx:lock` with `SET … NX
 * EX`, which is atomic, so two runs can never both begin a version; it also writes `idx:draft`
 * (the version it is building) and `idx:lock:at` (when it took the lock), and a long
 * `writeVersion` gives all three a fresh life with `EXPIRE`, which cannot change whose they are.
 * `publish` and `discardVersion` act only while the lock is still this run's, and they release the
 * three keys together. A run blocked by the lock is told who holds it and for how long;
 * `beginVersion({ force: true })` takes over a lock held past `forceAfterMs`.
 *
 * What is left is a window, and it is worth being exact about it: `publish` reads the lock, the
 * draft and the pointer, re-reads the lock and the draft immediately before the transaction, and
 * then sends it — so a run whose lock lapsed in the microseconds between the last read and the
 * `EXEC` would still act. It cannot corrupt the pointer, because the transaction is refused when
 * the version is not this run's draft or is older than the published one, and version numbers only
 * ever grow. The worst it can do is publish a version of its own on top of a newer one it has not
 * seen, which needs its lock to have lapsed and a later run to have published inside that window —
 * hence `lockTtlSeconds`, which PR 4 should size against the job's real worst case rather than
 * inherit. Closing the window entirely needs a compare-and-delete, which means Lua.
 *
 * **Every key a version consists of is recorded in a registry** as it is written, and the version
 * number in `idx:versions`. That is what `discardVersion` deletes, and what a publication sweeps
 * afterwards — every version older than the one just replaced is
 * deleted outright, which also reclaims a version an interrupted run abandoned. Exactly one
 * predecessor is kept whole, so a reader holding a stale pointer still finds its documents.
 * Neither path needs `SCAN` over a key space shared with the job's cursors and the permanent
 * Steam app ids.
 */

/** The counter `beginVersion` draws from; outside every version, it must survive them all. */
const VERSION_SEQUENCE_KEY = 'idx:sequence'
/** The version the last publication replaced, for `previousMeta`. */
const PREVIOUS_VERSION_KEY = 'idx:previous'
/** Every version number that still owns keys: what a publication sweeps. */
const VERSIONS_KEY = 'idx:versions'
/** Held by the one run allowed to write; its value is that run's id and nothing else. */
const LOCK_KEY = 'idx:lock'
/** When the lock was taken, so a blocked run can say how old it is. Renewals never move it. */
const LOCK_TAKEN_AT_KEY = 'idx:lock:at'
/**
 * The holder's last sign of life, moved by every `renewLock`. Forcing measures this and not the
 * acquisition time: the workflow runs one job at a time, so a holder that has gone quiet is an
 * orphan of a job that is already dead, while a run that is still working keeps saying so however
 * long it takes.
 */
const LOCK_HEARTBEAT_KEY = 'idx:lock:beat'
/** The version the run holding the lock is building; the publication checks it against its own. */
const DRAFT_KEY = 'idx:draft'

/** Every key the version owns, written as the version is written. */
function registryKey(version: number): string {
  return `${versionPrefix(version)}keys`
}

export interface UpstashIndexOptions {
  /** Identifies this writer in `idx:lock`; the default is a random id per adapter. */
  runId?: string
  /** Milliseconds the resolved `idx:current` is trusted for. */
  currentVersionTtlMs?: number
  now?: () => number
  /** The most commands one request carries. */
  maxCommandsPerRequest?: number
  /** The most bytes one request body carries, measured as the commands are queued. */
  maxBytesPerRequest?: number
  /** Members, fields or keys one command carries. */
  itemsPerCommand?: number
  /**
   * The life the write lock is given, in case a run dies holding it. Half an hour by default,
   * which is what the refresh job needs: it renews the lock between stages and inside the long
   * ones, so this has to cover the longest gap between two renewals (about 90 s), not a run.
   */
  lockTtlSeconds?: number
  /**
   * How long a holder must have been silent before `beginVersion({ force: true })` takes its lock.
   * Five minutes by default, comfortably longer than the job's renewal interval and comfortably
   * shorter than `lockTtlSeconds`, so forcing is useful in the whole window where a plain retry
   * still fails.
   */
  forceAfterMs?: number
  /**
   * The shortest time between two renewals that actually reach the store. The job calls
   * `renewLock` after every stage, every batch and every chunk — hundreds of times in a run — and
   * all a renewal has to do is keep the holder from looking dead, so the rest are skipped. It must
   * stay well under `forceAfterMs`, or a live run could be mistaken for a dead one.
   */
  renewIntervalMs?: number
  /** How many sets of one version are kept in this process. */
  cacheEntries?: number
  /**
   * How much of them is kept, in bytes, charged at deliberately generous per-element rates (see
   * `bytesOf`). The default of 8 MB is therefore worth roughly 8–16 MB of real heap per instance,
   * not a fraction of it.
   */
  cacheBytes?: number
  /**
   * Moves every key this adapter touches aside, under a namespace of its own. Empty in the site
   * and in the job; the live smoke test sets it so that it can exercise a real database without
   * coming near the index the site reads.
   */
  keyPrefix?: string
}

const EMPTY_RESULT: IndexSearchResult = { ids: [], total: 0, games: [] }

/** The one message a blocked run sees: who holds the lock, for how long, and how to take it. */
function lockHeldBy(holder: string, heldForMs: number, silentForMs: number): Error {
  const minutes = (ms: number): string =>
    Number.isFinite(ms) ? `${Math.max(0, Math.round(ms / 60_000))} minute(s)` : 'an unknown time'
  return new Error(
    `Another index run (${holder}) is refreshing the index. It has held the write lock for ` +
      `${minutes(heldForMs)} and was last heard from ${minutes(silentForMs)} ago. ` +
      'If that run is dead, re-run the workflow with the force_unlock input to take the lock over.',
  )
}

/** A Redis score bound: `-inf`, `+inf` or the number itself. Every bound of a plan is inclusive. */
function bound(value: number): string {
  if (value === Number.NEGATIVE_INFINITY) return '-inf'
  if (value === Number.POSITIVE_INFINITY) return '+inf'
  return String(value)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}

function encodeMeta(meta: IndexMeta): Record<string, string> {
  return {
    version: String(meta.version),
    updatedAt: meta.updatedAt,
    pricesUpdatedAt: JSON.stringify(meta.pricesUpdatedAt),
    gameCount: String(meta.gameCount),
    stats: JSON.stringify(meta.stats ?? null),
  }
}

function decodeMeta(fields: Record<string, string>): IndexMeta | null {
  if (!fields.updatedAt) return null
  const stats = fields.stats ? (JSON.parse(fields.stats) as IndexMeta['stats']) : null
  const meta: IndexMeta = {
    version: Number(fields.version),
    updatedAt: fields.updatedAt,
    pricesUpdatedAt: fields.pricesUpdatedAt
      ? (JSON.parse(fields.pricesUpdatedAt) as string | null)
      : null,
    gameCount: Number(fields.gameCount),
  }
  if (stats) meta.stats = stats
  return meta
}

/** One command of a write, with what it will cost, so a request can be cut before it is too big. */
interface QueuedCommand {
  add: (batch: RedisBatch) => void
  bytes: number
}

/** A set a query read, kept for the life of the version it belongs to. */
type CachedRead =
  | { kind: 'order'; ids: number[] }
  | { kind: 'members'; ids: Set<number> }
  | { kind: 'names'; names: Map<number, string> }

/**
 * What an entry costs on the heap, deliberately over-estimated. A V8 `Set` of small integers runs
 * to roughly 40 bytes an element once its hash table and its load factor are counted, a `Map`
 * entry to about 80 plus the string, and a packed array of small integers to about 16. The budget
 * is therefore close to real bytes rather than a fraction of them, so `cacheBytes` can be read as
 * what it says.
 */
const BYTES_PER_ARRAY_ELEMENT = 16
const BYTES_PER_SET_MEMBER = 48
const BYTES_PER_MAP_ENTRY = 80

function bytesOf(cached: CachedRead): number {
  if (cached.kind === 'order') return cached.ids.length * BYTES_PER_ARRAY_ELEMENT + 128
  if (cached.kind === 'members') return cached.ids.size * BYTES_PER_SET_MEMBER + 128
  let total = 128
  for (const name of cached.names.values()) total += name.length * 2 + BYTES_PER_MAP_ENTRY
  return total
}

/**
 * What one version's reads cost, kept until the version is replaced. Least recently used first,
 * bounded by entry count and by the bytes it holds, because one process serves many filters and a
 * long tail of them must not grow without end.
 */
class VersionReads {
  readonly version: number
  private readonly entries = new Map<string, { value: CachedRead; bytes: number }>()
  /** Reads another request of this version has already asked for and not yet received. */
  readonly inflight = new Map<string, Promise<CachedRead>>()
  private held = 0

  constructor(
    version: number,
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {
    this.version = version
  }

  get(key: string): CachedRead | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: CachedRead): void {
    const existing = this.entries.get(key)
    if (existing) this.held -= existing.bytes
    const bytes = bytesOf(value)
    this.entries.set(key, { value, bytes })
    this.held += bytes
    while (this.entries.size > this.maxEntries || this.held > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.held -= this.entries.get(oldest.value)?.bytes ?? 0
      this.entries.delete(oldest.value)
      if (this.entries.size === 0) break
    }
  }

  /** Test-only: how much this process is holding. */
  get stored(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.held }
  }
}

export class UpstashGameIndex implements GameIndex, GameIndexWriter {
  private readonly commands: RedisCommands
  private readonly now: () => number
  private readonly currentVersionTtlMs: number
  private readonly maxCommandsPerRequest: number
  private readonly maxBytesPerRequest: number
  private readonly itemsPerCommand: number
  private readonly lockTtlSeconds: number
  private readonly forceAfterMs: number
  private readonly renewIntervalMs: number
  private readonly cacheEntries: number
  private readonly cacheBytes: number
  private readonly runId: string
  private readonly usage: () => RedisUsage
  private lastRenewedAt = Number.NEGATIVE_INFINITY
  private resolved: { version: number | null; at: number } | null = null
  private reads: VersionReads | null = null

  constructor(commands: RedisCommands, options: UpstashIndexOptions = {}) {
    // Counting sits outside the prefixing, so it counts what actually goes on the wire.
    const counted = withUsage(withKeyPrefix(commands, options.keyPrefix ?? ''))
    this.commands = counted.commands
    this.usage = counted.usage
    this.now = options.now ?? Date.now
    this.currentVersionTtlMs = options.currentVersionTtlMs ?? 60_000
    this.maxCommandsPerRequest = options.maxCommandsPerRequest ?? 500
    this.maxBytesPerRequest = options.maxBytesPerRequest ?? 700_000
    this.itemsPerCommand = options.itemsPerCommand ?? 500
    this.lockTtlSeconds = options.lockTtlSeconds ?? 30 * 60
    this.forceAfterMs = options.forceAfterMs ?? 5 * 60 * 1000
    this.renewIntervalMs = options.renewIntervalMs ?? 60_000
    this.cacheEntries = options.cacheEntries ?? 200
    this.cacheBytes = options.cacheBytes ?? 8_000_000
    this.runId = options.runId ?? `run-${Math.random().toString(36).slice(2, 10)}`
  }

  async search(query: IndexQuery): Promise<IndexSearchResult> {
    const version = await this.currentVersion()
    if (version === null) return { ...EMPTY_RESULT }
    const plan = planQuery(version, query)
    const reads = this.readsFor(version)

    // Every set this query needs, held here for as long as the query lasts. The cache is an
    // optimisation and never the working set: an entry it drops while the query is running — a
    // budget smaller than one query needs, a neighbour evicting it — must not change the answer.
    const held = new Map<string, CachedRead>()
    const awaited: { key: string; wait: Promise<CachedRead> }[] = []
    const missing: {
      key: string
      queue: (batch: RedisBatch) => () => CachedRead
      settle: { resolve: (value: CachedRead) => void; reject: (error: unknown) => void }
    }[] = []

    const need = (key: string, queue: (batch: RedisBatch) => () => CachedRead): string => {
      if (held.has(key) || missing.some((entry) => entry.key === key)) return key
      if (awaited.some((entry) => entry.key === key)) return key

      const cached = reads.get(key)
      if (cached !== undefined) {
        held.set(key, cached)
        return key
      }
      // Another request of this version is already fetching it: wait for that one instead of
      // asking again. A publication empties the cache, so without this every request in flight
      // would re-read the same order set at the same moment.
      const inflight = reads.inflight.get(key)
      if (inflight) {
        awaited.push({ key, wait: inflight })
        return key
      }
      let resolve!: (value: CachedRead) => void
      let reject!: (error: unknown) => void
      const wait = new Promise<CachedRead>((onValue, onError) => {
        resolve = onValue
        reject = onError
      })
      // Nobody may see this rejection except the requests that asked for the key.
      wait.catch(() => undefined)
      reads.inflight.set(key, wait)
      missing.push({ key, queue, settle: { resolve, reject } })
      return key
    }

    const orderKey = need(`o|${plan.order}`, (batch) => {
      const members = batch.zrangeAll(plan.order)
      // The rank a query needs is the position in an ascending read; `buildIndexPlan` writes a
      // dense 0…n-1 with the tie-break already applied, so the scores carry nothing extra.
      return () => ({ kind: 'order', ids: members.value.map(Number) })
    })

    const constraintKeys: string[] = []
    for (const group of plan.facetGroups) {
      // The values of one facet are a set, so the order the caller listed them in must not make
      // two cache entries — or two `SUNION`s — out of one.
      const canonical = [...group].sort()
      constraintKeys.push(
        need(`f|${canonical.join(',')}`, (batch) => {
          const members =
            canonical.length === 1 ? batch.smembers(canonical[0]!) : batch.sunion(canonical)
          return () => ({ kind: 'members', ids: new Set(members.value.map(Number)) })
        }),
      )
    }
    for (const range of plan.ranges) {
      const low = bound(range.min)
      const high = bound(range.max)
      constraintKeys.push(
        need(`r|${range.key}|${low}|${high}`, (batch) => {
          const members = batch.zrangebyscore(range.key, low, high)
          return () => ({ kind: 'members', ids: new Set(members.value.map(Number)) })
        }),
      )
    }

    let foldedNamesKey: string | null = null
    if (plan.search !== null) {
      foldedNamesKey = need(`n|${namesKey(version)}`, (batch) => {
        const fields = batch.hgetall(namesKey(version))
        return () => ({
          kind: 'names',
          names: new Map(
            Object.entries(fields.value).map(([id, name]) => [Number(id), name] as const),
          ),
        })
      })
    }

    const fetched: [string, CachedRead][] = []
    if (missing.length > 0) {
      const batch = this.commands.pipeline()
      const readers = missing.map((entry) => ({ ...entry, read: entry.queue(batch) }))
      try {
        await batch.exec()
      } catch (error) {
        for (const entry of readers) {
          reads.inflight.delete(entry.key)
          entry.settle.reject(error)
        }
        throw error
      }
      for (const entry of readers) {
        const value = entry.read()
        held.set(entry.key, value)
        fetched.push([entry.key, value])
        reads.inflight.delete(entry.key)
        entry.settle.resolve(value)
      }
    }
    for (const entry of awaited) held.set(entry.key, await entry.wait)

    const order = held.get(orderKey)
    if (order?.kind !== 'order') {
      // Unreachable: every key `need` returned is in `held` by now. It is an assertion, not a
      // fallback, because the quiet version of this was a page that answered nothing.
      throw new Error(`The order set ${plan.order} was not read`)
    }
    const constraints = constraintKeys
      .map((key) => held.get(key))
      .map((cached) => {
        if (cached?.kind !== 'members') throw new Error('A constraint set was not read')
        return cached.ids
      })
      // Smallest first: most ids fail on the first set and never reach the others.
      .sort((left, right) => left.size - right.size)
    const names = foldedNamesKey === null ? undefined : held.get(foldedNamesKey)
    const folded = names?.kind === 'names' ? names.names : null

    const matched: number[] = []
    for (const id of order.ids) {
      let kept = true
      for (const set of constraints) {
        if (!set.has(id)) {
          kept = false
          break
        }
      }
      if (!kept) continue
      if (plan.search !== null && !(folded?.get(id) ?? '').includes(plan.search)) continue
      matched.push(id)
    }

    // The answer is settled; only now is any of it offered to the cache, which may keep as much
    // of it as it has room for and drop the rest.
    for (const [key, value] of fetched) reads.set(key, value)

    const ids = matched.slice(plan.offset, plan.offset + plan.limit)
    if (ids.length === 0) return { ids: [], total: matched.length, games: [] }
    const documents = await this.readDocuments(version, ids)
    return {
      ids,
      total: matched.length,
      // A document can be missing only when a publication expired the version between the two
      // requests; the catalog reads that as "this game is not in the index", as it does for a
      // game outside the 3 000.
      games: ids.map((id) => documents.get(id)).filter((game) => game !== undefined),
    }
  }

  async getMany(ids: number[]): Promise<Map<number, IndexedGame>> {
    const version = await this.currentVersion()
    if (version === null || ids.length === 0) return new Map()
    return this.readDocuments(version, ids)
  }

  async getOne(id: number): Promise<IndexedGame | null> {
    return (await this.getMany([id])).get(id) ?? null
  }

  async meta(): Promise<IndexMeta | null> {
    const version = await this.currentVersion()
    if (version === null) return null
    return decodeMeta(await this.read((batch) => batch.hgetall(metaKey(version))))
  }

  async previousMeta(): Promise<IndexMeta | null> {
    const pointer = await this.read((batch) => batch.get(PREVIOUS_VERSION_KEY))
    if (pointer === null) return null
    return decodeMeta(await this.read((batch) => batch.hgetall(metaKey(Number(pointer)))))
  }

  async beginVersion(options: BeginVersionOptions = {}): Promise<number> {
    await this.claimLock(options.force === true)
    const version = await this.read((batch) => batch.incr(VERSION_SEQUENCE_KEY))
    // The draft says which version the lock holder is building, so a publication can prove that
    // the version it is about to move the pointer to is the one this run began.
    await this.send([
      {
        add: (batch) => batch.sadd(VERSIONS_KEY, [String(version)]),
        bytes: commandBytes(['SADD', VERSIONS_KEY, version]),
      },
      {
        add: (batch) => batch.set(DRAFT_KEY, String(version)),
        bytes: commandBytes(['SET', DRAFT_KEY, version]),
      },
      {
        add: (batch) => batch.expire(DRAFT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', DRAFT_KEY, this.lockTtlSeconds]),
      },
    ])
    return version
  }

  async writeVersion(version: number, games: IndexedGame[]): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    const holder = opening.get(LOCK_KEY)
    const begun = opening.smembers(VERSIONS_KEY)
    await opening.exec()

    // Writing a version replaces it whole, so writing the live one would empty the index before
    // it filled it again. A run writes a version it began, never the one readers are on.
    if (pointer.value !== null && Number(pointer.value) === version) {
      throw new Error(`Index version ${version} is published and cannot be rewritten`)
    }
    this.assertLockIsMine(holder.value)
    if (!begun.value.includes(String(version))) {
      throw new Error(`Index version ${version} was never begun`)
    }

    // A rerun of the same version starts from nothing, so a game the previous attempt wrote and
    // this one did not cannot survive in a facet or an order.
    await this.dropKeys(registered.value)

    const plan = buildIndexPlan(version, games)
    const queued: QueuedCommand[] = []
    // Writing three thousand games takes a while. `EXPIRE` gives the lock a fresh life without
    // changing whose it is, so a live run's lock cannot lapse under it and let a second run in.
    for (const key of [LOCK_KEY, DRAFT_KEY]) {
      queued.push({
        add: (batch) => batch.expire(key, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', key, this.lockTtlSeconds]),
      })
    }
    const keys = [
      registryKey(version),
      metaKey(version),
      ...[...plan.docs.keys()].map((id) => gameKey(version, id)),
      ...plan.facets.keys(),
      ...plan.orders.keys(),
      ...plan.ranges.keys(),
      namesKey(version),
    ]
    // The registry is written first and registers itself, and the metadata key the publication
    // will write: a run interrupted halfway leaves keys the sweep can still find.
    for (const part of chunk(keys, this.itemsPerCommand)) {
      queued.push({
        add: (batch) => batch.sadd(registryKey(version), part),
        bytes: commandBytes(['SADD', registryKey(version), ...part]),
      })
    }

    for (const part of chunk([...plan.docs.values()], Math.min(this.itemsPerCommand, 100))) {
      const documents = Object.fromEntries(
        part.map((game) => [gameKey(version, game.id), JSON.stringify(game)]),
      )
      queued.push({
        add: (batch) => batch.mset(documents),
        bytes: commandBytes(['MSET', ...Object.entries(documents).flat()]),
      })
    }
    for (const [key, ids] of plan.facets) {
      for (const part of chunk(ids, this.itemsPerCommand)) {
        const members = part.map((id) => String(id))
        queued.push({
          add: (batch) => batch.sadd(key, members),
          bytes: commandBytes(['SADD', key, ...members]),
        })
      }
    }
    for (const scored of [plan.orders, plan.ranges]) {
      for (const [key, entries] of scored) {
        for (const part of chunk(entries, this.itemsPerCommand)) {
          const pairs = part.map(([id, score]) => [score, String(id)] as const)
          queued.push({
            add: (batch) => batch.zadd(key, pairs),
            bytes: commandBytes(['ZADD', key, ...pairs.flat()]),
          })
        }
      }
    }
    for (const part of chunk([...plan.names], Math.min(this.itemsPerCommand, 200))) {
      const fields = Object.fromEntries(part.map(([id, name]) => [String(id), name]))
      queued.push({
        add: (batch) => batch.hset(namesKey(version), fields),
        bytes: commandBytes(['HSET', namesKey(version), ...Object.entries(fields).flat()]),
      })
    }

    await this.send(queued)
  }

  async publish(version: number, meta: IndexMeta): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    const holder = opening.get(LOCK_KEY)
    const draft = opening.get(DRAFT_KEY)
    await opening.exec()

    if (registered.value.length === 0) {
      throw new Error(`Index version ${version} was never written`)
    }
    const current = pointer.value === null ? null : Number(pointer.value)

    // Publishing the live version again only refreshes its metadata: it must not become its own
    // predecessor, and none of its keys may be set to expire.
    if (current === version) {
      this.assertLockIsMine(holder.value)
      const refresh = this.commands.multi()
      refresh.hset(metaKey(version), encodeMeta(meta))
      if (holder.value === this.runId) this.releaseInto(refresh)
      await refresh.exec()
      return
    }

    this.assertLockIsHeld(holder.value)
    if (draft.value !== String(version)) {
      throw new Error(
        `Index version ${version} is not the draft this run began (${draft.value ?? 'none'})`,
      )
    }
    // A publication may only ever move the pointer forward. It is what makes the window below
    // harmless: a run whose lock lapsed while a later run published cannot put the pointer back
    // on its own, older version — it is refused here instead.
    if (current !== null && version < current) {
      throw new Error(`Index version ${version} is older than the published ${current}`)
    }

    // Read the lock and the draft once more, immediately before the transaction, so the window
    // between deciding and acting is one request rather than the whole of the checks above.
    const reread = this.commands.pipeline()
    const stillMine = reread.get(LOCK_KEY)
    const stillDraft = reread.get(DRAFT_KEY)
    await reread.exec()
    this.assertLockIsHeld(stillMine.value)
    if (stillDraft.value !== String(version)) {
      throw new Error(`Index version ${version} stopped being this run's draft`)
    }

    // Only the facts a reader can observe are in the transaction: after it, every reader is on
    // the new version and its metadata is there to be read. Expiring what it replaced is
    // bookkeeping that no reader waits for, and it is chunked below.
    const swap = this.commands.multi()
    swap.hset(metaKey(version), encodeMeta(meta))
    swap.set(CURRENT_VERSION_KEY, String(version))
    if (current === null) swap.del([PREVIOUS_VERSION_KEY])
    else swap.set(PREVIOUS_VERSION_KEY, String(current))
    this.releaseInto(swap)
    await swap.exec()
    this.resolved = { version, at: this.now() }

    await this.sweep(version)
  }

  async discardVersion(version: number): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    const holder = opening.get(LOCK_KEY)
    await opening.exec()

    if (pointer.value !== null && Number(pointer.value) === version) {
      throw new Error(`Index version ${version} is published and cannot be discarded`)
    }
    this.assertLockIsMine(holder.value)

    await this.dropKeys(registered.value)
    const queued: QueuedCommand[] = [
      {
        add: (batch) => batch.srem(VERSIONS_KEY, [String(version)]),
        bytes: commandBytes(['SREM', VERSIONS_KEY, version]),
      },
    ]
    // Never delete a lock this run does not hold.
    if (holder.value === this.runId) {
      queued.push({
        add: (batch) => this.releaseInto(batch),
        bytes: commandBytes(['DEL', LOCK_KEY, LOCK_TAKEN_AT_KEY, DRAFT_KEY]),
      })
    }
    await this.send(queued)
  }

  async currentVersion(): Promise<number | null> {
    const resolved = this.resolved
    if (resolved && this.now() - resolved.at < this.currentVersionTtlMs) return resolved.version
    const pointer = await this.read((batch) => batch.get(CURRENT_VERSION_KEY))
    const version = pointer === null ? null : Number(pointer)
    this.resolved = { version, at: this.now() }
    return version
  }

  /**
   * Gives this run's lock and draft a fresh life. The long stages of a refresh — the candidate
   * walk, the app-id lookups, the hour-long language sweep — all happen before `writeVersion`
   * reaches its own `EXPIRE`, so without this the lock would have to be given a life long enough
   * to cover a whole run, and a run that died would block the next one for that long.
   *
   * A run that does not hold the lock does nothing rather than failing: renewing is bookkeeping,
   * and the guards on `writeVersion`, `publish` and `discardVersion` are what refuse a stranger.
   */
  async renewLock(): Promise<void> {
    // The job renews far more often than it needs to — after every stage, batch and chunk — so
    // that no call site has to reason about time. Cheap because most of the calls stop here.
    if (this.now() - this.lastRenewedAt < this.renewIntervalMs) return
    const holder = await this.read((batch) => batch.get(LOCK_KEY))
    if (holder !== this.runId) return
    this.lastRenewedAt = this.now()
    await this.send([
      {
        // The heartbeat, and only the heartbeat. Moving the acquisition time as well would make a
        // wedged run look freshly started and put it out of a forcing run's reach for good.
        add: (batch) => batch.set(LOCK_HEARTBEAT_KEY, String(this.now())),
        bytes: commandBytes(['SET', LOCK_HEARTBEAT_KEY, this.now()]),
      },
      {
        add: (batch) => batch.expire(LOCK_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', LOCK_KEY, this.lockTtlSeconds]),
      },
      {
        add: (batch) => batch.expire(LOCK_TAKEN_AT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', LOCK_TAKEN_AT_KEY, this.lockTtlSeconds]),
      },
      {
        add: (batch) => batch.expire(LOCK_HEARTBEAT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', LOCK_HEARTBEAT_KEY, this.lockTtlSeconds]),
      },
      {
        add: (batch) => batch.expire(DRAFT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', DRAFT_KEY, this.lockTtlSeconds]),
      },
    ])
  }

  /**
   * Every document of the published version. The ids come from the default order set — the one
   * sorted set that holds every game, priced or not — and the documents from one chunked `MGET`,
   * so a price-only run costs two requests here instead of the seventy-five pages of `search`
   * calls it would otherwise take, and asks RAWG nothing at all.
   */
  async allGames(): Promise<IndexedGame[]> {
    const version = await this.currentVersion()
    if (version === null) return []
    const ranked = await this.read((batch) => batch.zrangeAll(orderSetKey(version, DEFAULT_SORT)))
    const ids = ranked.map(Number)
    if (ids.length === 0) return []
    const documents = await this.readDocuments(version, ids)
    return ids.flatMap((id) => {
      const game = documents.get(id)
      return game ? [game] : []
    })
  }

  async getLanguages(appIds: string[]): Promise<Map<string, IndexedLanguages>> {
    const found = new Map<string, IndexedLanguages>()
    if (appIds.length === 0) return found
    const values = await this.readKeys(appIds.map((appId) => languagesKey(appId)))
    appIds.forEach((appId, position) => {
      const value = values[position]
      if (!value) return
      try {
        found.set(appId, JSON.parse(value) as IndexedLanguages)
      } catch {
        // A record is a cache of what Steam said. One that will not parse is worth exactly as
        // much as one that is absent: the app goes back on the work list and is rewritten.
        console.warn(`[index] the language record for app ${appId} is unreadable; re-reading it`)
      }
    })
    return found
  }

  async setLanguages(entries: Iterable<[string, IndexedLanguages]>): Promise<void> {
    const pairs = [...entries]
    if (pairs.length === 0) return
    await this.send(
      chunk(pairs, this.itemsPerCommand).map((part) => {
        const values = Object.fromEntries(
          part.map(([appId, record]) => [languagesKey(appId), JSON.stringify(record)]),
        )
        return {
          add: (batch: RedisBatch) => batch.mset(values),
          bytes: commandBytes(['MSET', ...Object.entries(values).flat()]),
        }
      }),
    )
  }

  /** Requests, commands and payload bytes this adapter has put on the wire since it was built. */
  stats(): IndexWriteStats {
    return this.usage()
  }

  async getAppIds(ids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>()
    if (ids.length === 0) return found
    const values = await this.readKeys(ids.map((id) => appIdKey(id)))
    ids.forEach((id, position) => {
      const value = values[position]
      if (value !== null && value !== undefined) found.set(id, value)
    })
    return found
  }

  async setAppIds(entries: Iterable<[number, string]>): Promise<void> {
    const pairs = [...entries]
    if (pairs.length === 0) return
    await this.send(
      chunk(pairs, this.itemsPerCommand).map((part) => {
        const values = Object.fromEntries(part.map(([id, appId]) => [appIdKey(id), appId]))
        return {
          add: (batch: RedisBatch) => batch.mset(values),
          bytes: commandBytes(['MSET', ...Object.entries(values).flat()]),
        }
      }),
    )
  }

  async getCursor(stage: string): Promise<string | null> {
    return this.read((batch) => batch.get(cursorKey(stage)))
  }

  async setCursor(stage: string, cursor: string): Promise<void> {
    await this.send([
      {
        add: (batch) => batch.set(cursorKey(stage), cursor),
        bytes: commandBytes(['SET', cursorKey(stage), cursor]),
      },
    ])
  }

  async clearCursor(stage: string): Promise<void> {
    await this.send([
      {
        add: (batch) => batch.del([cursorKey(stage)]),
        bytes: commandBytes(['DEL', cursorKey(stage)]),
      },
    ])
  }

  /** Test-only: what this process is holding for the version it last read. */
  cached(): { version: number | null; entries: number; bytes: number } {
    if (!this.reads) return { version: null, entries: 0, bytes: 0 }
    return { version: this.reads.version, ...this.reads.stored }
  }

  private readsFor(version: number): VersionReads {
    if (!this.reads || this.reads.version !== version) {
      // A published version is immutable, so nothing cached for it can go stale; a different
      // version means every set this process holds belongs to a version nobody reads any more.
      this.reads = new VersionReads(version, this.cacheEntries, this.cacheBytes)
    }
    return this.reads
  }

  private async claimLock(force: boolean): Promise<void> {
    const batch = this.commands.pipeline()
    const taken = batch.setNx(LOCK_KEY, this.runId, this.lockTtlSeconds)
    const holder = batch.get(LOCK_KEY)
    const takenAt = batch.get(LOCK_TAKEN_AT_KEY)
    const heartbeat = batch.get(LOCK_HEARTBEAT_KEY)
    await batch.exec()

    if (!taken.value && holder.value !== this.runId) {
      const heldFor = this.now() - Number(takenAt.value ?? 0)
      // A holder that has gone quiet is a dead one: the job renews every stage and every batch,
      // and the workflow never runs two jobs at once, so silence has no innocent explanation.
      const silentFor = this.now() - Number(heartbeat.value ?? takenAt.value ?? 0)
      if (!force || silentFor < this.forceAfterMs) {
        throw lockHeldBy(holder.value ?? 'an unnamed run', heldFor, silentFor)
      }
      // Taking over a lock nobody is using any more: the run that held it left a draft behind,
      // which the next publication sweeps like any other abandoned version.
      await this.send([
        {
          add: (batch) => batch.set(LOCK_KEY, this.runId),
          bytes: commandBytes(['SET', LOCK_KEY, this.runId]),
        },
        {
          add: (batch) => batch.expire(LOCK_KEY, this.lockTtlSeconds),
          bytes: commandBytes(['EXPIRE', LOCK_KEY, this.lockTtlSeconds]),
        },
      ])
    }

    // The acquisition time is written once, here, and never moved again: it is what the blocked
    // run reports, while the heartbeat beside it is what decides whether the holder is alive.
    const stamped = String(this.now())
    this.lastRenewedAt = this.now()
    await this.send([
      {
        add: (batch) => batch.set(LOCK_TAKEN_AT_KEY, stamped),
        bytes: commandBytes(['SET', LOCK_TAKEN_AT_KEY, stamped]),
      },
      {
        add: (batch) => batch.expire(LOCK_TAKEN_AT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', LOCK_TAKEN_AT_KEY, this.lockTtlSeconds]),
      },
      {
        add: (batch) => batch.set(LOCK_HEARTBEAT_KEY, stamped),
        bytes: commandBytes(['SET', LOCK_HEARTBEAT_KEY, stamped]),
      },
      {
        add: (batch) => batch.expire(LOCK_HEARTBEAT_KEY, this.lockTtlSeconds),
        bytes: commandBytes(['EXPIRE', LOCK_HEARTBEAT_KEY, this.lockTtlSeconds]),
      },
    ])
  }

  /** The lock, its age, its heartbeat and the draft go together; nothing releases one alone. */
  private releaseInto(batch: RedisBatch): void {
    batch.del([LOCK_KEY, LOCK_TAKEN_AT_KEY, LOCK_HEARTBEAT_KEY, DRAFT_KEY])
  }

  /** A lock nobody holds is free to act under; one another run holds is not. */
  private assertLockIsMine(holder: string | null): void {
    if (holder !== null && holder !== this.runId) {
      throw lockHeldBy(holder, Number.NaN, Number.NaN)
    }
  }

  /** A publication or a discard must hold the lock, not merely find it free. */
  private assertLockIsHeld(holder: string | null): void {
    this.assertLockIsMine(holder)
    if (holder !== this.runId) {
      throw new Error('This run does not hold the index write lock')
    }
  }

  /**
   * Deletes the versions nobody can still be reading, after the pointer has moved. It runs after
   * the publication, it is idempotent, and a failure leaves the publication standing: the next one
   * sweeps whatever was missed.
   *
   * Exactly one predecessor is kept, whole and without an expiry of any kind. A reader may hold a
   * pointer for up to `currentVersionTtlMs`, and a `search` followed by a `getMany` may straddle a
   * publication, so the version just replaced has to stay readable; it is deleted by the next
   * publication rather than by a clock, which is both simpler and cheaper than a per-key TTL.
   *
   * Everything older — the version before that, and any version an interrupted run abandoned —
   * goes in multi-key `UNLINK`s of at most `itemsPerCommand` keys each, inside the same byte and
   * command budget as any other write. That is the difference between about nine commands per
   * publication and one per key of the catalog.
   */
  private async sweep(current: number): Promise<void> {
    try {
      const opening = this.commands.pipeline()
      const begun = opening.smembers(VERSIONS_KEY)
      const keptBack = opening.get(PREVIOUS_VERSION_KEY)
      await opening.exec()

      const keep = new Set([current])
      if (keptBack.value !== null) keep.add(Number(keptBack.value))
      const stale = begun.value.map(Number).filter((version) => !keep.has(version))
      if (stale.length === 0) return

      const reading = this.commands.pipeline()
      const registries = stale.map((version) => ({
        version,
        keys: reading.smembers(registryKey(version)),
      }))
      await reading.exec()

      const deletions: QueuedCommand[] = []
      const forgets: QueuedCommand[] = []
      for (const { version, keys } of registries) {
        // The registry itself goes with the keys it records.
        for (const part of chunk([...keys.value, registryKey(version)], this.itemsPerCommand)) {
          deletions.push({
            add: (batch) => batch.unlink(part),
            bytes: commandBytes(['UNLINK', ...part]),
          })
        }
        forgets.push({
          add: (batch) => batch.srem(VERSIONS_KEY, [String(version)]),
          bytes: commandBytes(['SREM', VERSIONS_KEY, version]),
        })
      }
      // The version is forgotten only once its keys are gone, so a failure half way leaves it in
      // `idx:versions` for the next publication to finish.
      await this.send(deletions)
      await this.send(forgets)
    } catch (error) {
      console.warn('[index] the published version stands; sweeping the old ones failed', error)
    }
  }

  /** One request that reads one thing. */
  private async read<T>(queue: (batch: RedisBatch) => RedisResult<T>): Promise<T> {
    const batch = this.commands.pipeline()
    const result = queue(batch)
    await batch.exec()
    return result.value
  }

  /** One request, however many keys: `MGET` is chunked into several commands, not several trips. */
  private async readKeys(keys: string[]): Promise<(string | null)[]> {
    const batch = this.commands.pipeline()
    const parts = chunk(keys, this.itemsPerCommand).map((part) => batch.mget(part))
    await batch.exec()
    return parts.flatMap((part) => part.value)
  }

  /**
   * Requests bounded by both the command count and the size of the body they would carry. A
   * single command larger than the budget travels alone — `itemsPerCommand` is what keeps one
   * command small, and this is what keeps a request of them small.
   */
  private async send(queued: QueuedCommand[]): Promise<void> {
    let batch = this.commands.pipeline()
    let bytes = 0
    for (const command of queued) {
      const full =
        batch.size >= this.maxCommandsPerRequest || bytes + command.bytes > this.maxBytesPerRequest
      if (batch.size > 0 && full) {
        await batch.exec()
        batch = this.commands.pipeline()
        bytes = 0
      }
      command.add(batch)
      bytes += command.bytes
    }
    if (batch.size > 0) await batch.exec()
  }

  private async dropKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.send(
      chunk(keys, this.itemsPerCommand).map((part) => ({
        add: (batch: RedisBatch) => batch.del(part),
        bytes: commandBytes(['DEL', ...part]),
      })),
    )
  }

  private async readDocuments(version: number, ids: number[]): Promise<Map<number, IndexedGame>> {
    const values = await this.readKeys(ids.map((id) => gameKey(version, id)))
    const documents = new Map<number, IndexedGame>()
    ids.forEach((id, position) => {
      const value = values[position]
      if (value) documents.set(id, JSON.parse(value) as IndexedGame)
    })
    return documents
  }
}

export function createUpstashIndex(
  commands: RedisCommands,
  options?: UpstashIndexOptions,
): UpstashGameIndex {
  return new UpstashGameIndex(commands, options)
}

/**
 * The Redis interface as command arrays, over a transport of any kind: this is the half that says
 * what a command looks like on the wire, and it has no idea how it travels.
 */
export interface CommandReply {
  result?: unknown
  error?: string
}

export type SendCommands = (
  path: 'pipeline' | 'multi-exec',
  commands: (string | number)[][],
) => Promise<CommandReply[]>

/** A batch that came back wrong or came back with a failure in it. Carries no credentials. */
export class RedisBatchError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly commandIndex: number | null,
    readonly command: string | null,
  ) {
    super(message)
    this.name = 'RedisBatchError'
  }
}

type Argument = string | number

export function createRedisCommands(send: SendCommands): RedisCommands {
  const makeBatch = (path: 'pipeline' | 'multi-exec'): RedisBatch => {
    const queued: Argument[][] = []
    const decoders: ((raw: unknown) => void)[] = []
    let executed = false

    const write = (...command: Argument[]): void => {
      queued.push(command)
      decoders.push(() => undefined)
    }

    const read = <T>(decode: (raw: unknown) => T, ...command: Argument[]): RedisResult<T> => {
      const { result, fulfil } = createRedisResult<T>()
      queued.push(command)
      decoders.push((raw) => fulfil(decode(raw)))
      return result
    }

    const asText = (raw: unknown): string | null => (raw === null ? null : String(raw))
    const asList = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : [])
    const asMembers = (raw: unknown): string[] => asList(raw).map(String)

    return {
      get: (key) => read(asText, 'GET', key),
      mget: (keys) => read((raw) => asList(raw).map(asText), 'MGET', ...keys),
      smembers: (key) => read(asMembers, 'SMEMBERS', key),
      sunion: (keys) => read(asMembers, 'SUNION', ...keys),
      zrangeAll: (key) => read(asMembers, 'ZRANGE', key, 0, -1),
      zrangebyscore: (key, min, max) => read(asMembers, 'ZRANGEBYSCORE', key, min, max),
      hgetall: (key) =>
        read(
          (raw) => {
            // The REST API answers HGETALL with a flat field/value list.
            const flat = asList(raw)
            const fields: Record<string, string> = {}
            for (let position = 0; position + 1 < flat.length; position += 2) {
              fields[String(flat[position])] = String(flat[position + 1])
            }
            return fields
          },
          'HGETALL',
          key,
        ),

      set: (key, value) => write('SET', key, value),
      setNx: (key, value, seconds) =>
        read((raw) => raw !== null, 'SET', key, value, 'NX', 'EX', seconds),
      mset: (entries) => write('MSET', ...Object.entries(entries).flat()),
      del: (keys) => write('DEL', ...keys),
      unlink: (keys) => write('UNLINK', ...keys),
      incr: (key) => read(Number, 'INCR', key),
      expire: (key, seconds) => write('EXPIRE', key, seconds),
      sadd: (key, members) => write('SADD', key, ...members),
      srem: (key, members) => write('SREM', key, ...members),
      zadd: (key, entries) =>
        write('ZADD', key, ...entries.flatMap(([score, member]) => [score, member])),
      hset: (key, entries) => write('HSET', key, ...Object.entries(entries).flat()),

      exec: async () => {
        if (executed) throw new Error('This batch has already been executed')
        executed = true
        if (queued.length === 0) return
        const replies = await send(path, queued)
        if (!Array.isArray(replies)) {
          throw new RedisBatchError(
            `The ${path} answered with ${typeof replies} instead of a list of replies`,
            path,
            null,
            null,
          )
        }
        if (replies.length !== queued.length) {
          throw new RedisBatchError(
            `The ${path} answered ${replies.length} replies to ${queued.length} commands`,
            path,
            null,
            null,
          )
        }
        const position = replies.findIndex((reply) => reply?.error)
        if (position >= 0) {
          const verb = String(queued[position]?.[0] ?? '')
          throw new RedisBatchError(
            `Command ${position + 1} [ ${verb} ] failed: ${replies[position]?.error}`,
            path,
            position,
            verb,
          )
        }
        replies.forEach((reply, index) => decoders[index]?.(reply?.result ?? null))
      },

      get size() {
        return queued.length
      },
    }
  }

  return {
    pipeline: () => makeBatch('pipeline'),
    multi: () => makeBatch('multi-exec'),
  }
}

/**
 * The REST transport. `@upstash/redis` brings the authentication, the retries and the error
 * shapes; its typed command methods do not cover every command the index uses, so a batch is sent
 * as command arrays through the client's own requester — one HTTP request per `exec`,
 * `/pipeline` for a pipeline and `/multi-exec` for a transaction.
 */
export class UpstashClient extends Redis {
  get requester(): Requester {
    return this.client
  }
}

export function createUpstashClient(config: { url: string; token: string }): UpstashClient {
  return new UpstashClient({
    url: config.url,
    token: config.token,
    // Inert on this path — the typed commands that would deserialise a reply are not used — but
    // kept so that a future typed command cannot quietly start parsing the strings this adapter
    // encodes itself.
    automaticDeserialization: false,
    // This one is not inert. The client asks Upstash to base64 its replies and undoes that per
    // command, in the command layer a batch of command arrays does not go through: the replies
    // would arrive still encoded and every string a read returns would be nonsense.
    responseEncoding: false,
  })
}

/** Commands over a client someone else owns, so one connection can serve several purposes. */
export function createUpstashCommandsOn(client: UpstashClient): RedisCommands {
  return createRedisCommands(
    async (path, commands) =>
      (await client.requester.request({
        path: [path],
        body: commands,
      })) as unknown as CommandReply[],
  )
}

export function createUpstashCommands(config: { url: string; token: string }): RedisCommands {
  return createUpstashCommandsOn(createUpstashClient(config))
}
