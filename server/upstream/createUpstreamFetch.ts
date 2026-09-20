import { UpstreamError, type UpstreamSource } from './errors'

/**
 * The transport every third-party API in this app goes through: one request at a time per
 * `minIntervalMs`, an abort-signal timeout, one retry on a timeout or a 5xx, a read-through cache
 * with a per-request ttl, and the cached value served as a fallback when a refresh fails
 * (stale-if-error). RAWG and Steam had a near-verbatim copy of all of it each, which is how the
 * Steam transport ended up throwing errors that said "RAWG".
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

  async function throttle(now: number): Promise<void> {
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + config.minIntervalMs
    if (slot > now) await runtime.sleep(slot - now)
  }

  async function attempt(url: string, now: number): Promise<unknown> {
    await throttle(now)
    let response: { status: number; body: unknown }
    try {
      response = await runtime.fetchJson(url, AbortSignal.timeout(config.timeoutMs))
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

  async function fetchWithRetry(url: string, now: number): Promise<unknown> {
    let lastError: unknown
    for (let i = 0; i < config.maxAttempts; i++) {
      // The first attempt reuses the `now` captured at the top of the logical call (below) so that
      // concurrent calls each reserve their throttle slot against a shared reference point. A retry
      // attempt, however, happens strictly after real time has passed (the failed fetch, its
      // timeout, etc.), so it must re-read the clock instead of reusing that stale value —
      // otherwise throttle() would wait out a slot that has already elapsed, needlessly slowing
      // down retries and dragging real throughput under the target rate.
      const attemptNow = i === 0 ? now : runtime.now()
      try {
        return await attempt(url, attemptNow)
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
      }
    }
    throw lastError
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
    const cached = await runtime.cache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    try {
      const value = project(await fetchWithRetry(config.buildUrl(request), now))
      await runtime.cache.set(key, { value, expiresAt: now + config.ttlFor(request) * 1000 })
      return value
    } catch (error) {
      // A 404 is an answer, not a failure: serving a stale body for a game that no longer exists
      // would be worse than the error.
      const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
      if (cached && !notFound) return cached.value
      throw error
    }
  }
}
