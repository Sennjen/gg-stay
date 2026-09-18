import { createHash } from 'node:crypto'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../rawg/rawgFetch'

let instance: RawgFetch | undefined

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useRawg(): RawgFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const cache = useStorage('cache:rawg')
  const fixtures = useStorage('assets:rawg-fixtures')

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
    cache: {
      get: async (key) => (await cache.getItem<CacheEntry>(hashKey(key))) ?? null,
      set: async (key, entry) => cache.setItem(hashKey(key), entry),
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return instance
}
