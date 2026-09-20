import { createHash } from 'node:crypto'
import type { ResolverCache } from '../graphql/context'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'

/**
 * The cache for things a resolver computed rather than fetched: an index-served catalog page
 * (600 s, keyed by the filter, the sort, the page and the index version, so a publication
 * invalidates it on its own) and the one Steam price a game page refreshes live (6 h).
 *
 * It runs on the same bounded LRU as the upstream caches, so a key space driven by user-supplied
 * filters cannot grow without limit. Keys are hashed because they carry JSON, and unstorage reads
 * a `:` in a key as a namespace separator.
 *
 * The two live in separate LRUs. A catalog page's key space is attacker-driven (length-capped,
 * but still one entry per filter combination), while a live price's is one entry per Steam app a
 * visitor opened; sharing a 500-entry budget would let a walk of the first evict all of the
 * second, and a Steam request costs far more than an index read.
 */

interface CachedValue {
  expiresAt: number
  value: unknown
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** The prefix `server/graphql/resolvers/game.ts` gives its live Steam price entries. */
const LIVE_PRICE_PREFIX = 'steam-price:'

/** One entry per Steam app a visitor opened — a far smaller and far less exposed key space. */
const LIVE_PRICE_ENTRIES = 200

let instance: ResolverCache | undefined

export function useResolverCache(): ResolverCache {
  if (instance) return instance
  const now = () => Date.now()

  const bounded = (namespace: string, maxEntries: number) =>
    createBoundedCache<CachedValue>({
      storage: useStorage(`cache:${namespace}`),
      maxEntries,
      now,
      hashKey,
    })

  const pages = bounded('resolvers', MAX_CACHE_ENTRIES)
  const prices = bounded('steam-prices', LIVE_PRICE_ENTRIES)
  const cacheFor = (key: string) => (key.startsWith(LIVE_PRICE_PREFIX) ? prices : pages)

  instance = {
    get: async <T>(key: string) => {
      const entry = await cacheFor(key).get(key)
      // Unlike the upstream caches, an expired entry here is not a stale-if-error fallback: a
      // price nobody may serve and a page nobody may serve are both simply misses.
      if (!entry || entry.expiresAt <= now()) return null
      return entry.value as T
    },
    set: async (key, value, ttlSeconds) => {
      await cacheFor(key).set(key, { expiresAt: now() + ttlSeconds * 1000, value })
    },
  }
  return instance
}
