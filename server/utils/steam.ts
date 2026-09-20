import { createSteamFetch, type SteamCacheEntry, type SteamFetch } from '../steam/steamFetch'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'

let instance: SteamFetch | undefined

export function useSteam(): SteamFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:steam-fixtures')
  // No key hash here, unlike RAWG: a Steam cache key is a bare numeric app id, which carries no
  // `:` for unstorage to read as a namespace separator.
  const cache = createBoundedCache<SteamCacheEntry>({
    storage: useStorage('cache:steam'),
    maxEntries: MAX_CACHE_ENTRIES,
    now: () => Date.now(),
  })

  instance = createSteamFetch({
    // One switch drives fixture mode for every upstream, hence `rawgFixtures` here too: a local
    // run either talks to real third-party APIs or to none of them. `.env.example` documents it.
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    cache: { get: cache.get, set: cache.set },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return instance
}
