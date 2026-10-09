import {
  createUpstreamFetch,
  type SharedRead,
  type UpstreamCache,
  type UpstreamCacheEntry,
} from '../upstream/createUpstreamFetch'
import { projectAppDetails } from './appDetailsProjection'

const BASE_URL = 'https://store.steampowered.com/api/appdetails'
const TIMEOUT_MS = 5_000
// Steam's undocumented limit is roughly 200 requests per 5 minutes; one request every 1.5s
// stays comfortably under that without needing a token-bucket over a longer window.
const MIN_INTERVAL_MS = 1_500
const MAX_ATTEMPTS = 2
const DEFAULT_TTL = 86_400 // 24h, per the landing resolver's caching rule for Steam trailers.

export type SteamCacheEntry = UpstreamCacheEntry

export interface SteamDeps {
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  cache: UpstreamCache
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Where the transport's line about a slow or failed attempt goes; `console.info` when omitted. */
  log?: (line: string) => void
}

export interface SteamFetchOptions {
  ttl?: number
  /** Called when this call was answered from the cache and Steam was not asked — see `UpstreamFetch`. */
  onCached?: () => void
  /**
   * Called when this call's read of the cache went beyond the instance's memory, to the cache
   * every instance shares — see `UpstreamFetch`.
   */
  onSharedRead?: (read: SharedRead) => void
}

export type SteamFetch = (appId: string, options?: SteamFetchOptions) => Promise<unknown>

interface SteamRequest {
  appId: string
  options?: SteamFetchOptions
}

export function fixtureName(appId: string): string {
  return `appdetails-${appId}`
}

function buildUrl(appId: string): string {
  const url = new URL(BASE_URL)
  url.searchParams.set('appids', appId)
  url.searchParams.set('cc', 'ua')
  url.searchParams.set('l', 'ukrainian')
  // No `filters` param: both the landing resolver's trailer lookup (`data.movies`) and the game
  // page's localized description (`data.short_description` / `data.about_the_game`) share this
  // one cached response per app id, so the response must carry every field either needs.
  return url.toString()
}

/**
 * Steam's share of the shared upstream transport (see server/upstream/createUpstreamFetch.ts):
 * the store URL, the flat 24h ttl, the slower 1.5s limiter, and the projection that keeps only the
 * handful of fields this app reads — the full payload runs to tens of KB per game, and caching it
 * whole would waste most of the cache's entry budget.
 *
 * No answer here has a stale window (`UpstreamConfig.staleFor`), though RAWG's pages about the
 * same game do. The payload that carries the Ukrainian description also carries the trailer's
 * address, which Steam signs for a time it does not document: a copy served a week after it was
 * stored might hold a trailer that no longer plays. So past its day an app's page is asked for
 * again and waited for, as it always was, and the stored copy is only the fallback for a refresh
 * that fails.
 */
export function createSteamFetch(deps: SteamDeps): SteamFetch {
  const fetchUpstream = createUpstreamFetch<SteamRequest>(
    {
      source: 'STEAM',
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      buildUrl: ({ appId }) => buildUrl(appId),
      // A bare numeric app id: no query string, so nothing here needs normalising.
      cacheKey: ({ appId }) => appId,
      fixtureName: ({ appId }) => fixtureName(appId),
      ttlFor: ({ options }) => options?.ttl ?? DEFAULT_TTL,
      project: projectAppDetails,
    },
    deps,
  )

  return (appId, options) =>
    fetchUpstream({ appId, options }, options?.onCached, options?.onSharedRead)
}
