import { createHash } from 'node:crypto'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../rawg/rawgFetch'
import { createLayeredCache } from '../upstream/layeredCache'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'
import { keepRunning } from './keepRunning'
import { useSharedLevel } from './sharedCache'

let instance: RawgFetch | undefined

// unstorage treats `:` in a key as a namespace separator, and a normalised cache key carries the
// query string verbatim. Hashing sidesteps that entirely and gives every key the same shape — and
// is what keeps a visitor's search out of the key the shared level stores an answer under.
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useRawg(): RawgFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:rawg-fixtures')
  const now = () => Date.now()
  const memory = createBoundedCache<CacheEntry>({
    storage: useStorage('cache:rawg'),
    maxEntries: MAX_CACHE_ENTRIES,
    now,
    hashKey,
  })
  // On Vercel, outside fixture mode: the cache every instance shares, behind this instance's
  // memory. Anywhere else there is none, and the cache below is `memory` itself.
  const shared = useSharedLevel()

  instance = createRawgFetch({
    apiKey: String(config.rawgApiKey ?? ''),
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    cache: createLayeredCache({ memory, shared, source: 'RAWG', hashKey, now }),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // The stale window comes with the shared level and with nothing else: a week-old answer is
    // worth serving where it can be refreshed behind the response and kept for every instance,
    // and off Vercel the transport answers exactly as it did before there was a window.
    keepAlive: shared ? keepRunning : undefined,
  })
  return instance
}
