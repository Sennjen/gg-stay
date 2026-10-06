import { UpstreamError, type UpstreamSource } from './errors'

/**
 * The transport every third-party API in this app goes through: one request at a time per
 * `minIntervalMs`, an abort-signal timeout, one retry on a timeout or a 5xx, a read-through cache
 * with a per-request ttl, and the cached value served as a fallback when a refresh fails
 * (stale-if-error). RAWG and Steam had a near-verbatim copy of all of it each, which is how the
 * Steam transport ended up throwing errors that said "RAWG".
 *
 * A call for something another call is already fetching joins that request instead of sending a
 * second one — see `inFlight` below for exactly which calls count as the same. That makes one rule
 * for every caller: what a call resolves with is read-only, because the same object may be in
 * another caller's hands, and in the cache's.
 *
 * Everything that differs between the two is a parameter: the source name, the throttle interval,
 * how a request becomes a URL, a cache key, a fixture name and a ttl, and an optional projection
 * applied before a payload is cached. Everything the caller must be able to substitute in a test
 * (fetch, fixtures, cache, clock, sleep, the log) is injected, which is what lets the transport
 * tests drive throttling, retries and clock drift deterministically without a mock library.
 */

export interface UpstreamCacheEntry {
  value: unknown
  expiresAt: number
}

export interface UpstreamRuntime {
  /** Serve the recorded fixture set instead of the network (see `RAWG_FIXTURES`). */
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  cache: {
    get: (key: string) => Promise<UpstreamCacheEntry | null>
    set: (key: string, entry: UpstreamCacheEntry) => Promise<void>
  }
  now: () => number
  sleep: (ms: number) => Promise<void>
  /**
   * Where the line about an attempt that failed or was slow goes (see `SLOW_ATTEMPT_MS`).
   * `console.info` when omitted; a test passes its own, to read the lines or to keep them out of
   * its output.
   */
  log?: (line: string) => void
}

export interface UpstreamConfig<TRequest> {
  source: UpstreamSource
  /** Minimum spacing between two outgoing requests of this upstream, in ms. */
  minIntervalMs: number
  timeoutMs: number
  /** Total attempts per logical call, retries included. */
  maxAttempts: number
  buildUrl: (request: TRequest) => string
  cacheKey: (request: TRequest) => string
  fixtureName: (request: TRequest) => string
  /** Cache lifetime in seconds for this particular request. */
  ttlFor: (request: TRequest) => number
  /** Narrows a payload before it is cached and returned; identity when omitted. */
  project?: (value: unknown) => unknown
  /** A tighter timeout or fewer attempts for one request than the upstream's defaults. */
  limitsFor?: (request: TRequest) => UpstreamLimits | undefined
}

export interface UpstreamLimits {
  timeoutMs?: number
  maxAttempts?: number
}

/**
 * One call to an upstream.
 *
 * `onCached` is for a caller that measures what its calls cost it — the collector behind the
 * `Server-Timing` header, `server/graphql/serverTiming.ts`. It is called, before the answer is
 * handed over, when a fresh cache entry answered and the upstream was not asked: the one case in
 * which a call waited for nobody. An answer the upstream gave is not that, and neither is a
 * request another caller had already sent, a stale entry that stood in for a failed refresh, or a
 * recorded fixture, which is the upstream of fixture mode. So a caller that is never told may
 * count every one of its calls as a call.
 */
export type UpstreamFetch<TRequest> = (request: TRequest, onCached?: () => void) => Promise<unknown>

/** What one logical call ended with, and whether the cache alone supplied it. */
interface Loaded {
  value: unknown
  cached: boolean
}

/**
 * How long an attempt may take before it is logged even though it succeeded. RAWG answers most
 * requests in well under a second; the ones that take two or more are the tail the game page's
 * time budget exists for, and one line each is the evidence for deciding later whether a second,
 * parallel attempt would have beaten them.
 */
export const SLOW_ATTEMPT_MS = 2_000

/** The most of a cache key's path a log line carries: a key is as long as its caller makes it. */
const MAX_LOGGED_PATH_LENGTH = 120

/**
 * What a log line may say about a request: the path of its cache key, and never the URL. The URL
 * carries the API key; a cache key never does, and its query string — which can hold a search term
 * a visitor typed — is left out too. Cut to a fixed length, so that a line stays a line whatever a
 * caller put in the key.
 */
function loggedPath(key: string): string {
  const path = key.split('?', 1)[0] ?? ''
  return path.length > MAX_LOGGED_PATH_LENGTH ? `${path.slice(0, MAX_LOGGED_PATH_LENGTH)}…` : path
}

/** How an attempt ended, in the transport's own words: `OK`, or the error's kind and status. */
function outcomeOf(error: UpstreamError | null): string {
  if (!error) return 'OK'
  return error.status === undefined ? error.kind : `${error.kind} (${error.status})`
}

/**
 * Whether a body may be kept. Every API behind this transport answers with a JSON object, so
 * anything else under a 200 — RAWG has been seen sending an empty body, which parses to `null` — is
 * a bad answer, not a result: it is handed to the caller once and forgotten. Cached, it would be
 * served back to the caller's own retry for the whole ttl, and later as a stale-if-error fallback.
 */
function isJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function createUpstreamFetch<TRequest>(
  config: UpstreamConfig<TRequest>,
  runtime: UpstreamRuntime,
): UpstreamFetch<TRequest> {
  const project = config.project ?? ((value: unknown) => value)
  // Read when a line is written, not when the transport is built, so the default follows whatever
  // `console.info` is at that moment.
  const log = runtime.log ?? ((line: string) => console.info(line))
  let nextSlot = 0

  /**
   * The calls that are still running, so that a second call for the same thing joins the first
   * instead of sending a request of its own.
   *
   * "The same thing" is the same cache key under the same limits. The key is what the cache
   * already treats as one answer; the limits are part of it because a caller that asked for one
   * four-second attempt must not be made to sit through another caller's two five-second ones.
   * Limits are compared as they take effect, so asking for the defaults by name is asking for the
   * defaults. The ttl is not compared: whoever writes a cache entry has always decided how long it
   * lives, and here that is the call that started the request.
   *
   * Without this, a page that stopped waiting for a slow answer and asked again a few seconds
   * later — which is what the game page does — would start a second slow request beside the
   * first, instead of collecting the first one's answer the moment it lands.
   *
   * Everyone who joins gets exactly what the first caller gets: the body, the stale entry it fell
   * back to, or its error. A failure is shared only with the callers that were already waiting for
   * it. The entry is removed before the outcome can be observed, so a call made after a failure
   * always sends a request of its own.
   *
   * An entry lasts as long as its call and no longer: the two cache calls, and at most
   * `maxAttempts` attempts, each waiting its turn at the limiter and each ended by its own abort
   * timeout however the upstream behaves. That bounds it in a process that keeps running. A
   * platform that freezes an instance in the middle of a call freezes the entry with it: it is
   * still there after the thaw, and a caller that joins it then gets a request answered, or timed
   * out, long after it was sent. So a request a caller stops waiting for should be handed to the
   * platform to finish (`leaveRunning` in `server/graphql/budget.ts`), as the game page and the
   * catalog do.
   *
   * "Exactly" means the same object, not a copy of it. A caller that joined holds the very value
   * the first caller holds, and so does a cache that keeps what it is handed — the refresh job's
   * map does, and so do the tests'; the site's storage serialises on the way in, which is that
   * storage's habit and not this transport's promise. So whatever a call resolves with must be
   * treated as read-only: map it, filter it, sort a copy of it. A body changed in place would
   * change under another request, and only when two of them happen to overlap, which no test
   * with a single caller will ever show. Nothing is frozen to enforce this. The mappers and the
   * job's stages that read these bodies build new objects from them, and a new reader has to do
   * the same.
   */
  const inFlight = new Map<string, Promise<Loaded>>()

  async function throttle(now: number): Promise<void> {
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + config.minIntervalMs
    if (slot > now) await runtime.sleep(slot - now)
  }

  /** One request as the upstream answered it: its body, or the `UpstreamError` it stands for. */
  async function send(url: string, timeoutMs: number): Promise<unknown> {
    let response: { status: number; body: unknown }
    try {
      response = await runtime.fetchJson(url, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      throw new UpstreamError(config.source, isTimeout(error) ? 'TIMEOUT' : 'ERROR')
    }
    if (response.status === 429) throw new UpstreamError(config.source, 'RATE_LIMITED', 429)
    if (response.status === 404) throw new UpstreamError(config.source, 'NOT_FOUND', 404)
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(config.source, 'ERROR', response.status)
    }
    return response.body
  }

  /**
   * One `console.info` line for an attempt worth knowing about: one that timed out, one that
   * failed, and one that took `SLOW_ATTEMPT_MS` or longer whatever came of it. It names the
   * source, the path of the cache key, which attempt it was, how long the upstream took, and how
   * it ended — see `loggedPath` for what is deliberately not in it.
   *
   * The time is the upstream's own: it is measured from the moment the request is sent, after the
   * limiter has let it through, because a line that included our own queue would say nothing
   * about how slow RAWG was. A 404 is an answer rather than a failure, here as in the cache rule
   * below, and is logged only when it was slow: anyone can ask for a game that does not exist,
   * and a line per miss would hand the log to whoever does.
   */
  function report(path: string, number: number, startedAt: number, error: UpstreamError | null) {
    const ms = Math.max(0, runtime.now() - startedAt)
    const failed = error !== null && error.kind !== 'NOT_FOUND'
    if (!failed && ms < SLOW_ATTEMPT_MS) return
    log(`[upstream] ${config.source} ${path} attempt ${number}: ${ms} ms, ${outcomeOf(error)}`)
  }

  async function attempt(
    url: string,
    now: number,
    timeoutMs: number,
    path: string,
    number: number,
  ): Promise<unknown> {
    await throttle(now)
    const startedAt = runtime.now()
    try {
      const body = await send(url, timeoutMs)
      report(path, number, startedAt, null)
      return body
    } catch (error) {
      // `send` raises nothing but `UpstreamError`; anything else would be a bug of ours, and is
      // passed on untouched rather than described.
      if (error instanceof UpstreamError) report(path, number, startedAt, error)
      throw error
    }
  }

  function isRetryable(error: unknown): boolean {
    if (!(error instanceof UpstreamError)) return false
    if (error.kind === 'TIMEOUT') return true
    return error.kind === 'ERROR' && (error.status === undefined || error.status >= 500)
  }

  async function fetchWithRetry(
    url: string,
    now: number,
    limits: Required<UpstreamLimits>,
    path: string,
  ): Promise<unknown> {
    let lastError: unknown
    for (let i = 0; i < limits.maxAttempts; i++) {
      // The first attempt reuses the `now` captured at the top of the logical call (below) so that
      // concurrent calls each reserve their throttle slot against a shared reference point. A retry
      // attempt, however, happens strictly after real time has passed (the failed fetch, its
      // timeout, etc.), so it must re-read the clock instead of reusing that stale value —
      // otherwise throttle() would wait out a slot that has already elapsed, needlessly slowing
      // down retries and dragging real throughput under the target rate.
      const attemptNow = i === 0 ? now : runtime.now()
      try {
        return await attempt(url, attemptNow, limits.timeoutMs, path, i + 1)
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
      }
    }
    throw lastError
  }

  /**
   * One logical call, from the cache read to the cache write. `cached` is true for the one answer
   * nobody was asked for: a fresh entry. A stale entry that stands in for a failed refresh is not
   * that — the upstream was asked first, and whoever called waited for it to fail.
   */
  async function load(
    request: TRequest,
    key: string,
    now: number,
    limits: Required<UpstreamLimits>,
  ): Promise<Loaded> {
    const entry = await runtime.cache.get(key)
    // An entry an older build cached from a bad body is no entry at all.
    const cached = entry && isJsonObject(entry.value) ? entry : null
    if (cached && cached.expiresAt > now) return { value: cached.value, cached: true }

    try {
      const body = await fetchWithRetry(config.buildUrl(request), now, limits, loggedPath(key))
      const value = project(body)
      if (isJsonObject(body)) {
        await runtime.cache.set(key, { value, expiresAt: now + config.ttlFor(request) * 1000 })
      }
      return { value, cached: false }
    } catch (error) {
      // A 404 is an answer, not a failure: serving a stale body for a game that no longer exists
      // would be worse than the error.
      const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
      if (cached && !notFound) return { value: cached.value, cached: false }
      throw error
    }
  }

  /**
   * What `call` ended with, for one of the callers waiting on it — who is told first, when the
   * cache alone supplied it, so the caller knows what its call was by the time it has the answer.
   * Callers that share a call share that word as they share its answer: each of them is told.
   */
  async function answerOf(call: Promise<Loaded>, onCached?: () => void): Promise<unknown> {
    const { value, cached } = await call
    if (cached) onCached?.()
    return value
  }

  return async function upstreamFetch(request: TRequest, onCached?: () => void): Promise<unknown> {
    // Capture `now` synchronously, before the first await, so concurrent calls (e.g.
    // Promise.all(...)) all reserve throttle slots against the same reference point instead of one
    // call's simulated sleep (in tests) or real elapsed time (in production) skewing another
    // in-flight call's notion of "now". This is purely about keeping slot assignment deterministic
    // across concurrent siblings — it is not a workaround for any production rate-limit bug.
    const now = runtime.now()

    if (runtime.fixtures) {
      const fixture = await runtime.readFixture(config.fixtureName(request))
      if (fixture === null) throw new UpstreamError(config.source, 'NOT_FOUND', 404)
      return project(fixture)
    }

    const key = config.cacheKey(request)
    const asked = config.limitsFor?.(request)
    const limits = {
      timeoutMs: asked?.timeoutMs ?? config.timeoutMs,
      maxAttempts: asked?.maxAttempts ?? config.maxAttempts,
    }
    // Looked up and registered before anything is awaited: two calls made in the same turn of the
    // event loop must find each other, and they would not if either had already yielded.
    const sharedBy = `${limits.timeoutMs}/${limits.maxAttempts} ${key}`
    const running = inFlight.get(sharedBy)
    if (running) return answerOf(running, onCached)

    // `load` is an async function, so nothing it does can run this `finally` before the entry is
    // set; and the promise callers hold is the one that settles after the entry is gone.
    const call = load(request, key, now, limits).finally(() => inFlight.delete(sharedBy))
    inFlight.set(sharedBy, call)
    return answerOf(call, onCached)
  }
}
