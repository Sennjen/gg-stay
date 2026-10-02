/**
 * The in-process limits in front of `/api/ask`. The hard cap on spend is the account's prepaid
 * credit balance, which does not reload by itself. The site cannot write to Redis, so there is no
 * counter shared between instances; these keep one instance, and one visitor, well inside it.
 */

/** Requests per address per minute, which is also the burst an address may spend at once. */
export const REQUESTS_PER_MINUTE = 10
/** Addresses remembered at once; the least recently seen one is forgotten past this. */
export const MAX_TRACKED_ADDRESSES = 10_000
/**
 * Answers one address may get from the model per UTC day; cached answers do not count. Beside the
 * instance's ceiling, so a single client cannot spend that ceiling for everyone else.
 */
export const MODEL_ANSWERS_PER_ADDRESS_PER_DAY = 40
/** Model calls one instance may make per UTC day, unless `ASK_DAILY_LLM_CALLS` says otherwise. */
export const DEFAULT_DAILY_LLM_CALLS = 500

/**
 * The configured ceiling, read from `ASK_DAILY_LLM_CALLS`. Env overrides arrive through destr, so
 * it may be a number or a string; anything that is not a whole, non-negative number is the default.
 */
export function dailyCallLimit(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) return DEFAULT_DAILY_LLM_CALLS
  const limit = Number(raw)
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_DAILY_LLM_CALLS
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number }

export interface RateLimiter {
  take: (key: string) => RateDecision
  size: () => number
}

/**
 * A token bucket per address, of `REQUESTS_PER_MINUTE` tokens refilled evenly over a minute —
 * written as the equivalent generic cell rate algorithm, which keeps one timestamp per address and
 * stays in whole milliseconds, so no float drift can refuse a request that has waited its turn.
 *
 * The map is bounded (`maxKeys`), least recently seen first out: an address that is forgotten
 * starts again with a full bucket, which costs at most one more burst, while an unbounded map
 * keyed by a client-supplied value is a memory leak anyone can drive.
 */
export function createRateLimiter(options: {
  now: () => number
  perMinute?: number
  maxKeys?: number
}): RateLimiter {
  const perMinute = options.perMinute ?? REQUESTS_PER_MINUTE
  const maxKeys = options.maxKeys ?? MAX_TRACKED_ADDRESSES
  const intervalMs = Math.ceil(60_000 / perMinute)
  const toleranceMs = intervalMs * (perMinute - 1)
  // The theoretical arrival time of each address's next request, in insertion = recency order.
  const arrivals = new Map<string, number>()

  return {
    take(key) {
      const now = options.now()
      const arrival = Math.max(arrivals.get(key) ?? now, now)
      if (arrival - now > toleranceMs) {
        return { ok: false, retryAfterSeconds: Math.ceil((arrival - toleranceMs - now) / 1000) }
      }
      arrivals.delete(key)
      arrivals.set(key, arrival + intervalMs)
      if (arrivals.size > maxKeys) {
        const oldest = arrivals.keys().next().value
        if (oldest !== undefined) arrivals.delete(oldest)
      }
      return { ok: true }
    },
    size: () => arrivals.size,
  }
}

export interface DailyCeiling {
  /** Takes `calls` from today's allowance, or nothing at all when it cannot cover them. */
  reserve: (calls: number) => boolean
  /** Gives back calls a request reserved and did not make. */
  refund: (calls: number) => void
  remaining: () => number
}

/** A per-instance count of model calls, reset at midnight UTC. */
export function createDailyCeiling(options: { limit: number; now: () => number }): DailyCeiling {
  let day = ''
  let used = 0

  function today(): void {
    const current = new Date(options.now()).toISOString().slice(0, 10)
    if (current !== day) {
      day = current
      used = 0
    }
  }

  return {
    reserve(calls) {
      today()
      if (used + calls > options.limit) return false
      used += calls
      return true
    },
    refund(calls) {
      today()
      used = Math.max(0, used - Math.max(0, calls))
    },
    remaining() {
      today()
      return Math.max(0, options.limit - used)
    },
  }
}

export interface DailyAllowance {
  available: (key: string) => boolean
  use: (key: string) => void
  size: () => number
}

/**
 * A per-address count of model-backed answers, reset at midnight UTC, in the same bounded,
 * least-recently-seen-first map as the rate limiter: a forgotten address starts the day again,
 * which costs at most one more allowance, never unbounded memory.
 */
export function createDailyAllowance(options: {
  now: () => number
  perDay?: number
  maxKeys?: number
}): DailyAllowance {
  const perDay = options.perDay ?? MODEL_ANSWERS_PER_ADDRESS_PER_DAY
  const maxKeys = options.maxKeys ?? MAX_TRACKED_ADDRESSES
  const counts = new Map<string, { day: string; used: number }>()
  const today = () => new Date(options.now()).toISOString().slice(0, 10)

  function usedToday(key: string): number {
    const entry = counts.get(key)
    return entry && entry.day === today() ? entry.used : 0
  }

  return {
    available: (key) => usedToday(key) < perDay,
    use(key) {
      const used = usedToday(key) + 1
      counts.delete(key)
      counts.set(key, { day: today(), used })
      if (counts.size > maxKeys) {
        const oldest = counts.keys().next().value
        if (oldest !== undefined) counts.delete(oldest)
      }
    },
    size: () => counts.size,
  }
}
