import { createUpstreamFetch, type UpstreamCacheEntry } from '../upstream/createUpstreamFetch'
import { parseSteamPrice, type SteamPrice } from './price'
import { parseUkrainianSupport, type UkrainianSupport } from './languages'
import type { SteamAppDetailsResponse } from './types'
import type { SteamFetch } from './steamFetch'

const BASE_URL = 'https://store.steampowered.com/api/appdetails'
const TIMEOUT_MS = 5_000
// Same conservative spacing as the per-app transport (see steamFetch.ts) — a batched call still
// counts as one request against Steam's undocumented rate limit.
const MIN_INTERVAL_MS = 1_500
const MAX_ATTEMPTS = 2
// Steam's documented ceiling for `appids` on a single `appdetails` call.
const MAX_IDS_PER_REQUEST = 100

export interface SteamPriceFetchDeps {
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** The existing per-app, cached transport (server/steam/steamFetch.ts) — `fetchAppLanguages`
   *  reuses it instead of duplicating the transport for a single-app, unfiltered call. */
  steamFetch: SteamFetch
}

export interface SteamAppLanguages {
  ukrainian: UkrainianSupport
  isFree: boolean
  price: SteamPrice | null
}

export interface SteamPriceFetch {
  /** Batched prices for every id in `appIds`, chunked to Steam's per-request limit, de-duplicated,
   *  never cached (the job always wants a fresh read). An id Steam did not return, or whose entry
   *  does not parse to a price, is `null` in the result — never missing from the map. */
  fetchPrices: (appIds: string[]) => Promise<Map<string, SteamPrice | null>>
  /** One unfiltered, cached per-app call, projected to Ukrainian localisation, the free flag and
   *  the price (when Steam includes it for a free/regionless app). */
  fetchAppLanguages: (appId: string) => Promise<SteamAppLanguages>
}

// The job wants fresh prices every run, so the batched transport never reads or writes a cache —
// only the shared transport's limiter, timeout and single retry apply.
const NO_CACHE: { get: () => Promise<UpstreamCacheEntry | null>; set: () => Promise<void> } = {
  get: async () => null,
  set: async () => {},
}

function buildPricesUrl(ids: readonly string[]): string {
  const url = new URL(BASE_URL)
  url.searchParams.set('appids', ids.join(','))
  url.searchParams.set('cc', 'ua')
  url.searchParams.set('filters', 'price_overview')
  return url.toString()
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

/**
 * The batched Steam price/language transport, built on the shared upstream transport (see
 * server/upstream/createUpstreamFetch.ts) for `fetchPrices`, and on the existing per-app cached
 * transport for `fetchAppLanguages` — see each function's own doc comment.
 */
export function createSteamPriceFetch(deps: SteamPriceFetchDeps): SteamPriceFetch {
  const fetchChunk = createUpstreamFetch<{ ids: string[] }>(
    {
      source: 'STEAM',
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      buildUrl: ({ ids }) => buildPricesUrl(ids),
      cacheKey: ({ ids }) => ids.join(','),
      fixtureName: ({ ids }) => `prices-${ids.join('-')}`,
      ttlFor: () => 0,
    },
    {
      fixtures: deps.fixtures,
      fetchJson: deps.fetchJson,
      readFixture: deps.readFixture,
      cache: NO_CACHE,
      now: deps.now,
      sleep: deps.sleep,
    },
  )

  async function fetchPrices(appIdsIn: string[]): Promise<Map<string, SteamPrice | null>> {
    const ids = dedupe(appIdsIn)
    const chunks = chunk(ids, MAX_IDS_PER_REQUEST)

    const responses = await Promise.all(chunks.map((ids) => fetchChunk({ ids })))

    const result = new Map<string, SteamPrice | null>()
    chunks.forEach((chunkIds, index) => {
      const body = responses[index]
      const record =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {}
      for (const id of chunkIds) {
        result.set(id, id in record ? parseSteamPrice(record[id]) : null)
      }
    })
    return result
  }

  async function fetchAppLanguages(appId: string): Promise<SteamAppLanguages> {
    const response = (await deps.steamFetch(appId)) as SteamAppDetailsResponse
    const entry = response[appId]
    const data = entry?.data
    const isFree = data?.is_free === true
    const ukrainian = parseUkrainianSupport(data?.supported_languages, isFree)
    const price = parseSteamPrice(entry)
    return { ukrainian, isFree, price }
  }

  return { fetchPrices, fetchAppLanguages }
}
