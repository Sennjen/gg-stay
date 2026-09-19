import { createSteamFetch, type SteamCacheEntry, type SteamFetch } from '../steam/steamFetch'

let instance: SteamFetch | undefined

export function useSteam(): SteamFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const cache = useStorage('cache:steam')
  const fixtures = useStorage('assets:steam-fixtures')

  instance = createSteamFetch({
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    cache: {
      get: async (key) => (await cache.getItem<SteamCacheEntry>(key)) ?? null,
      set: async (key, entry) => cache.setItem(key, entry),
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return instance
}
