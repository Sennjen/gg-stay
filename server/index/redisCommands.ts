/**
 * The Redis surface the index needs, and nothing more.
 *
 * Every call is queued on a batch and sent in a single request, because the store is reached over
 * HTTP: the cost of a read is the number of `exec` calls, not the number of commands. A batch is
 * either a plain pipeline or a `multi`, and the two differ in exactly one way — the commands of a
 * `multi` are applied without another client seeing a state between them. Neither rolls back: a
 * command that fails while the batch runs leaves the commands before it applied, as Redis defines
 * (`EXEC` does not undo, and there is no rollback). `exec` reports the failure afterwards.
 *
 * Commands that only write return nothing; commands that read return a `RedisResult`, a box whose
 * `value` is filled when the batch executes. Awaiting a single command is deliberately impossible:
 * the value only exists once the whole batch has been sent.
 *
 * The read half is made of read commands alone — `GET`, `MGET`, `SMEMBERS`, `SUNION`, `ZRANGE`,
 * `ZRANGEBYSCORE`, `HGETALL` — because the site holds a read-only token, and a read-only token
 * refuses a write however harmless the write is. Nothing a request does may store anything: the
 * sets come back as they are and the intersection happens in this process.
 */

export interface RedisResult<T> {
  /** The command's answer. Reading it before the batch executed is a programming error. */
  readonly value: T
}

export interface RedisBatch {
  // The read half: every command the site's read-only token is allowed to run.
  get(key: string): RedisResult<string | null>
  mget(keys: string[]): RedisResult<(string | null)[]>
  smembers(key: string): RedisResult<string[]>
  /** The union of several sets, computed by the store and returned, not stored. */
  sunion(keys: string[]): RedisResult<string[]>
  /** Every member of a sorted set in rank order, lowest score first. */
  zrangeAll(key: string): RedisResult<string[]>
  /** The members within a score range. Bounds as Redis writes them: a number, `(n`, `-inf`, `+inf`. */
  zrangebyscore(key: string, min: string, max: string): RedisResult<string[]>
  hgetall(key: string): RedisResult<Record<string, string>>

  // The write half: only the refresh job's token runs these.
  set(key: string, value: string): void
  /** `SET key value NX EX seconds`; the result is whether this caller took the key. */
  setNx(key: string, value: string, seconds: number): RedisResult<boolean>
  mset(entries: Record<string, string>): void
  del(keys: string[]): void
  incr(key: string): RedisResult<number>
  expire(key: string, seconds: number): void
  sadd(key: string, members: string[]): void
  srem(key: string, members: string[]): void
  zadd(key: string, entries: readonly (readonly [number, string])[]): void
  hset(key: string, entries: Record<string, string>): void

  /** Sends every queued command in one request. A batch is executed once. */
  exec(): Promise<void>
  /** How many commands are queued — the chunking of a large write counts them. */
  readonly size: number
}

export interface RedisCommands {
  pipeline(): RedisBatch
  multi(): RedisBatch
}

/**
 * The same store, with every key name of every command prefixed. It is how the live smoke test
 * exercises a real database without touching the index the site reads: the adapter builds its keys
 * exactly as it always does and this is the only place that knows they are moved aside.
 */
export function withKeyPrefix(commands: RedisCommands, prefix: string): RedisCommands {
  if (!prefix) return commands

  const moved = (key: string): string => `${prefix}${key}`
  const movedKeys = (keys: string[]): string[] => keys.map(moved)
  const movedEntries = (entries: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [moved(key), value]))

  const wrap = (batch: RedisBatch): RedisBatch => ({
    get: (key) => batch.get(moved(key)),
    mget: (keys) => batch.mget(movedKeys(keys)),
    smembers: (key) => batch.smembers(moved(key)),
    sunion: (keys) => batch.sunion(movedKeys(keys)),
    zrangeAll: (key) => batch.zrangeAll(moved(key)),
    zrangebyscore: (key, min, max) => batch.zrangebyscore(moved(key), min, max),
    hgetall: (key) => batch.hgetall(moved(key)),
    set: (key, value) => batch.set(moved(key), value),
    setNx: (key, value, seconds) => batch.setNx(moved(key), value, seconds),
    mset: (entries) => batch.mset(movedEntries(entries)),
    del: (keys) => batch.del(movedKeys(keys)),
    incr: (key) => batch.incr(moved(key)),
    expire: (key, seconds) => batch.expire(moved(key), seconds),
    sadd: (key, members) => batch.sadd(moved(key), members),
    srem: (key, members) => batch.srem(moved(key), members),
    zadd: (key, entries) => batch.zadd(moved(key), entries),
    hset: (key, entries) => batch.hset(moved(key), entries),
    exec: () => batch.exec(),
    get size() {
      return batch.size
    },
  })

  return {
    pipeline: () => wrap(commands.pipeline()),
    multi: () => wrap(commands.multi()),
  }
}

/** The box a queued read hands back, and the setter the batch fills it with. */
export function createRedisResult<T>(): {
  result: RedisResult<T>
  fulfil: (value: T) => void
} {
  let filled = false
  let held: T
  return {
    result: {
      get value(): T {
        if (!filled) throw new Error('This command has no answer until its batch is executed')
        return held
      },
    },
    fulfil: (value: T) => {
      held = value
      filled = true
    },
  }
}
