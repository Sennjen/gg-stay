/**
 * The Redis surface the index adapter needs, and nothing more.
 *
 * Every call is queued on a batch and sent in a single request, because the store is reached over
 * HTTP: the cost of a read is the number of `exec` calls, not the number of commands. A batch is
 * either a plain pipeline (commands applied in order, each independent) or a `multi` (the same
 * commands wrapped in MULTI/EXEC, so a publication cannot be observed half-applied).
 *
 * Commands that only write return nothing; commands that read return a `RedisResult`, a box whose
 * `value` is filled when the batch executes. Awaiting a single command is deliberately impossible:
 * the value only exists once the whole batch has been sent.
 *
 * `zinterstore` always takes explicit weights and aggregates with SUM, which is how the order rank
 * survives an intersection: weight 1 on the order set, 0 on everything else. A plain set counts as
 * score 1, as Redis defines, so a facet contributes nothing to the score.
 *
 * `zrangestore` materialises a score range into a key of its own before the intersection, because
 * ZINTERSTORE has no way to trim its inputs. Every range of a query becomes one command.
 */

export interface RedisResult<T> {
  /** The command's answer. Reading it before the batch executed is a programming error. */
  readonly value: T
}

export interface RedisBatch {
  get(key: string): RedisResult<string | null>
  set(key: string, value: string): void
  mget(keys: string[]): RedisResult<(string | null)[]>
  mset(entries: Record<string, string>): void
  del(keys: string[]): void
  /** Atomic counter: the version sequence, so a version number is never handed out twice. */
  incr(key: string): RedisResult<number>
  expire(key: string, seconds: number): void
  sadd(key: string, members: string[]): void
  smembers(key: string): RedisResult<string[]>
  sunionstore(destination: string, keys: string[]): void
  zadd(key: string, entries: readonly (readonly [number, string])[]): void
  /** `weights[i]` applies to `keys[i]`; scores are aggregated with SUM. */
  zinterstore(destination: string, keys: string[], weights: number[]): void
  /**
   * The members of `source` whose score is within the bounds, with their scores, into
   * `destination` (ZRANGESTORE … BYSCORE). Bounds as Redis writes them: a number, `(number` for
   * exclusive, `-inf` or `+inf`.
   */
  zrangestore(destination: string, source: string, min: string, max: string): void
  zcard(key: string): RedisResult<number>
  /** One page of a sorted set by rank, lowest score first. */
  zrange(key: string, offset: number, limit: number): RedisResult<string[]>
  hgetall(key: string): RedisResult<Record<string, string>>
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
