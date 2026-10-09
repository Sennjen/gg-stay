import { createHash } from 'node:crypto'
import { createSteamFetch, type SteamCacheEntry, type SteamFetch } from '../steam/steamFetch'
import { createLayeredCache } from '../upstream/layeredCache'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'
import { useSharedLevel } from './sharedCache'

let instance: SteamFetch | undefined

// For the shared level's key alone, so that every key there has one shape whatever it was made
// from (`SHARED_CACHE_SCHEMA`).
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useSteam(): SteamFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:steam-fixtures')
  const now = () => Date.now()
  // No key hash here, unlike RAWG: a Steam cache key is a bare numeric app id, which carries no
  // `:` for unstorage to read as a namespace separator.
  const memory = createBoundedCache<SteamCacheEntry>({
    storage: useStorage('cache:steam'),
    maxEntries: MAX_CACHE_ENTRIES,
    now,
  })
  // As in `useRawg`: the shared level on Vercel outside fixture mode, and `memory` itself anywhere
  // else. Unlike RAWG's, this transport is given no keep-alive: nothing of Steam's is served past
  // its day (`createSteamFetch` says why), so there is never a refresh to keep running.
  const shared = useSharedLevel()

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
    cache: createLayeredCache({ memory, shared, source: 'STEAM', hashKey, now }),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return instance
}
