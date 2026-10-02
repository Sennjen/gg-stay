import { createUpstreamFetch, type UpstreamCacheEntry } from '../upstream/createUpstreamFetch'
import { UpstreamError } from '../upstream/errors'
import type { RawgList } from './types'

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
  /** A tighter timeout for this call than the transport's 5 s. */
  timeoutMs?: number
  /** Fewer attempts for this call than the transport's two (one retry). */
  maxAttempts?: number
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

/**
 * A RAWG list answer, as the site's catalog and landing read one. RAWG has been seen answering with
 * an empty body under a 200, which the transport hands back once without caching it; here that
 * body — or any answer that is not a list — becomes the upstream error it stands for, so the page
 * fails through the resolvers' error mapping and never on a property read.
 */
export function rawgListOrThrow<T>(body: unknown): RawgList<T> {
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body)
  const results = isObject ? (body as RawgList<T>).results : undefined
  if (!isObject || (results !== undefined && results !== null && !Array.isArray(results))) {
    throw new UpstreamError('RAWG', 'ERROR')
  }
  return body as RawgList<T>
}

/** A `dates` window that is exactly one calendar year, as a year filter or shelf writes it. */
const CALENDAR_YEAR = /^(\d{4})-01-01,\1-12-31$/

/**
 * The recorded fixture a request is served from in fixture mode. Keyed by path, with one
 * exception: the games list for a single calendar year has its own recording, so the landing's
 * "best of this year" shelf — and the catalog page its link opens — show a year's worth of rated
 * games rather than the general list. The year itself is not in the name, so the fixture keeps
 * answering as the calendar moves on.
 */
export function fixtureName(path: string, params?: RawgParams): string {
  const [root, slug, sub] = path.split('/')
  if (root === 'games' && slug) return sub ? `game-${slug}-${sub}` : `game-${slug}`
  if (root === 'games' && CALENDAR_YEAR.test(String(params?.dates ?? ''))) {
    return 'games-calendar-year'
  }
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
      fixtureName: ({ path, params }) => fixtureName(path, params),
      ttlFor: ({ path, options }) => options?.ttl ?? ttlFor(path),
      limitsFor: ({ options }) =>
        options && (options.timeoutMs !== undefined || options.maxAttempts !== undefined)
          ? { timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts }
          : undefined,
    },
    deps,
  )

  return (path, params, options) => fetchUpstream({ path, params, options })
}
