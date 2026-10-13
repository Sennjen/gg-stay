import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createBankRateFetch, type BankRateFetch } from './bank'
import type { JobClock } from './deps'
import { createGogCatalogFetch, type GogCatalogFetch } from './gog'
import { createMicrosoftFetches, type MicrosoftFetches } from './microsoft'
import type { StoreUpstreamRuntime } from './storeUpstream'
import type { UpstreamCacheEntry } from '../../server/upstream/createUpstreamFetch'
import { UpstreamError } from '../../server/upstream/errors'
import { createRawgFetch, type RawgFetch } from '../../server/rawg/rawgFetch'
import { createSteamFetch } from '../../server/steam/steamFetch'
import { createSteamPriceFetch, type SteamPriceFetch } from '../../server/steam/steamPriceFetch'

/**
 * The upstream transports, wired for a plain Node process instead of Nitro. The app builds the
 * RAWG and Steam ones in `server/utils/rawg.ts` and `server/utils/steam.ts` from
 * `useRuntimeConfig` and `useStorage`; here the cache is a map that dies with the process and the
 * fixtures are read off disk, but the throttling, timeouts, retries and parsing are the
 * transports' own. The three at the end — GOG, the Microsoft Store and the National Bank — are
 * built nowhere else: only the job talks to them.
 */

const FIXTURE_DIRS = {
  RAWG: new URL('../../tests/fixtures/rawg/', import.meta.url),
  STEAM: new URL('../../tests/fixtures/steam/', import.meta.url),
  GOG: new URL('../../tests/fixtures/gog/', import.meta.url),
  MICROSOFT: new URL('../../tests/fixtures/microsoft/', import.meta.url),
  NBU: new URL('../../tests/fixtures/nbu/', import.meta.url),
} as const

function createMemoryCache() {
  const entries = new Map<string, UpstreamCacheEntry>()
  return {
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, entry: UpstreamCacheEntry) => void entries.set(key, entry),
  }
}

function createFixtureReader(dir: URL) {
  return async (name: string): Promise<unknown | null> => {
    try {
      return JSON.parse(await readFile(fileURLToPath(new URL(`${name}.json`, dir)), 'utf8'))
    } catch {
      return null
    }
  }
}

async function fetchJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal })
  const body: unknown = await response.json().catch(() => null)
  return { status: response.status, body }
}

/**
 * The transports' own line about an attempt that failed or was slow (`createUpstreamFetch`) is
 * not written by the job.
 *
 * A stage already says what an upstream failure cost it, in its own words and through `JobLog`:
 * "prices: a chunk of 100 app ids failed, keeping their current prices", "languages: app 292030
 * failed, leaving its record as it was", "app ids: portal-2 could not be resolved, leaving it for
 * the next run". It counts each one against the failure budget, the run summary totals them, and
 * a failure it cannot work around ends the run with the upstream's own error. The attempt line is
 * evidence for the site's page budget — how long RAWG takes over one visitor's request — and here
 * it would only say the same thing again, once per attempt, straight to stdout and past the job's
 * log. So the job's transports are given a log that keeps nothing.
 */
const noAttemptLines = (): void => {}

export interface UpstreamOptions {
  apiKey: string
  /** Serve the recorded fixtures instead of the network, as `RAWG_FIXTURES=1` does for the app. */
  fixtures: boolean
  clock: JobClock
}

/** A studio with no recorded list, in fixture mode: RAWG's answer for a developer with no games. */
const NO_STUDIO_GAMES = { count: 0, next: null, results: [] }

export function createJobRawg(options: UpstreamOptions): RawgFetch {
  const readFixture = createFixtureReader(FIXTURE_DIRS.RAWG)
  const rawg = createRawgFetch({
    apiKey: options.apiKey,
    fixtures: options.fixtures,
    fetchJson,
    readFixture,
    cache: createMemoryCache(),
    now: options.clock.now,
    sleep: options.clock.sleep,
    log: noAttemptLines,
  })
  if (!options.fixtures) return rawg

  // The app's fixture set names a list after its path alone, so every `games` request would be
  // answered with the popularity list — and every game on it would be "made in Ukraine". The
  // studios stage's requests are answered from a list recorded per developer slug instead
  // (`tests/fixtures/rawg/games-developers-<slug>.json`), and a studio without one has no games.
  return async (path, params, fetchOptions) => {
    const developers = path === 'games' ? params?.developers : undefined
    if (developers === undefined) return rawg(path, params, fetchOptions)
    if (Number(params?.page ?? 1) > 1) return NO_STUDIO_GAMES
    return (await readFixture(`games-developers-${developers}`)) ?? NO_STUDIO_GAMES
  }
}

export function createJobSteam(options: UpstreamOptions): SteamPriceFetch {
  const readFixture = createFixtureReader(FIXTURE_DIRS.STEAM)
  const shared = {
    fixtures: options.fixtures,
    fetchJson,
    readFixture,
    now: options.clock.now,
    sleep: options.clock.sleep,
    log: noAttemptLines,
  }
  return createSteamPriceFetch({
    ...shared,
    steamFetch: createSteamFetch({ ...shared, cache: createMemoryCache() }),
  })
}

/**
 * Who is asking, on every request to GOG, the Microsoft Store and the National Bank: the project
 * by name, what it is doing, and where its source — and so its owner — can be found. None of the
 * three documents these endpoints for anyone else, and a caller they cannot identify is the first
 * one they would be right to turn away.
 */
export const STORE_USER_AGENT = 'gg-stay-index-refresh/1.0 (+https://github.com/Sennjen/gg-stay)'

async function fetchStoreJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    headers: { 'User-Agent': STORE_USER_AGENT, Accept: 'application/json' },
  })
  const body: unknown = await response.json().catch(() => null)
  return { status: response.status, body }
}

/** What the three store transports need of the job: no API key, for none of them takes one. */
export type StoreUpstreamOptions = Omit<UpstreamOptions, 'apiKey'>

function storeRuntime(options: StoreUpstreamOptions, dir: URL): StoreUpstreamRuntime {
  return {
    fixtures: options.fixtures,
    fetchJson: fetchStoreJson,
    readFixture: createFixtureReader(dir),
    now: options.clock.now,
    sleep: options.clock.sleep,
    log: noAttemptLines,
  }
}

export function createJobGog(options: StoreUpstreamOptions): GogCatalogFetch {
  return createGogCatalogFetch(storeRuntime(options, FIXTURE_DIRS.GOG))
}

/** A search with no recording, in fixture mode: the store's answer when it sells nothing by a name. */
const NO_SEARCH_RESULTS = { Results: [], TotalResultCount: 0 }

/**
 * Everything the job asks the Microsoft Store, on one limiter (`createMicrosoftFetches`).
 *
 * In fixture mode a search is answered from the recording named after what was searched for
 * (`tests/fixtures/microsoft/search-prey.json`), and a name with no recording is a name the
 * store sells nothing under — as a studio without a recorded list is a studio with no games. A
 * dry run searches for whichever games its fixtures leave without a price, and a missing file
 * must not read as the store failing.
 */
export function createJobMicrosoft(options: StoreUpstreamOptions): MicrosoftFetches {
  const microsoft = createMicrosoftFetches(storeRuntime(options, FIXTURE_DIRS.MICROSOFT))
  if (!options.fixtures) return microsoft
  return {
    ...microsoft,
    search: async (name) => {
      try {
        return await microsoft.search(name)
      } catch (error) {
        if (error instanceof UpstreamError && error.kind === 'NOT_FOUND') return NO_SEARCH_RESULTS
        throw error
      }
    },
  }
}

/** `2026-10-12` as the bank's answers write a day: `12.10.2026`. */
function asBankDay(date: string): string {
  return date.split('-').reverse().join('.')
}

/**
 * In fixture mode the recorded answer is served as the answer for whatever day was asked for —
 * the rate as it was recorded, under today's date. The bank is taken at its word only when it
 * names the day it was asked about (`parseUsdRate`), and a recording names the day it was made:
 * served as it is, a dry run would read a rate on that one day and never again.
 */
export function createJobBank(options: StoreUpstreamOptions): BankRateFetch {
  const bank = createBankRateFetch(storeRuntime(options, FIXTURE_DIRS.NBU))
  if (!options.fixtures) return bank
  return async (date) => {
    const recorded = await bank(date)
    if (!Array.isArray(recorded)) return recorded
    return recorded.map((entry: unknown) =>
      entry !== null && typeof entry === 'object'
        ? { ...entry, exchangedate: asBankDay(date) }
        : entry,
    )
  }
}

export const systemClock: JobClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
