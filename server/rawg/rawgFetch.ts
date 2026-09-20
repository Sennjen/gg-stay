import { createUpstreamFetch, type UpstreamCacheEntry } from '../upstream/createUpstreamFetch'

const BASE_URL = 'https://api.rawg.io/api'
const TIMEOUT_MS = 5_000
const MIN_INTERVAL_MS = 250 // 4 requests per second
const MAX_ATTEMPTS = 2

export type RawgParams = Record<string, string | number | undefined>

/** Re-exported so existing importers keep one place to reach the transport's error type. */
export { UpstreamError } from '../upstream/errors'
export type { UpstreamKind, UpstreamSource } from '../upstream/errors'

export type CacheEntry = UpstreamCacheEntry

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

interface RawgRequest {
  path: string
  params?: RawgParams
  options?: RawgFetchOptions
}

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

/**
 * RAWG's share of the shared upstream transport (see server/upstream/createUpstreamFetch.ts):
 * the base URL and API key, the per-path ttl rule and the 4 rps limiter. Everything else —
 * throttling, timeout, retry, cache, stale-if-error — lives there, once.
 */
export function createRawgFetch(deps: RawgDeps): RawgFetch {
  const fetchUpstream = createUpstreamFetch<RawgRequest>(
    {
      source: 'RAWG',
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      buildUrl: ({ path, params }) => {
        const url = new URL(`${BASE_URL}/${path}`)
        for (const [name, value] of cleanParams(params)) url.searchParams.set(name, value)
        url.searchParams.set('key', deps.apiKey)
        return url.toString()
      },
      cacheKey: ({ path, params }) => normalizeKey(path, params),
      fixtureName: ({ path }) => fixtureName(path),
      ttlFor: ({ path, options }) => options?.ttl ?? ttlFor(path),
    },
    deps,
  )

  return (path, params, options) => fetchUpstream({ path, params, options })
}
