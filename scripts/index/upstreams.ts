import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { JobClock } from './deps'
import type { UpstreamCacheEntry } from '../../server/upstream/createUpstreamFetch'
import { createRawgFetch, type RawgFetch } from '../../server/rawg/rawgFetch'
import { createSteamFetch } from '../../server/steam/steamFetch'
import { createSteamPriceFetch, type SteamPriceFetch } from '../../server/steam/steamPriceFetch'

/**
 * The two upstream transports, wired for a plain Node process instead of Nitro. The app builds
 * the same objects in `server/utils/rawg.ts` and `server/utils/steam.ts` from `useRuntimeConfig`
 * and `useStorage`; here the cache is a map that dies with the process and the fixtures are read
 * off disk, but the throttling, timeouts, retries and parsing are the transports' own.
 */

const FIXTURE_DIRS = {
  RAWG: new URL('../../tests/fixtures/rawg/', import.meta.url),
  STEAM: new URL('../../tests/fixtures/steam/', import.meta.url),
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

export const systemClock: JobClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
