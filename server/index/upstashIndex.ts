import { Redis } from '@upstash/redis'
import type { Requester } from '@upstash/redis'
import { buildIndexPlan } from './buildPlan'
import type { IndexMeta, IndexedGame } from './document'
import type { GameIndex, GameIndexWriter, IndexQuery, IndexSearchResult } from './GameIndex'
import {
  CURRENT_VERSION_KEY,
  appIdKey,
  cursorKey,
  gameKey,
  metaKey,
  namesKey,
  versionPrefix,
} from './keys'
import { planQuery } from './queryPlan'
import type { RedisBatch, RedisCommands, RedisResult } from './redisCommands'
import { createRedisResult, withKeyPrefix } from './redisCommands'

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
 * **A version is written by one run at a time.** `beginVersion` takes `idx:lock`; `writeVersion`,
 * `publish` and `discardVersion` refuse to act while another run holds it, and a publication or a
 * discard releases it. Without it two overlapping runs would both move `idx:current` and one of
 * them would leave its keys behind forever.
 *
 * **Every key a version consists of is recorded in a registry** as it is written, and the version
 * number in `idx:versions`. That is what `discardVersion` deletes, and what a publication sweeps
 * afterwards — every version that is neither the new current one nor a live draft is given its
 * 48 h expiry, which also reclaims a version an interrupted run abandoned. Neither path needs
 * `SCAN` over a key space shared with the job's cursors and the permanent Steam app ids.
 */

/** The counter `beginVersion` draws from; outside every version, it must survive them all. */
const VERSION_SEQUENCE_KEY = 'idx:sequence'
/** The version the last publication replaced, for `previousMeta`. */
const PREVIOUS_VERSION_KEY = 'idx:previous'
/** Every version number that still owns keys: what a publication sweeps. */
const VERSIONS_KEY = 'idx:versions'
/** Held by the one run allowed to write. */
const LOCK_KEY = 'idx:lock'

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
  /** The life the write lock is given, in case a run dies holding it. */
  lockTtlSeconds?: number
  /** The life a replaced or abandoned version is given by a publication. */
  replacedTtlSeconds?: number
  /** How many sets of one version are kept in this process. */
  cacheEntries?: number
  /** Roughly how much of them is kept, in bytes. */
  cacheBytes?: number
  /**
   * Moves every key this adapter touches aside, under a namespace of its own. Empty in the site
   * and in the job; the live smoke test sets it so that it can exercise a real database without
   * coming near the index the site reads.
   */
  keyPrefix?: string
}

const EMPTY_RESULT: IndexSearchResult = { ids: [], total: 0, games: [] }

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

/**
 * What a command costs in the request body: the body is a JSON array of command arrays, so each
 * argument is measured as JSON writes it — escaping included, which a card document is full of.
 */
function commandBytes(parts: readonly (string | number)[]): number {
  let total = 2
  for (const part of parts) total += JSON.stringify(part).length + 1
  return total
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

function bytesOf(cached: CachedRead): number {
  if (cached.kind === 'order') return cached.ids.length * 8 + 64
  if (cached.kind === 'members') return cached.ids.size * 8 + 64
  let total = 64
  for (const name of cached.names.values()) total += name.length * 2 + 16
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
  private readonly replacedTtlSeconds: number
  private readonly cacheEntries: number
  private readonly cacheBytes: number
  private readonly runId: string
  private resolved: { version: number | null; at: number } | null = null
  private reads: VersionReads | null = null

  constructor(commands: RedisCommands, options: UpstashIndexOptions = {}) {
    this.commands = withKeyPrefix(commands, options.keyPrefix ?? '')
    this.now = options.now ?? Date.now
    this.currentVersionTtlMs = options.currentVersionTtlMs ?? 60_000
    this.maxCommandsPerRequest = options.maxCommandsPerRequest ?? 500
    this.maxBytesPerRequest = options.maxBytesPerRequest ?? 700_000
    this.itemsPerCommand = options.itemsPerCommand ?? 500
    this.lockTtlSeconds = options.lockTtlSeconds ?? 3_600
    this.replacedTtlSeconds = options.replacedTtlSeconds ?? 48 * 60 * 60
    this.cacheEntries = options.cacheEntries ?? 200
    this.cacheBytes = options.cacheBytes ?? 8_000_000
    this.runId = options.runId ?? `run-${Math.random().toString(36).slice(2, 10)}`
  }

  async search(query: IndexQuery): Promise<IndexSearchResult> {
    const version = await this.currentVersion()
    if (version === null) return { ...EMPTY_RESULT }
    const plan = planQuery(version, query)
    const reads = this.readsFor(version)

    const missing: { key: string; queue: (batch: RedisBatch) => () => CachedRead }[] = []
    const need = (key: string, queue: (batch: RedisBatch) => () => CachedRead): string => {
      if (reads.get(key) === undefined && !missing.some((entry) => entry.key === key)) {
        missing.push({ key, queue })
      }
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
      constraintKeys.push(
        need(`f|${group.join(',')}`, (batch) => {
          const members = group.length === 1 ? batch.smembers(group[0]!) : batch.sunion(group)
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

    let namesKeyCached: string | null = null
    if (plan.search !== null) {
      namesKeyCached = need(`n|${namesKey(version)}`, (batch) => {
        const fields = batch.hgetall(namesKey(version))
        return () => ({
          kind: 'names',
          names: new Map(
            Object.entries(fields.value).map(([id, name]) => [Number(id), name] as const),
          ),
        })
      })
    }

    if (missing.length > 0) {
      const batch = this.commands.pipeline()
      const readers = missing.map((entry) => ({ key: entry.key, read: entry.queue(batch) }))
      await batch.exec()
      for (const { key, read } of readers) reads.set(key, read())
    }

    const order = reads.get(orderKey)
    if (order?.kind !== 'order') return { ...EMPTY_RESULT }
    const constraints = constraintKeys
      .map((key) => reads.get(key))
      .filter((cached) => cached?.kind === 'members')
      .map((cached) => cached.ids)
      // Smallest first: most ids fail on the first set and never reach the others.
      .sort((left, right) => left.size - right.size)
    const names = namesKeyCached ? reads.get(namesKeyCached) : undefined
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

  async beginVersion(): Promise<number> {
    await this.claimLock()
    const version = await this.read((batch) => batch.incr(VERSION_SEQUENCE_KEY))
    await this.send([
      {
        add: (batch) => batch.sadd(VERSIONS_KEY, [String(version)]),
        bytes: commandBytes(['SADD', VERSIONS_KEY, version]),
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
    await opening.exec()

    this.assertLockIsMine(holder.value)
    if (registered.value.length === 0) {
      throw new Error(`Index version ${version} was never written`)
    }
    const current = pointer.value === null ? null : Number(pointer.value)

    // Publishing the live version again only refreshes its metadata: it must not become its own
    // predecessor, and none of its keys may be set to expire.
    if (current === version) {
      const refresh = this.commands.multi()
      refresh.hset(metaKey(version), encodeMeta(meta))
      refresh.del([LOCK_KEY])
      await refresh.exec()
      return
    }

    // Only the two facts a reader can observe are in the transaction: after it, every reader is
    // on the new version and its metadata is there to be read. Expiring what it replaced is
    // bookkeeping that no reader waits for, and it is chunked below.
    const swap = this.commands.multi()
    swap.hset(metaKey(version), encodeMeta(meta))
    swap.set(CURRENT_VERSION_KEY, String(version))
    if (current === null) swap.del([PREVIOUS_VERSION_KEY])
    else swap.set(PREVIOUS_VERSION_KEY, String(current))
    swap.del([LOCK_KEY])
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
    await this.send([
      {
        add: (batch) => batch.srem(VERSIONS_KEY, [String(version)]),
        bytes: commandBytes(['SREM', VERSIONS_KEY, version]),
      },
      { add: (batch) => batch.del([LOCK_KEY]), bytes: commandBytes(['DEL', LOCK_KEY]) },
    ])
  }

  async currentVersion(): Promise<number | null> {
    const resolved = this.resolved
    if (resolved && this.now() - resolved.at < this.currentVersionTtlMs) return resolved.version
    const pointer = await this.read((batch) => batch.get(CURRENT_VERSION_KEY))
    const version = pointer === null ? null : Number(pointer)
    this.resolved = { version, at: this.now() }
    return version
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

  private async claimLock(): Promise<void> {
    const batch = this.commands.pipeline()
    const taken = batch.setNx(LOCK_KEY, this.runId, this.lockTtlSeconds)
    const holder = batch.get(LOCK_KEY)
    await batch.exec()
    if (!taken.value) this.assertLockIsMine(holder.value)
  }

  /** A lock nobody holds is free to act under; one another run holds is not. */
  private assertLockIsMine(holder: string | null): void {
    if (holder !== null && holder !== this.runId) {
      throw new Error(`Another index run (${holder}) holds the write lock`)
    }
  }

  /**
   * Gives every version that is neither the new current one nor a live draft its expiry. It runs
   * after the pointer has moved, it is idempotent, and a failure leaves the publication standing:
   * the next one sweeps whatever was missed.
   */
  private async sweep(current: number): Promise<void> {
    try {
      const begun = await this.read((batch) => batch.smembers(VERSIONS_KEY))
      const stale = begun.map(Number).filter((version) => version !== current)
      if (stale.length === 0) return

      const reading = this.commands.pipeline()
      const registries = stale.map((version) => ({
        version,
        keys: reading.smembers(registryKey(version)),
      }))
      await reading.exec()

      const expiries: QueuedCommand[] = []
      const forgets: QueuedCommand[] = []
      for (const { version, keys } of registries) {
        for (const key of keys.value) {
          expiries.push({
            add: (batch) => batch.expire(key, this.replacedTtlSeconds),
            bytes: commandBytes(['EXPIRE', key, this.replacedTtlSeconds]),
          })
        }
        forgets.push({
          add: (batch) => batch.srem(VERSIONS_KEY, [String(version)]),
          bytes: commandBytes(['SREM', VERSIONS_KEY, version]),
        })
      }
      // The version is forgotten only once its keys are counting down, so a failure half way
      // leaves it in `idx:versions` for the next publication to finish.
      await this.send(expiries)
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
