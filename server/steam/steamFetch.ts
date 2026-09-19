import { UpstreamError } from '../rawg/rawgFetch'

const BASE_URL = 'https://store.steampowered.com/api/appdetails'
const TIMEOUT_MS = 5_000
// Steam's undocumented limit is roughly 200 requests per 5 minutes; one request every 1.5s
// stays comfortably under that without needing a token-bucket over a longer window.
const MIN_INTERVAL_MS = 1_500
const MAX_ATTEMPTS = 2
const DEFAULT_TTL = 86_400 // 24h, per the landing resolver's caching rule for Steam trailers.

export interface SteamCacheEntry {
  value: unknown
  expiresAt: number
}

export interface SteamDeps {
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  cache: {
    get: (key: string) => Promise<SteamCacheEntry | null>
    set: (key: string, entry: SteamCacheEntry) => Promise<void>
  }
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface SteamFetchOptions {
  ttl?: number
}

export type SteamFetch = (appId: string, options?: SteamFetchOptions) => Promise<unknown>

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function fixtureName(appId: string): string {
  return `appdetails-${appId}`
}

export function createSteamFetch(deps: SteamDeps): SteamFetch {
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
      // Mirrors server/rawg/rawgFetch.ts: the first attempt reuses the `now` captured before this
      // logical call started, but a retry re-reads the clock so it doesn't wait out a throttle
      // slot that has already elapsed while the first attempt was in flight.
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

  return async function steamFetch(appId, options) {
    const now = deps.now()

    if (deps.fixtures) {
      const fixture = await deps.readFixture(fixtureName(appId))
      if (fixture === null) throw new UpstreamError('NOT_FOUND', 404)
      return fixture
    }

    const key = appId
    const cached = await deps.cache.get(key)
    if (cached && cached.expiresAt > now) return cached.value

    const url = new URL(BASE_URL)
    url.searchParams.set('appids', appId)
    url.searchParams.set('cc', 'ua')
    url.searchParams.set('l', 'ukrainian')
    url.searchParams.set('filters', 'movies')

    try {
      const value = await fetchWithRetry(url.toString(), now)
      const ttl = options?.ttl ?? DEFAULT_TTL
      await deps.cache.set(key, { value, expiresAt: now + ttl * 1000 })
      return value
    } catch (error) {
      const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
      if (cached && !notFound) return cached.value
      throw error
    }
  }
}
