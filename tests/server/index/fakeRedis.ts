import type { RedisBatch, RedisCommands, RedisResult } from '../../../server/index/redisCommands'
import { createRedisResult } from '../../../server/index/redisCommands'

/**
 * Upstash, in memory, obeying the rules the adapter leans on: a plain set counts as score 1 in an
 * intersection, weights are applied and the scores aggregated with SUM, score ranges keep both
 * bounds, an empty destination is not a key, a key disappears when its TTL passes on the test's
 * own clock, and a MULTI applies whole or not at all.
 *
 * It is deliberately a fake and not a mock: the adapter tests assert what the store ends up
 * holding, so the semantics have to be real even though the transport is not. What it does add
 * beyond a store is bookkeeping the tests read — the number of round trips, the commands of each
 * request, and the remaining life of a key.
 */

type Entry =
  | { kind: 'string'; value: string }
  | { kind: 'set'; members: Set<string> }
  | { kind: 'zset'; scores: Map<string, number> }
  | { kind: 'hash'; fields: Map<string, string> }

interface Record_ {
  entry: Entry
  /** Milliseconds on the fake clock, or `null` when the key does not expire. */
  expiresAt: number | null
}

export interface FakeRedisRequest {
  multi: boolean
  commands: string[]
}

export interface FakeRedis extends RedisCommands {
  /** One per executed batch: what a real deployment would pay for. */
  readonly roundTrips: number
  readonly requests: FakeRedisRequest[]
  /** The live keys, expired ones left out. */
  keys(): string[]
  /** A sorted set as `[member, score]`, in rank order. */
  scores(key: string): [string, number][]
  /** Milliseconds of life left, or `null` for a key that is absent or does not expire. */
  ttl(key: string): number | null
  /** Moves the fake clock forward, which is the only way a TTL passes. */
  advance(ms: number): void
  /** Empties the store and the bookkeeping. */
  reset(): void
}

function wrongType(): never {
  throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
}

/** `-inf`, `+inf`, `(42` or `42`, as Redis writes the bounds of a score range. */
function parseBound(bound: string): { value: number; exclusive: boolean } {
  if (bound === '-inf') return { value: Number.NEGATIVE_INFINITY, exclusive: false }
  if (bound === '+inf') return { value: Number.POSITIVE_INFINITY, exclusive: false }
  if (bound.startsWith('(')) return { value: Number(bound.slice(1)), exclusive: true }
  return { value: Number(bound), exclusive: false }
}

function cloneEntry(entry: Entry): Entry {
  switch (entry.kind) {
    case 'string':
      return { kind: 'string', value: entry.value }
    case 'set':
      return { kind: 'set', members: new Set(entry.members) }
    case 'zset':
      return { kind: 'zset', scores: new Map(entry.scores) }
    case 'hash':
      return { kind: 'hash', fields: new Map(entry.fields) }
  }
}

export function createFakeRedis(): FakeRedis {
  const store = new Map<string, Record_>()
  const requests: FakeRedisRequest[] = []
  let clock = 0

  const live = (key: string): Entry | null => {
    const record = store.get(key)
    if (!record) return null
    if (record.expiresAt !== null && record.expiresAt <= clock) {
      store.delete(key)
      return null
    }
    return record.entry
  }

  const put = (key: string, entry: Entry): void => {
    const record = store.get(key)
    // A write keeps whatever TTL the key already carries, as Redis does for everything but SET.
    store.set(key, { entry, expiresAt: record && live(key) ? record.expiresAt : null })
  }

  const ofKind = <K extends Entry['kind']>(
    key: string,
    kind: K,
  ): Extract<Entry, { kind: K }> | null => {
    const entry = live(key)
    if (!entry) return null
    if (entry.kind !== kind) wrongType()
    return entry as Extract<Entry, { kind: K }>
  }

  const dropIfEmpty = (key: string, size: number): void => {
    if (size === 0) store.delete(key)
  }

  /** Every member of a key as `[member, score]`, a plain set scoring 1, as ZINTERSTORE defines. */
  const weighable = (key: string): Map<string, number> | null => {
    const entry = live(key)
    if (!entry) return null
    if (entry.kind === 'zset') return entry.scores
    if (entry.kind === 'set') return new Map([...entry.members].map((member) => [member, 1]))
    return wrongType()
  }

  /** Rank order: lowest score first, equal scores by member, exactly as Redis orders them. */
  const ranked = (scores: Map<string, number>): [string, number][] =>
    [...scores].sort((left, right) =>
      left[1] === right[1] ? left[0].localeCompare(right[0]) : left[1] - right[1],
    )

  const makeBatch = (multi: boolean): RedisBatch => {
    const operations: (() => void)[] = []
    const commands: string[] = []
    let executed = false

    const queue = (name: string, run: () => void): void => {
      commands.push(name)
      operations.push(run)
    }

    const queueRead = <T>(name: string, run: () => T): RedisResult<T> => {
      const { result, fulfil } = createRedisResult<T>()
      queue(name, () => fulfil(run()))
      return result
    }

    const batch: RedisBatch = {
      get: (key) => queueRead('get', () => ofKind(key, 'string')?.value ?? null),

      set: (key, value) =>
        queue('set', () => {
          // SET clears an existing TTL, which is why a republished pointer does not expire.
          store.set(key, { entry: { kind: 'string', value }, expiresAt: null })
        }),

      mget: (keys) =>
        queueRead('mget', () =>
          keys.map((key) => {
            const entry = live(key)
            return entry && entry.kind === 'string' ? entry.value : null
          }),
        ),

      mset: (entries) =>
        queue('mset', () => {
          for (const [key, value] of Object.entries(entries)) {
            store.set(key, { entry: { kind: 'string', value }, expiresAt: null })
          }
        }),

      del: (keys) =>
        queue('del', () => {
          for (const key of keys) store.delete(key)
        }),

      incr: (key) =>
        queueRead('incr', () => {
          const next = Number(ofKind(key, 'string')?.value ?? '0') + 1
          put(key, { kind: 'string', value: String(next) })
          return next
        }),

      expire: (key, seconds) =>
        queue('expire', () => {
          const record = store.get(key)
          if (!record || !live(key)) return
          record.expiresAt = clock + seconds * 1000
        }),

      sadd: (key, members) =>
        queue('sadd', () => {
          const existing = ofKind(key, 'set')
          const set = existing?.members ?? new Set<string>()
          for (const member of members) set.add(member)
          if (!existing) put(key, { kind: 'set', members: set })
        }),

      smembers: (key) => queueRead('smembers', () => [...(ofKind(key, 'set')?.members ?? [])]),

      sunionstore: (destination, keys) =>
        queue('sunionstore', () => {
          const union = new Set<string>()
          for (const key of keys)
            for (const member of ofKind(key, 'set')?.members ?? []) union.add(member)
          store.set(destination, { entry: { kind: 'set', members: union }, expiresAt: null })
          dropIfEmpty(destination, union.size)
        }),

      zadd: (key, entries) =>
        queue('zadd', () => {
          const existing = ofKind(key, 'zset')
          const scores = existing?.scores ?? new Map<string, number>()
          for (const [score, member] of entries) scores.set(member, score)
          if (!existing) put(key, { kind: 'zset', scores })
        }),

      zinterstore: (destination, keys, weights) =>
        queue('zinterstore', () => {
          const sources = keys.map(weighable)
          const scores = new Map<string, number>()
          const first = sources[0]
          if (first && sources.every((source) => source !== null)) {
            for (const member of first.keys()) {
              let total = 0
              let inAll = true
              for (const [position, source] of sources.entries()) {
                const score = source!.get(member)
                if (score === undefined) {
                  inAll = false
                  break
                }
                total += score * (weights[position] ?? 1)
              }
              if (inAll) scores.set(member, total)
            }
          }
          store.set(destination, { entry: { kind: 'zset', scores }, expiresAt: null })
          dropIfEmpty(destination, scores.size)
        }),

      zrangestore: (destination, source, min, max) =>
        queue('zrangestore', () => {
          const low = parseBound(min)
          const high = parseBound(max)
          const kept = new Map<string, number>()
          for (const [member, score] of ofKind(source, 'zset')?.scores ?? []) {
            const aboveLow = low.exclusive ? score > low.value : score >= low.value
            const belowHigh = high.exclusive ? score < high.value : score <= high.value
            if (aboveLow && belowHigh) kept.set(member, score)
          }
          store.set(destination, { entry: { kind: 'zset', scores: kept }, expiresAt: null })
          dropIfEmpty(destination, kept.size)
        }),

      zcard: (key) => queueRead('zcard', () => ofKind(key, 'zset')?.scores.size ?? 0),

      zrange: (key, offset, limit) =>
        queueRead('zrange', () =>
          ranked(ofKind(key, 'zset')?.scores ?? new Map())
            .slice(offset, offset + limit)
            .map(([member]) => member),
        ),

      hgetall: (key) =>
        queueRead('hgetall', () => Object.fromEntries(ofKind(key, 'hash')?.fields ?? [])),

      hset: (key, entries) =>
        queue('hset', () => {
          const existing = ofKind(key, 'hash')
          const fields = existing?.fields ?? new Map<string, string>()
          for (const [field, value] of Object.entries(entries)) fields.set(field, value)
          if (!existing) put(key, { kind: 'hash', fields })
        }),

      exec: async () => {
        if (executed) throw new Error('This batch has already been executed')
        executed = true
        requests.push({ multi, commands: [...commands] })
        // A MULTI is undone whole when a command fails; a pipeline keeps what already ran, which
        // is how the two differ on the wire.
        const snapshot = multi
          ? new Map(
              [...store].map(([key, record]) => [
                key,
                { entry: cloneEntry(record.entry), expiresAt: record.expiresAt },
              ]),
            )
          : null
        try {
          for (const operation of operations) operation()
        } catch (error) {
          if (snapshot) {
            store.clear()
            for (const [key, record] of snapshot) store.set(key, record)
          }
          throw error
        }
      },

      get size() {
        return commands.length
      },
    }
    return batch
  }

  return {
    pipeline: () => makeBatch(false),
    multi: () => makeBatch(true),
    get roundTrips() {
      return requests.length
    },
    requests,
    keys: () => [...store.keys()].filter((key) => live(key) !== null),
    scores: (key) => ranked(ofKind(key, 'zset')?.scores ?? new Map()),
    ttl: (key) => {
      const record = store.get(key)
      if (!record || !live(key) || record.expiresAt === null) return null
      return record.expiresAt - clock
    },
    advance: (ms) => {
      clock += ms
    },
    reset: () => {
      store.clear()
      requests.length = 0
      clock = 0
    },
  }
}
