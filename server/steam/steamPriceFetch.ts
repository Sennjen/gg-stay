import { createUpstreamFetch, type UpstreamCacheEntry } from '../upstream/createUpstreamFetch'
import { UpstreamError } from '../upstream/errors'
import { parseSteamPrice, readSteamPrice, type SteamPrice } from './price'
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
// One fixed asset (steam-fixtures:prices.json — see tests/fixtures/steam/prices.json) rather than
// a name derived from the requested ids: a real fixture-mode caller (the job, or a dev server
// under RAWG_FIXTURES=1) picks its own candidate ids at runtime, so a per-chunk fixture name would
// never resolve to a file anyone actually wrote. Read once and projected per call instead.
const PRICES_FIXTURE_NAME = 'prices'

export interface SteamPriceFetchDeps {
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Where the transport's line about a slow or failed attempt goes; `console.info` when omitted. */
  log?: (line: string) => void
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
   *  does not parse to a price, is `null` in the result — never missing from the map. In fixture
   *  mode, reads the single `steam-fixtures:prices.json` asset once and projects the requested ids
   *  out of it — an id absent from that map is `null`, same as a live "asked but absent" id. */
  fetchPrices: (appIds: string[]) => Promise<Map<string, SteamPrice | null>>
  /**
   * One app's price, read from Steam now and never cached: the game page's live refresh.
   *
   * It has three outcomes where `fetchPrices` has two, because the page remembers the second for
   * an hour and must never remember the third (`readSteamPrice` draws the line):
   *
   * - the price Steam gives;
   * - `null`, when Steam answers for this app and has no price for it — an app it will not
   *   describe to this region, or one whose answer carries no price;
   * - a rejection, when what came back cannot be read as Steam's answer about this app: an empty
   *   or non-object body under a 200 (the transport hands one back uncached; here it becomes the
   *   upstream error it stands for, as `rawgListOrThrow` does for a RAWG list), a body with no
   *   entry for the app, an entry that says nothing readable. That is a failed read, whatever
   *   status carried it.
   *
   * `fetchPrices` keeps reporting all of that as `null`, as it always has: the refresh job does
   * its own accounting of which answers were definitive (`scripts/index/prices.ts`), a hundred
   * apps at a time, and a chunk that told it nothing must not fail the ninety-nine beside it.
   *
   * The same request as `fetchPrices([appId])`, through the same limiter, timeout and retry. In
   * fixture mode it reads the same recorded file, and an app the file does not hold has no price:
   * there the file is the whole of Steam, and there is nobody to ask again.
   */
  fetchPrice: (appId: string) => Promise<SteamPrice | null>
  /** One unfiltered, cached per-app call, projected to Ukrainian localisation, the free flag and
   *  the price (when Steam includes it for a free/regionless app). */
  fetchAppLanguages: (appId: string) => Promise<SteamAppLanguages>
}

// The job wants fresh prices every run, and the game page's live read exists to be fresher than
// the index, so this transport never reads or writes a cache — only the shared transport's
// limiter, timeout and single retry apply.
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The batched Steam price/language transport, built on the shared upstream transport (see
 * server/upstream/createUpstreamFetch.ts) for the network path of `fetchPrices` and `fetchPrice`,
 * and on the existing per-app cached transport for `fetchAppLanguages` — see each function's own
 * doc comment.
 */
export function createSteamPriceFetch(deps: SteamPriceFetchDeps): SteamPriceFetch {
  // Fixture mode never goes through the throttled/retried network transport below — it reads the
  // one `prices.json` asset once (`fixtures: false` here, so `fetchChunk` itself always talks to
  // `deps.fetchJson`) and both price reads short-circuit to it before building any chunk request.
  const fetchChunk = createUpstreamFetch<{ ids: string[] }>(
    {
      source: 'STEAM',
      minIntervalMs: MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      buildUrl: ({ ids }) => buildPricesUrl(ids),
      cacheKey: ({ ids }) => ids.join(','),
      fixtureName: () => PRICES_FIXTURE_NAME,
      ttlFor: () => 0,
    },
    {
      fixtures: false,
      fetchJson: deps.fetchJson,
      readFixture: deps.readFixture,
      cache: NO_CACHE,
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
    },
  )

  // Read once per `createSteamPriceFetch` instance and reused for every price read — the fixture
  // is a fixed file, not something that changes between calls within one process.
  let fixturePrices: Promise<Record<string, unknown>> | undefined
  function loadFixturePrices(): Promise<Record<string, unknown>> {
    fixturePrices ??= deps.readFixture(PRICES_FIXTURE_NAME).then(asRecord)
    return fixturePrices
  }

  async function fetchPrices(appIdsIn: string[]): Promise<Map<string, SteamPrice | null>> {
    const ids = dedupe(appIdsIn)
    const result = new Map<string, SteamPrice | null>()

    if (deps.fixtures) {
      const record = await loadFixturePrices()
      for (const id of ids) result.set(id, id in record ? parseSteamPrice(record[id]) : null)
      return result
    }

    const chunks = chunk(ids, MAX_IDS_PER_REQUEST)
    const responses = await Promise.all(chunks.map((chunkIds) => fetchChunk({ ids: chunkIds })))

    chunks.forEach((chunkIds, index) => {
      const record = asRecord(responses[index])
      for (const id of chunkIds) {
        result.set(id, id in record ? parseSteamPrice(record[id]) : null)
      }
    })
    return result
  }

  /** The entry as `fetchPrice` answers it: a price, `null` for "none", or the failure it stands for. */
  function priceOrThrow(entry: unknown): SteamPrice | null {
    const reading = readSteamPrice(entry)
    if (reading.kind === 'unreadable') throw new UpstreamError('STEAM', 'ERROR')
    return reading.kind === 'price' ? reading.price : null
  }

  async function fetchPrice(appId: string): Promise<SteamPrice | null> {
    if (deps.fixtures) {
      const record = await loadFixturePrices()
      return Object.hasOwn(record, appId) ? priceOrThrow(record[appId]) : null
    }

    const record = asRecord(await fetchChunk({ ids: [appId] }))
    return priceOrThrow(Object.hasOwn(record, appId) ? record[appId] : undefined)
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

  return { fetchPrices, fetchPrice, fetchAppLanguages }
}
