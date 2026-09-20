import type { RedisBatch, RedisCommands, RedisResult } from '../../../server/index/redisCommands'
import { createRedisResult } from '../../../server/index/redisCommands'

/**
 * Upstash, in memory, obeying the rules the adapter leans on: score ranges keep both bounds, a
 * union is computed and returned rather than stored, an empty result is not a key, a key
 * disappears when its TTL passes on the test's own clock, and — as on a real server — a batch does
 * not roll back. Every queued command runs; the failures are reported when the batch ends, and
 * what ran before a failure stays applied. A `multi` differs only in that no other client can
 * observe a state between its commands, which an in-process fake gets for free.
 *
 * `readOnly()` is the same store seen through the site's token: every write command is refused
 * with a NOPERM error, exactly as Upstash refuses one, so a read path that writes cannot pass its
 * tests.
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

interface Held {
  entry: Entry
  /** Milliseconds on the fake clock, or `null` when the key does not expire. */
  expiresAt: number | null
}

export interface FakeRedisRequest {
  multi: boolean
  commands: string[]
  /** The commands that failed, by their position in the request. */
  failed: number[]
}

export interface FakeRedis extends RedisCommands {
  /** One per executed batch: what a real deployment would pay for. */
  readonly roundTrips: number
  readonly requests: FakeRedisRequest[]
  /** The same store through a read-only token: every write is refused. */
  readOnly(): RedisCommands
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

/** Commands a read-only Upstash token refuses. */
const WRITE_COMMANDS = new Set([
  'set',
  'setNx',
  'mset',
  'del',
  'unlink',
  'incr',
  'expire',
  'sadd',
  'srem',
  'zadd',
  'hset',
])

export function createFakeRedis(): FakeRedis {
  const store = new Map<string, Held>()
  const requests: FakeRedisRequest[] = []
  let clock = 0

  const live = (key: string): Entry | null => {
    const held = store.get(key)
    if (!held) return null
    if (held.expiresAt !== null && held.expiresAt <= clock) {
      store.delete(key)
      return null
    }
    return held.entry
  }

  const put = (key: string, entry: Entry): void => {
    const held = store.get(key)
    // A write keeps whatever TTL the key already carries, as Redis does for everything but SET.
    store.set(key, { entry, expiresAt: held && live(key) ? held.expiresAt : null })
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

  /** Rank order: lowest score first, equal scores by member as a binary string, as Redis orders. */
  const ranked = (scores: Map<string, number>): [string, number][] =>
    [...scores].sort((left, right) => {
      if (left[1] !== right[1]) return left[1] - right[1]
      return left[0] < right[0] ? -1 : 1
    })

  const makeBatch = (multi: boolean, readOnly: boolean): RedisBatch => {
    const operations: (() => void)[] = []
    const commands: string[] = []
    let executed = false

    const queue = (name: string, run: () => void): void => {
      commands.push(name)
      if (readOnly && WRITE_COMMANDS.has(name)) {
        operations.push(() => {
          throw new Error(`NOPERM this user has no permissions to run the '${name}' command`)
        })
        return
      }
      operations.push(run)
    }

    const queueRead = <T>(name: string, run: () => T): RedisResult<T> => {
      const { result, fulfil } = createRedisResult<T>()
      queue(name, () => fulfil(run()))
      return result
    }

    return {
      get: (key) => queueRead('get', () => ofKind(key, 'string')?.value ?? null),

      mget: (keys) =>
        queueRead('mget', () =>
          keys.map((key) => {
            const entry = live(key)
            return entry && entry.kind === 'string' ? entry.value : null
          }),
        ),

      smembers: (key) => queueRead('smembers', () => [...(ofKind(key, 'set')?.members ?? [])]),

      sunion: (keys) =>
        queueRead('sunion', () => {
          const union = new Set<string>()
          for (const key of keys) {
            for (const member of ofKind(key, 'set')?.members ?? []) union.add(member)
          }
          return [...union]
        }),

      zrangeAll: (key) =>
        queueRead('zrangeAll', () =>
          ranked(ofKind(key, 'zset')?.scores ?? new Map()).map(([member]) => member),
        ),

      zrangebyscore: (key, min, max) =>
        queueRead('zrangebyscore', () => {
          const low = parseBound(min)
          const high = parseBound(max)
          return ranked(ofKind(key, 'zset')?.scores ?? new Map())
            .filter(([, score]) => {
              const aboveLow = low.exclusive ? score > low.value : score >= low.value
              const belowHigh = high.exclusive ? score < high.value : score <= high.value
              return aboveLow && belowHigh
            })
            .map(([member]) => member)
        }),

      hgetall: (key) =>
        queueRead('hgetall', () => Object.fromEntries(ofKind(key, 'hash')?.fields ?? [])),

      set: (key, value) =>
        queue('set', () => {
          // SET clears an existing TTL, which is why a republished pointer does not expire.
          store.set(key, { entry: { kind: 'string', value }, expiresAt: null })
        }),

      setNx: (key, value, seconds) =>
        queueRead('setNx', () => {
          if (live(key)) return false
          store.set(key, { entry: { kind: 'string', value }, expiresAt: clock + seconds * 1000 })
          return true
        }),

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

      // Redis reclaims the memory in the background; from a caller's side it is a DEL.
      unlink: (keys) =>
        queue('unlink', () => {
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
          const held = store.get(key)
          if (!held || !live(key)) return
          held.expiresAt = clock + seconds * 1000
        }),

      sadd: (key, members) =>
        queue('sadd', () => {
          if (members.length === 0) return
          const existing = ofKind(key, 'set')
          const set = existing?.members ?? new Set<string>()
          for (const member of members) set.add(member)
          if (!existing) put(key, { kind: 'set', members: set })
        }),

      srem: (key, members) =>
        queue('srem', () => {
          const existing = ofKind(key, 'set')
          if (!existing) return
          for (const member of members) existing.members.delete(member)
          dropIfEmpty(key, existing.members.size)
        }),

      zadd: (key, entries) =>
        queue('zadd', () => {
          if (entries.length === 0) return
          const existing = ofKind(key, 'zset')
          const scores = existing?.scores ?? new Map<string, number>()
          for (const [score, member] of entries) scores.set(member, score)
          if (!existing) put(key, { kind: 'zset', scores })
        }),

      hset: (key, entries) =>
        queue('hset', () => {
          const fields = Object.entries(entries)
          if (fields.length === 0) return
          const existing = ofKind(key, 'hash')
          const held = existing?.fields ?? new Map<string, string>()
          for (const [field, value] of fields) held.set(field, value)
          if (!existing) put(key, { kind: 'hash', fields: held })
        }),

      exec: async () => {
        if (executed) throw new Error('This batch has already been executed')
        executed = true
        // Redis runs every command of a batch and reports the failures; it never undoes what ran.
        const failed: number[] = []
        let first: unknown
        operations.forEach((operation, position) => {
          try {
            operation()
          } catch (error) {
            failed.push(position)
            first ??= error
          }
        })
        requests.push({ multi, commands: [...commands], failed })
        if (first !== undefined) {
          const at = failed[0]!
          throw new Error(`Command ${at + 1} [ ${commands[at]} ] failed: ${String(first)}`)
        }
      },

      get size() {
        return commands.length
      },
    }
  }

  const view = (readOnly: boolean): RedisCommands => ({
    pipeline: () => makeBatch(false, readOnly),
    multi: () => makeBatch(true, readOnly),
  })

  return {
    ...view(false),
    readOnly: () => view(true),
    get roundTrips() {
      return requests.length
    },
    requests,
    keys: () => [...store.keys()].filter((key) => live(key) !== null),
    scores: (key) => ranked(ofKind(key, 'zset')?.scores ?? new Map()),
    ttl: (key) => {
      const held = store.get(key)
      if (!held || !live(key) || held.expiresAt === null) return null
      return held.expiresAt - clock
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
