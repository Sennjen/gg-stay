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

export interface UpstreamOptions {
  apiKey: string
  /** Serve the recorded fixtures instead of the network, as `RAWG_FIXTURES=1` does for the app. */
  fixtures: boolean
  clock: JobClock
}

export function createJobRawg(options: UpstreamOptions): RawgFetch {
  return createRawgFetch({
    apiKey: options.apiKey,
    fixtures: options.fixtures,
    fetchJson,
    readFixture: createFixtureReader(FIXTURE_DIRS.RAWG),
    cache: createMemoryCache(),
    now: options.clock.now,
    sleep: options.clock.sleep,
  })
}

export function createJobSteam(options: UpstreamOptions): SteamPriceFetch {
  const readFixture = createFixtureReader(FIXTURE_DIRS.STEAM)
  const shared = {
    fixtures: options.fixtures,
    fetchJson,
    readFixture,
    now: options.clock.now,
    sleep: options.clock.sleep,
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
