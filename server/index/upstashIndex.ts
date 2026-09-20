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
  tempKey,
  versionPrefix,
} from './keys'
import type { PlannedRange } from './queryPlan'
import { planQuery } from './queryPlan'
import type { RedisBatch, RedisCommands, RedisResult } from './redisCommands'
import { createRedisResult, withKeyPrefix } from './redisCommands'

/**
 * The Upstash adapter: a thin executor of `buildIndexPlan` and `planQuery`, exactly like the
 * in-memory one. Nothing here decides what a filter means — it decides only how the plan becomes
 * commands, and how few requests that takes.
 *
 * A page is two round trips. The first builds the query: the union of each multi-valued facet and
 * each score range go into keys of this request's own, they are intersected with the sort's order
 * set (weight 1 on the order set, 0 on everything else, so the rank the writer baked in is the
 * final score), and the same request asks for the total and the page. The ids of the page are not
 * known until that request answers, so the card documents are a second `MGET`. A searching query
 * costs one more, read first: the version's folded names, matched in this process. Every borrowed
 * key is given 60 s to live and carries the request's own id, so two requests running the same
 * query never share one.
 *
 * `idx:current` is resolved once and trusted for 60 s. A read that starts in that window is served
 * by the version the pointer named when it was read — the same window the design already allows
 * between `search` and `getMany`, and a publication is hours apart, not seconds.
 *
 * Every key a version consists of is recorded in a set of its own as it is written. That registry
 * is what `discardVersion` deletes and what `publish` sets to expire, so neither has to SCAN a key
 * space shared with the job's cursors and the permanent Steam app ids.
 */

/** The counter `beginVersion` draws from; outside every version, it must survive them all. */
const VERSION_SEQUENCE_KEY = 'idx:sequence'
/** The version the last publication replaced, for `previousMeta`. */
const PREVIOUS_VERSION_KEY = 'idx:previous'

/** Every key the version owns, written as the version is written. */
function registryKey(version: number): string {
  return `${versionPrefix(version)}keys`
}

export interface UpstashIndexOptions {
  /** Unique per read; the default is a per-adapter random prefix and a counter. */
  requestId?: () => string
  /** Milliseconds the resolved `idx:current` is trusted for. */
  currentVersionTtlMs?: number
  now?: () => number
  /** The most commands one request carries while a version is written. */
  commandsPerRequest?: number
  /** Members or fields one command carries. */
  itemsPerCommand?: number
  /** The life of a key a read borrows. */
  tempTtlSeconds?: number
  /** The life the replaced version is given by a publication. */
  replacedTtlSeconds?: number
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

export class UpstashGameIndex implements GameIndex, GameIndexWriter {
  private readonly commands: RedisCommands
  private readonly now: () => number
  private readonly currentVersionTtlMs: number
  private readonly commandsPerRequest: number
  private readonly itemsPerCommand: number
  private readonly tempTtlSeconds: number
  private readonly replacedTtlSeconds: number
  private readonly nextRequestId: () => string
  private resolved: { version: number | null; at: number } | null = null

  constructor(commands: RedisCommands, options: UpstashIndexOptions = {}) {
    this.commands = withKeyPrefix(commands, options.keyPrefix ?? '')
    this.now = options.now ?? Date.now
    this.currentVersionTtlMs = options.currentVersionTtlMs ?? 60_000
    this.commandsPerRequest = options.commandsPerRequest ?? 500
    this.itemsPerCommand = options.itemsPerCommand ?? 500
    this.tempTtlSeconds = options.tempTtlSeconds ?? 60
    this.replacedTtlSeconds = options.replacedTtlSeconds ?? 48 * 60 * 60
    // A prefix per adapter and a counter within it: two processes answering the same query at the
    // same moment must not write into one another's keys.
    const prefix = Math.random().toString(36).slice(2, 10)
    let sequence = 0
    this.nextRequestId = options.requestId ?? (() => `${prefix}${(sequence += 1).toString(36)}`)
  }

  async search(query: IndexQuery): Promise<IndexSearchResult> {
    const version = await this.currentVersion()
    if (version === null) return { ...EMPTY_RESULT }
    const plan = planQuery(version, query)

    let matched: number[] | null = null
    if (plan.search !== null) {
      const names = await this.read((batch) => batch.hgetall(namesKey(version)))
      matched = Object.entries(names)
        .filter(([, name]) => name.includes(plan.search!))
        .map(([id]) => Number(id))
      if (matched.length === 0) return { ...EMPTY_RESULT }
    }

    const requestId = this.nextRequestId()
    const borrowed: string[] = []
    const borrow = (purpose: string): string => {
      const key = tempKey(version, requestId, purpose)
      borrowed.push(key)
      return key
    }

    const batch = this.commands.pipeline()
    const sources: string[] = []
    plan.facetGroups.forEach((group, position) => {
      if (group.length === 1) {
        sources.push(group[0]!)
        return
      }
      const union = borrow(`facet${position}`)
      batch.sunionstore(union, group)
      sources.push(union)
    })
    plan.ranges.forEach((range: PlannedRange, position) => {
      const trimmed = borrow(`range${position}`)
      batch.zrangestore(trimmed, range.key, bound(range.min), bound(range.max))
      sources.push(trimmed)
    })
    if (matched !== null) {
      const hits = borrow('search')
      batch.sadd(
        hits,
        matched.map((id) => String(id)),
      )
      sources.push(hits)
    }

    const page = borrow('page')
    batch.zinterstore(page, [plan.order, ...sources], [1, ...sources.map(() => 0)])
    const total = batch.zcard(page)
    const ids = batch.zrange(page, plan.offset, plan.limit)
    for (const key of borrowed) batch.expire(key, this.tempTtlSeconds)
    await batch.exec()

    const found = ids.value.map(Number)
    if (found.length === 0) return { ids: [], total: total.value, games: [] }
    const documents = await this.readDocuments(version, found)
    return {
      ids: found,
      total: total.value,
      // A document can be missing only when a publication expired the version between the two
      // requests; the catalog reads that as "this game is not in the index", as it does for a
      // game outside the 3 000.
      games: found.map((id) => documents.get(id)).filter((game) => game !== undefined),
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
    return this.read((batch) => batch.incr(VERSION_SEQUENCE_KEY))
  }

  async writeVersion(version: number, games: IndexedGame[]): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    await opening.exec()
    // Writing a version replaces it whole, so writing the live one would empty the index before
    // it filled it again. A run writes a version it began, never the one readers are on.
    if (pointer.value !== null && Number(pointer.value) === version) {
      throw new Error(`Index version ${version} is published and cannot be rewritten`)
    }
    // A rerun of the same version starts from nothing, so a game the previous attempt wrote and
    // this one did not cannot survive in a facet or an order.
    await this.dropKeys(registered.value)

    const plan = buildIndexPlan(version, games)
    const written: ((batch: RedisBatch) => void)[] = []
    const keys = [
      registryKey(version),
      metaKey(version),
      ...[...plan.docs.keys()].map((id) => gameKey(version, id)),
      ...plan.facets.keys(),
      ...plan.orders.keys(),
      ...plan.ranges.keys(),
      namesKey(version),
    ]
    // The registry is written first and registers itself: a run interrupted halfway leaves keys
    // that `discardVersion` can still find.
    for (const part of chunk(keys, this.itemsPerCommand)) {
      written.push((batch) => batch.sadd(registryKey(version), part))
    }

    for (const part of chunk([...plan.docs.values()], Math.min(this.itemsPerCommand, 100))) {
      const documents = Object.fromEntries(
        part.map((game) => [gameKey(version, game.id), JSON.stringify(game)]),
      )
      written.push((batch) => batch.mset(documents))
    }
    for (const [key, ids] of plan.facets) {
      for (const part of chunk(ids, this.itemsPerCommand)) {
        written.push((batch) =>
          batch.sadd(
            key,
            part.map((id) => String(id)),
          ),
        )
      }
    }
    for (const scored of [plan.orders, plan.ranges]) {
      for (const [key, entries] of scored) {
        for (const part of chunk(entries, this.itemsPerCommand)) {
          written.push((batch) =>
            batch.zadd(
              key,
              part.map(([id, score]) => [score, String(id)] as const),
            ),
          )
        }
      }
    }
    for (const part of chunk([...plan.names], Math.min(this.itemsPerCommand, 200))) {
      const fields = Object.fromEntries(part.map(([id, name]) => [String(id), name]))
      written.push((batch) => batch.hset(namesKey(version), fields))
    }

    await this.send(written)
  }

  async publish(version: number, meta: IndexMeta): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    await opening.exec()
    if (registered.value.length === 0) {
      throw new Error(`Index version ${version} was never written`)
    }
    const current = pointer.value === null ? null : Number(pointer.value)

    // Publishing the live version again only refreshes its metadata: it must not become its own
    // predecessor, and none of its keys may be set to expire.
    if (current === version) {
      const refresh = this.commands.multi()
      refresh.hset(metaKey(version), encodeMeta(meta))
      await refresh.exec()
      return
    }

    const replaced =
      current === null ? [] : await this.read((batch) => batch.smembers(registryKey(current)))

    const swap = this.commands.multi()
    swap.hset(metaKey(version), encodeMeta(meta))
    swap.set(CURRENT_VERSION_KEY, String(version))
    if (current === null) swap.del([PREVIOUS_VERSION_KEY])
    else swap.set(PREVIOUS_VERSION_KEY, String(current))
    for (const key of replaced) swap.expire(key, this.replacedTtlSeconds)
    await swap.exec()
    this.resolved = { version, at: this.now() }
  }

  async discardVersion(version: number): Promise<void> {
    const opening = this.commands.pipeline()
    const registered = opening.smembers(registryKey(version))
    const pointer = opening.get(CURRENT_VERSION_KEY)
    await opening.exec()
    if (pointer.value !== null && Number(pointer.value) === version) {
      throw new Error(`Index version ${version} is published and cannot be discarded`)
    }
    await this.dropKeys(registered.value)
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
    const values = await this.read((batch) => batch.mget(ids.map((id) => appIdKey(id))))
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
        return (batch: RedisBatch) => batch.mset(values)
      }),
    )
  }

  async getCursor(stage: string): Promise<string | null> {
    return this.read((batch) => batch.get(cursorKey(stage)))
  }

  async setCursor(stage: string, cursor: string): Promise<void> {
    await this.send([(batch) => batch.set(cursorKey(stage), cursor)])
  }

  async clearCursor(stage: string): Promise<void> {
    await this.send([(batch) => batch.del([cursorKey(stage)])])
  }

  /** One request that reads one thing. */
  private async read<T>(queue: (batch: RedisBatch) => RedisResult<T>): Promise<T> {
    const batch = this.commands.pipeline()
    const result = queue(batch)
    await batch.exec()
    return result.value
  }

  /** Requests of at most `commandsPerRequest` commands, in order. */
  private async send(queued: ((batch: RedisBatch) => void)[]): Promise<void> {
    for (const part of chunk(queued, this.commandsPerRequest)) {
      const batch = this.commands.pipeline()
      for (const add of part) add(batch)
      await batch.exec()
    }
  }

  private async dropKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.send(
      chunk(keys, this.itemsPerCommand).map((part) => (batch: RedisBatch) => batch.del(part)),
    )
  }

  private async readDocuments(version: number, ids: number[]): Promise<Map<number, IndexedGame>> {
    const values = await this.read((batch) => batch.mget(ids.map((id) => gameKey(version, id))))
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

    return {
      get: (key) => read(asText, 'GET', key),
      set: (key, value) => write('SET', key, value),
      mget: (keys) => read((raw) => asList(raw).map(asText), 'MGET', ...keys),
      mset: (entries) => write('MSET', ...Object.entries(entries).flat()),
      del: (keys) => write('DEL', ...keys),
      incr: (key) => read(Number, 'INCR', key),
      expire: (key, seconds) => write('EXPIRE', key, seconds),
      sadd: (key, members) => write('SADD', key, ...members),
      smembers: (key) => read((raw) => asList(raw).map(String), 'SMEMBERS', key),
      sunionstore: (destination, keys) => write('SUNIONSTORE', destination, ...keys),
      zadd: (key, entries) =>
        write('ZADD', key, ...entries.flatMap(([score, member]) => [score, member])),
      zinterstore: (destination, keys, weights) =>
        write(
          'ZINTERSTORE',
          destination,
          keys.length,
          ...keys,
          'WEIGHTS',
          ...weights,
          'AGGREGATE',
          'SUM',
        ),
      zrangestore: (destination, source, min, max) =>
        write('ZRANGESTORE', destination, source, min, max, 'BYSCORE'),
      zcard: (key) => read(Number, 'ZCARD', key),
      zrange: (key, offset, limit) =>
        read((raw) => asList(raw).map(String), 'ZRANGE', key, offset, offset + limit - 1),
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
      hset: (key, entries) => write('HSET', key, ...Object.entries(entries).flat()),
      exec: async () => {
        if (executed) throw new Error('This batch has already been executed')
        executed = true
        if (queued.length === 0) return
        const replies = await send(path, queued)
        const failure = replies.find((reply) => reply.error)
        if (failure) throw new Error(failure.error)
        replies.forEach((reply, position) => decoders[position]?.(reply.result ?? null))
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
 * shapes; its typed command methods do not cover ZRANGESTORE, so a batch is sent as command
 * arrays through the client's own requester — one HTTP request per `exec`, `/pipeline` for a
 * pipeline and `/multi-exec` for a transaction.
 */
class RequesterRedis extends Redis {
  get requester(): Requester {
    return this.client
  }
}

export function createUpstashCommands(config: { url: string; token: string }): RedisCommands {
  const redis = new RequesterRedis({
    url: config.url,
    token: config.token,
    // Values are written and read as the strings this adapter encodes; nothing may be parsed on
    // the way back, or a card document would arrive as an object and a number as a number.
    automaticDeserialization: false,
    // The client asks Upstash to base64 its replies and undoes that per command, in the command
    // layer a batch of command arrays does not go through — the replies would arrive still
    // encoded, and every string a read returns would be nonsense.
    responseEncoding: false,
  })

  return createRedisCommands(
    async (path, commands) =>
      (await redis.requester.request({
        path: [path],
        body: commands,
      })) as unknown as CommandReply[],
  )
}
