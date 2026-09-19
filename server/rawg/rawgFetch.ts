const BASE_URL = 'https://api.rawg.io/api'
const TIMEOUT_MS = 5_000
const MIN_INTERVAL_MS = 250 // 4 requests per second
const MAX_ATTEMPTS = 2

export type RawgParams = Record<string, string | number | undefined>
export type UpstreamKind = 'RATE_LIMITED' | 'TIMEOUT' | 'ERROR' | 'NOT_FOUND'

export class UpstreamError extends Error {
  constructor(
    public readonly kind: UpstreamKind,
    public readonly status?: number,
  ) {
    super(`RAWG upstream failure: ${kind}${status ? ` (${status})` : ''}`)
    this.name = 'UpstreamError'
  }
}

export interface CacheEntry {
  value: unknown
  expiresAt: number
}

export interface RawgDeps {
  apiKey: string
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  cache: {
    get: (key: string) => Promise<CacheEntry | null>
    set: (key: string, entry: CacheEntry) => Promise<void>
  }
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface RawgFetchOptions {
  /** Overrides the ttl (seconds) `ttlFor(path)` would otherwise pick for this call's cache entry. */
  ttl?: number
}

export type RawgFetch = (
  path: string,
  params?: RawgParams,
  options?: RawgFetchOptions,
) => Promise<unknown>

function cleanParams(params: RawgParams = {}): [string, string][] {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
}

export function normalizeKey(path: string, params?: RawgParams): string {
  const query = cleanParams(params)
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  return query ? `${path}?${query}` : path
}

export function ttlFor(path: string): number {
  if (path === 'games') return 600
  if (path.startsWith('games/')) return 86_400
  return 604_800
}

export function fixtureName(path: string): string {
  const [root, slug, sub] = path.split('/')
  if (root === 'games' && slug) return sub ? `game-${slug}-${sub}` : `game-${slug}`
  return root ?? path
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function createRawgFetch(deps: RawgDeps): RawgFetch {
  let nextSlot = 0

  async function throttle(now: number): Promise<void> {
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + MIN_INTERVAL_MS
    if (slot > now) await deps.sleep(slot - now)
  }

  async function attempt(url: string, now: number): Promise<unknown> {
    await throttle(now)
    let response: { status: number; body: unknown }
    try {
      response = await deps.fetchJson(url, AbortSignal.timeout(TIMEOUT_MS))
    } catch (error) {
      throw new UpstreamError(isTimeout(error) ? 'TIMEOUT' : 'ERROR')
    }
    if (response.status === 429) throw new UpstreamError('RATE_LIMITED', 429)
    if (response.status === 404) throw new UpstreamError('NOT_FOUND', 404)
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError('ERROR', response.status)
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
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // The first attempt reuses the `now` captured at the top of the logical
      // call (see rawgFetch below) so that concurrent calls each reserve
      // their throttle slot against a shared reference point. A retry
      // attempt, however, happens strictly after real time has passed (the
      // failed fetch, its timeout, etc.), so it must re-read the clock
      // instead of reusing that stale value — otherwise throttle() would
      // wait out a slot that has already elapsed, needlessly slowing down
      // retries and dragging real throughput under the 4rps target.
      const attemptNow = i === 0 ? now : deps.now()
      try {
        return await attempt(url, attemptNow)
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
      }
    }
    throw lastError
  }

  return async function rawgFetch(path, params, options) {
    // Capture `now` synchronously, before the first await, so concurrent
    // calls (e.g. Promise.all(...)) all reserve throttle slots against the
    // same reference point instead of one call's simulated sleep (in tests)
    // or real elapsed time (in production) skewing another in-flight call's
    // notion of "now". This is purely about keeping slot assignment
    // deterministic across concurrent siblings — it is not a workaround for
    // any production rate-limit bug.
    const now = deps.now()

    if (deps.fixtures) {
      const fixture = await deps.readFixture(fixtureName(path))
      if (fixture === null) throw new UpstreamError('NOT_FOUND', 404)
      return fixture
    }

    const key = normalizeKey(path, params)
    const cached = await deps.cache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    const url = new URL(`${BASE_URL}/${path}`)
    for (const [name, value] of cleanParams(params)) url.searchParams.set(name, value)
    url.searchParams.set('key', deps.apiKey)

    try {
      const value = await fetchWithRetry(url.toString(), now)
      const ttl = options?.ttl ?? ttlFor(path)
      await deps.cache.set(key, { value, expiresAt: now + ttl * 1000 })
      return value
    } catch (error) {
      const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
      if (cached && !notFound) return cached.value
      throw error
    }
  }
}
