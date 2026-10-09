import type { SharedRead } from './createUpstreamFetch'

/**
 * A cache in two levels: the instance's own memory, and a store every instance of the function
 * shares.
 *
 * What RAWG and Steam answer used to be kept only in the memory of the instance that asked, so a
 * new instance, a cold start or a deployment asked again — and RAWG is the slow part of a first
 * open. The shared level is where one instance's work reaches the others
 * (`docs/specs/2026-10-09-shared-upstream-cache-design.md`).
 *
 * The rules, each of which exists so that the second level can only ever help:
 *
 * - **Memory first.** A read that memory answers with a live entry never leaves the instance. The
 *   shared level is asked only when memory has nothing, or only an entry past its `expiresAt`;
 *   an entry it holds that is newer than memory's is copied into memory and returned.
 * - **A read has a deadline**, `SHARED_CACHE_DEADLINE_MS`. Slower than that, or failing, it is a
 *   miss, and the shared level is then left alone for `SHARED_CACHE_PAUSE_MS`, with one warning:
 *   a store that is down costs a request one deadline, not one for every upstream call it makes.
 * - **A write is never waited for.** Memory is written first, as it always was; the shared write
 *   is handed to the request's keep-alive with its failure already handled, so it can neither
 *   delay an answer nor fail one. A write that fails pauses nothing — a store may refuse writes
 *   and still answer reads — but it is said, in one line for the length of a pause, so that a
 *   store over its quota does not go on refusing every write without a word.
 * - **What is shared is kept longer than it is fresh** (`sharedTtlSeconds`), under a key that names
 *   this project, the shape of what is stored, the source and a hash of the caller's key
 *   (`SHARED_CACHE_SCHEMA`) — and an entry too large for the store stays in memory alone.
 *
 * Nothing here knows what the shared store is. It is a port (`SharedStore`); the site gives it
 * Vercel's Runtime Cache (`server/utils/runtimeCache.ts`), a test gives it a map. And where there
 * is no shared level at all — development, the tests, the CI gates, the refresh job — the layered
 * cache is the memory it was given and nothing else.
 */

/** How long a read of the shared level may take before it counts as a miss. */
export const SHARED_CACHE_DEADLINE_MS = 150

/** How long the shared level is left alone after a read of it failed or ran past its deadline. */
export const SHARED_CACHE_PAUSE_MS = 30_000

/**
 * The version of what is stored under a shared key, and part of the key.
 *
 * The shared cache outlives deployments: an entry written by last week's build is read by
 * today's. So ANY change to what is stored under a key must change this — a projection that keeps
 * other fields, a field the code starts to rely on, a different envelope around the value, a key
 * that comes to mean another request. The entries of the old version are then simply never read
 * again, and age out of the store by themselves.
 */
export const SHARED_CACHE_SCHEMA = 'v1'

/**
 * The largest entry, serialised, that is written to the shared level: 1.5 MB, under the store's
 * limit of 2 MB an item. A larger one is kept in memory alone.
 */
export const SHARED_CACHE_MAX_BYTES = 1_500_000

const DAY_SECONDS = 86_400

/** The longest the shared level is asked to keep anything. */
export const SHARED_CACHE_MAX_TTL_SECONDS = 8 * DAY_SECONDS

/**
 * How long the shared level keeps an entry: a day longer than it can be served, and never more
 * than eight days.
 *
 * It is a different number from the entry's freshness on purpose. An entry has to outlive its
 * freshness to be of any use past it — as the fallback for a refresh that fails, and as the answer
 * handed over while it is refreshed (the transport's stale window) — and the store deletes what
 * its ttl has run out on. So it is kept for as long as it is fresh or may be served stale,
 * whichever is longer, plus a day in which it can still stand in for a failed refresh.
 */
export function sharedTtlSeconds(freshnessSeconds: number, staleSeconds: number): number {
  // A lifetime that is not a positive number is no lifetime: the entry is kept its one day.
  const positive = (seconds: number) => (seconds > 0 ? seconds : 0)
  const servable = Math.max(positive(freshnessSeconds), positive(staleSeconds))
  return Math.min(SHARED_CACHE_MAX_TTL_SECONDS, Math.ceil(servable) + DAY_SECONDS)
}

/**
 * The shared store, as little of it as this cache needs. `get` resolves with what is held under
 * the key, or `null`; it may be slow and it may fail, and neither is its caller's problem
 * (`createSharedLevel`). `set` keeps a JSON value for `ttlSeconds`.
 */
export interface SharedStore {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
}

export interface SharedLevelRuntime {
  now: () => number
  /**
   * Keeps a write running after the answer has gone out. What it is handed cannot reject.
   */
  keepAlive: (work: Promise<unknown>) => void
  /**
   * Where the line about a pause, or about a write that failed, goes; `console.warn` when
   * omitted.
   */
  warn?: (line: string) => void
}

/**
 * The shared store behind its guards: the read's deadline, the pause after a failure, the size
 * limit, and a write nobody waits for. One per process, because the pause is about the store and
 * not about whoever happened to read it — every layered cache of the site shares this one, so the
 * read that finds the store down spares the reads that follow, whatever they were for.
 */
export interface SharedLevel {
  /**
   * What the store holds under `key` and how long the read took, or `null` when the store was not
   * asked because it is being left alone. Never rejects, and never takes longer than the deadline:
   * a read that failed or ran out of time is a read that found nothing.
   */
  read: (key: string) => Promise<{ ms: number; value: unknown } | null>
  /**
   * Starts a write and returns at once. Never throws. A write that fails is nobody's failure: it
   * pauses nothing and is said in one line, at most once for the length of a pause.
   */
  write: (key: string, value: unknown, ttlSeconds: number) => void
}

type ReadOutcome =
  { status: 'answered'; value: unknown } | { status: 'failed'; error: unknown } | { status: 'late' }

/**
 * `read()`, or `late` once the deadline has passed. The timer is cleared the moment the read
 * settles, so an answer in time leaves nothing scheduled behind it; a read that settles after the
 * deadline settles into a handler that ignores it, so one that fails then is still a handled
 * failure. The read itself cannot be called off — the store has no way to — and is simply left to
 * end.
 */
function withinDeadline(read: () => Promise<unknown>): Promise<ReadOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'late' }), SHARED_CACHE_DEADLINE_MS)
    const settle = (outcome: ReadOutcome) => {
      clearTimeout(timer)
      resolve(outcome)
    }
    let reading: Promise<unknown>
    try {
      reading = Promise.resolve(read())
    } catch (error) {
      // A store that throws instead of rejecting has failed all the same.
      settle({ status: 'failed', error })
      return
    }
    reading.then(
      (value) => settle({ status: 'answered', value }),
      (error: unknown) => settle({ status: 'failed', error }),
    )
  })
}

/** The most of a failure's own words a warning carries: a line stays a line. */
const MAX_REASON_LENGTH = 160

function reasonOf(error: unknown): string {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
  const line = reason.replace(/\s+/g, ' ')
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}…` : line
}

export function createSharedLevel(store: SharedStore, runtime: SharedLevelRuntime): SharedLevel {
  /**
   * One line at warn level. Read when it is written, like the transport's log, so the default
   * follows `console.warn`; and a logger that fails has failed at its own work — neither a read
   * nor what is handed to the keep-alive may reject over a line.
   */
  function warn(line: string): void {
    try {
      if (runtime.warn) runtime.warn(line)
      else console.warn(line)
    } catch {
      // Nothing to do, and nowhere to say so.
    }
  }

  let pausedUntil = 0
  let writesQuietUntil = 0

  const paused = () => runtime.now() < pausedUntil

  /**
   * A read went wrong: the store is left alone from now on, and says so once. Reads that were
   * already out when the pause began fail into it without another line — one page asks for
   * several things at once, and they all find the same store down at the same moment.
   */
  function pause(what: string): void {
    if (paused()) return
    pausedUntil = runtime.now() + SHARED_CACHE_PAUSE_MS
    warn(`[shared-cache] ${what}; left alone for ${SHARED_CACHE_PAUSE_MS / 1000} s`)
  }

  /**
   * A write went wrong. Nothing is paused for it: reads are what an answer gains from, and a
   * store can refuse writes — over its quota, say — while it still answers them. But it is said,
   * once for the length of a pause, or every write could fail for days and the only sign would
   * be a hit rate that never moves. Not while the store is being left alone, though: the line
   * about that has been written, and a write that was out when the pause began adds nothing.
   */
  function writeFailed(error: unknown): void {
    const at = runtime.now()
    if (at < pausedUntil || at < writesQuietUntil) return
    writesQuietUntil = at + SHARED_CACHE_PAUSE_MS
    const quiet = `not reported again for ${SHARED_CACHE_PAUSE_MS / 1000} s`
    warn(`[shared-cache] a write failed (${reasonOf(error)}); reads go on, ${quiet}`)
  }

  /** A write as it is handed to the keep-alive: it cannot reject, however the store fails. */
  function written(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    let writing: Promise<unknown>
    try {
      writing = Promise.resolve(store.set(key, value, ttlSeconds))
    } catch (error) {
      // A store that throws instead of rejecting has failed all the same.
      writing = Promise.reject(error)
    }
    return writing.then(() => undefined, writeFailed)
  }

  return {
    async read(key) {
      if (paused()) return null
      const startedAt = runtime.now()
      const outcome = await withinDeadline(() => store.get(key))
      const ms = Math.max(0, runtime.now() - startedAt)
      if (outcome.status === 'answered') return { ms, value: outcome.value ?? null }
      pause(
        outcome.status === 'late'
          ? `a read took longer than ${SHARED_CACHE_DEADLINE_MS} ms`
          : `a read failed (${reasonOf(outcome.error)})`,
      )
      return { ms, value: null }
    },

    write(key, value, ttlSeconds) {
      try {
        // Left alone means left alone: a store that is down is not handed writes to hang on to.
        if (paused()) return
        if (Buffer.byteLength(JSON.stringify(value)) > SHARED_CACHE_MAX_BYTES) return
        runtime.keepAlive(written(key, value, ttlSeconds))
      } catch {
        // A value that cannot be serialised, a keep-alive that will not take the work: the answer
        // this write follows has memory's copy, and is owed nothing more.
      }
    },
  }
}

/** What a layered cache keeps: anything with a lifetime, and the moment it was stored. */
export interface LayeredEntry {
  expiresAt: number
  /** The newer of two entries is told by it; an entry without one is never shared. */
  storedAt?: number
}

/** The instance's own level: the bounded cache every one of these was before it had a second. */
export interface MemoryLevel<T> {
  get: (key: string) => Promise<T | null>
  set: (key: string, entry: T) => Promise<void>
}

export interface LayeredCacheOptions<T extends LayeredEntry> {
  memory: MemoryLevel<T>
  /** The shared level, where there is one. Without it the layered cache is `memory`, exactly. */
  shared: SharedLevel | undefined
  /** Whose answers these are — `RAWG`, `STEAM` — as the shared key names them. */
  source: string
  /** The hash the caller's key goes through: no shared key carries anything a visitor typed. */
  hashKey: (key: string) => string
  now: () => number
}

export interface LayeredCache<T extends LayeredEntry> {
  /**
   * The entry under `key`, however old, or `null`. `onSharedRead` is told, before this resolves,
   * when the shared level was read: how long it took and whether its entry is the one returned.
   */
  get: (key: string, onSharedRead?: (read: SharedRead) => void) => Promise<T | null>
  /**
   * Keeps `entry`. `staleSeconds` is for how long after it was stored the entry may still be
   * served while it is refreshed, which the shared level has to keep it through.
   */
  set: (key: string, entry: T, staleSeconds?: number) => Promise<void>
}

/**
 * What the shared store handed back, when it is an entry this cache could have written: an object
 * with the two moments every shared entry carries. Anything else is nothing at all — whatever is
 * inside `value` is its reader's to judge, as it is for an entry out of memory.
 */
function asEntry<T extends LayeredEntry>(stored: unknown): T | null {
  if (typeof stored !== 'object' || stored === null) return null
  const { expiresAt, storedAt } = stored as { expiresAt?: unknown; storedAt?: unknown }
  return Number.isFinite(expiresAt) && Number.isFinite(storedAt) ? (stored as T) : null
}

/** When an entry was stored, for telling the newer of two; one that does not say is the older. */
const storedAtOf = (entry: LayeredEntry) => entry.storedAt ?? Number.NEGATIVE_INFINITY

export function createLayeredCache<T extends LayeredEntry>(
  options: LayeredCacheOptions<T>,
): LayeredCache<T> {
  const { memory, shared, source, hashKey, now } = options
  // No second level: the very functions of the first, so that nothing can differ.
  if (!shared) return { get: memory.get, set: memory.set }

  const sharedKey = (key: string) => `${SHARED_CACHE_SCHEMA}.${source}.${hashKey(key)}`

  return {
    async get(key, onSharedRead) {
      const local = await memory.get(key)
      if (local && local.expiresAt > now()) return local

      const read = await shared.read(sharedKey(key))
      if (read === null) return local
      const remote = asEntry<T>(read.value)
      // Memory is asked again, because the read took time: a refresh of this instance's own may
      // have landed meanwhile, and what it brought must be neither covered by an older entry from
      // elsewhere nor passed over for the one this call first found.
      const held = (await memory.get(key)) ?? local
      // The newer of the two wins, and memory's own wins a tie: the instance that wrote an entry
      // reads back the very one it holds, and has nothing to copy.
      const newer = remote !== null && (held === null || storedAtOf(remote) > storedAtOf(held))
      try {
        onSharedRead?.({ ms: read.ms, hit: newer })
      } catch {
        // Whoever listens is measuring the read, and is no part of it.
      }
      if (!newer) return held
      await memory.set(key, remote)
      return remote
    },

    async set(key, entry, staleSeconds = 0) {
      await memory.set(key, entry)
      // An entry that does not say when it was stored cannot be told from an older one elsewhere.
      if (entry.storedAt === undefined) return
      const freshnessSeconds = (entry.expiresAt - entry.storedAt) / 1000
      shared.write(sharedKey(key), entry, sharedTtlSeconds(freshnessSeconds, staleSeconds))
    },
  }
}
