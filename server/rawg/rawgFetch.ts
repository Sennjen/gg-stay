import {
  createUpstreamFetch,
  STALE_WHILE_REVALIDATE_SECONDS,
  type SharedRead,
  type UpstreamCache,
  type UpstreamCacheEntry,
} from '../upstream/createUpstreamFetch'
import { UpstreamError } from '../upstream/errors'
import type { RawgList } from './types'

const BASE_URL = 'https://api.rawg.io/api'
const TIMEOUT_MS = 5_000
const MIN_INTERVAL_MS = 250 // 4 requests per second, after whatever burst the wiring gives it
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
  cache: UpstreamCache
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Where the transport's line about a slow or failed attempt goes; `console.info` when omitted. */
  log?: (line: string) => void
  /**
   * Keeps a refresh running behind a stale answer, and switches the stale window on: without it
   * every answer past its ttl is asked for again and waited for (`UpstreamRuntime.keepAlive`).
   */
  keepAlive?: (work: Promise<unknown>) => void
  /**
   * How many requests may leave together when the limiter has been idle (`UpstreamConfig.burst`).
   * One when omitted: a request per quarter of a second and nothing else, which is what the
   * refresh job walks RAWG at. Only the site names another (`RAWG_BURST`, `server/utils/rawg.ts`).
   */
  burst?: number
}

export interface RawgFetchOptions {
  /** Overrides the ttl (seconds) `ttlFor(path)` would otherwise pick for this call's cache entry. */
  ttl?: number
  /** A tighter timeout for this call than the transport's 5 s. */
  timeoutMs?: number
  /** Fewer attempts for this call than the transport's two (one retry). */
  maxAttempts?: number
  /**
   * Called when this call was answered from the cache and RAWG was not asked — see `UpstreamFetch`.
   * It is about the call, not about the request: it is part of neither the cache key nor what
   * makes two calls one request.
   */
  onCached?: () => void
  /**
   * Called when this call's read of the cache went beyond the instance's memory, to the cache
   * every instance shares — see `UpstreamFetch`. About the call, like `onCached`.
   */
  onSharedRead?: (read: SharedRead) => void
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
 * The stale window of a path, in seconds since its answer was stored: a week for what the game
 * page is made of — the game, its store links and its screenshots — and none for anything else.
 *
 * Those three are a game's description: they change rarely, none of them carries a price, and a
 * visitor who is shown yesterday's copy at once is better served than one who waits for RAWG. A
 * list is the catalog itself and keeps its ten minutes; the taxonomies already live a week; and a
 * game's other sub-paths (`movies` is the landing's) were never part of the page a visitor waits
 * for. `ttlFor` still says how long each is fresh.
 */
export function staleFor(path: string): number {
  const [root, slug, sub, ...deeper] = path.split('/')
  if (root !== 'games' || !slug || deeper.length > 0) return 0
  const ofThePage = sub === undefined || sub === 'stores' || sub === 'screenshots'
  return ofThePage ? STALE_WHILE_REVALIDATE_SECONDS : 0
}

/**
 * Whether a request carries what a visitor typed: a search term, on a list or on a taxonomy. Its
 * answer is never kept beyond the instance that fetched it (`isShareable`) — the header's
 * suggestions and the developer filter ask for one of these for every few letters typed.
 *
 * `search` is the only parameter this looks at, and not the only place a visitor's text enters a
 * request. The catalog's filters (`developers`, `publishers`, `tags`, `genres`, `dates`) come
 * from the address bar too, and are kept out of the shared cache by their ten-minute lifetime
 * alone: a list asked with one of them AND a lifetime of a day would be shared, and whoever
 * writes that call has to decide it here. The slug in a game's path is a visitor's as well, and
 * is shared on purpose: a game's page is what the shared cache is for.
 */
export function isTyped(params?: RawgParams): boolean {
  return cleanParams(params).some(([name]) => name === 'search')
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
 * the base URL and API key, the per-path ttl and stale-window rules and the 4 rps limiter, with
 * the burst its wiring asks for (`RawgDeps.burst`).
 * Everything else — throttling, timeout, retry, cache, stale-if-error, the refresh behind a stale
 * answer — lives there, once.
 *
 * A body is kept as it was fetched: there is no projection here. Giving this transport one
 * changes what the cache every instance shares stores under the same keys, and so means changing
 * `SHARED_CACHE_SCHEMA` (`server/upstream/layeredCache.ts`) with it.
 */
export function createRawgFetch(deps: RawgDeps): RawgFetch {
  const fetchUpstream = createUpstreamFetch<RawgRequest>(
    {
      source: 'RAWG',
      minIntervalMs: MIN_INTERVAL_MS,
      burst: deps.burst,
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
      staleFor: ({ path }) => staleFor(path),
      typed: ({ params }) => isTyped(params),
      limitsFor: ({ options }) =>
        options && (options.timeoutMs !== undefined || options.maxAttempts !== undefined)
          ? { timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts }
          : undefined,
    },
    deps,
  )

  return (path, params, options) =>
    fetchUpstream({ path, params, options }, options?.onCached, options?.onSharedRead)
}
