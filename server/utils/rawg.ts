import { createHash } from 'node:crypto'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../rawg/rawgFetch'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'

let instance: RawgFetch | undefined

// unstorage treats `:` in a key as a namespace separator, and a normalised cache key carries the
// query string verbatim. Hashing sidesteps that entirely and gives every key the same shape.
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useRawg(): RawgFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:rawg-fixtures')
  const cache = createBoundedCache<CacheEntry>({
    storage: useStorage('cache:rawg'),
    maxEntries: MAX_CACHE_ENTRIES,
    now: () => Date.now(),
    hashKey,
  })

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
    cache: { get: cache.get, set: cache.set },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return instance
}
