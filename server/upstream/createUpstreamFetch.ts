import { UpstreamError, type UpstreamSource } from './errors'

/**
 * The transport every third-party API in this app goes through: one request at a time per
 * `minIntervalMs`, an abort-signal timeout, one retry on a timeout or a 5xx, a read-through cache
 * with a per-request ttl, and the cached value served as a fallback when a refresh fails
 * (stale-if-error). RAWG and Steam had a near-verbatim copy of all of it each, which is how the
 * Steam transport ended up throwing errors that said "RAWG".
 *
 * A call for something another call is already fetching joins that request instead of sending a
 * second one — see `inFlight` below for exactly which calls count as the same.
 *
 * Everything that differs between the two is a parameter: the source name, the throttle interval,
 * how a request becomes a URL, a cache key, a fixture name and a ttl, and an optional projection
 * applied before a payload is cached. Everything the caller must be able to substitute in a test
 * (fetch, fixtures, cache, clock, sleep) is injected, which is what lets the transport tests drive
 * throttling, retries and clock drift deterministically without a mock library.
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
): (request: TRequest) => Promise<unknown> {
  const project = config.project ?? ((value: unknown) => value)
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
   * always sends a request of its own. And an entry cannot linger: every attempt carries its own
   * abort timeout, so a call ends after at most `maxAttempts` of them however the upstream behaves.
   */
  const inFlight = new Map<string, Promise<unknown>>()

  async function throttle(now: number): Promise<void> {
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + config.minIntervalMs
    if (slot > now) await runtime.sleep(slot - now)
  }

  async function attempt(url: string, now: number, timeoutMs: number): Promise<unknown> {
    await throttle(now)
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

  function isRetryable(error: unknown): boolean {
    if (!(error instanceof UpstreamError)) return false
    if (error.kind === 'TIMEOUT') return true
    return error.kind === 'ERROR' && (error.status === undefined || error.status >= 500)
  }

  async function fetchWithRetry(
    url: string,
    now: number,
    limits: Required<UpstreamLimits>,
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
        return await attempt(url, attemptNow, limits.timeoutMs)
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
      }
    }
    throw lastError
  }

  /** One logical call, from the cache read to the cache write. */
  async function load(
    request: TRequest,
    key: string,
    now: number,
    limits: Required<UpstreamLimits>,
  ): Promise<unknown> {
    const entry = await runtime.cache.get(key)
    // An entry an older build cached from a bad body is no entry at all.
    const cached = entry && isJsonObject(entry.value) ? entry : null
    if (cached && cached.expiresAt > now) return cached.value

    try {
      const body = await fetchWithRetry(config.buildUrl(request), now, limits)
      const value = project(body)
      if (isJsonObject(body)) {
        await runtime.cache.set(key, { value, expiresAt: now + config.ttlFor(request) * 1000 })
      }
      return value
    } catch (error) {
      // A 404 is an answer, not a failure: serving a stale body for a game that no longer exists
      // would be worse than the error.
      const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
      if (cached && !notFound) return cached.value
      throw error
    }
  }

  return async function upstreamFetch(request: TRequest): Promise<unknown> {
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
    if (running) return running

    // `load` is an async function, so nothing it does can run this `finally` before the entry is
    // set; and the promise callers hold is the one that settles after the entry is gone.
    const call = load(request, key, now, limits).finally(() => inFlight.delete(sharedBy))
    inFlight.set(sharedBy, call)
    return call
  }
}
