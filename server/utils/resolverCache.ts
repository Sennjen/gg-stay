import { createHash } from 'node:crypto'
import type { ResolverCache } from '../graphql/context'
import type { SharedRead } from '../upstream/createUpstreamFetch'
import { createLayeredCache, type LayeredCache } from '../upstream/layeredCache'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'
import { useSharedLevel } from './sharedCache'

/**
 * The cache for things a resolver computed rather than fetched: an index-served catalog page
 * (600 s, keyed by the filter, the sort, the page and the index version, so a publication
 * invalidates it on its own) and the one Steam price a game page refreshes live (6 h) — or the
 * fact that Steam has none for that app (1 h).
 *
 * It runs on the same bounded LRU as the upstream caches, so a key space driven by user-supplied
 * filters cannot grow without limit. Keys are hashed because they carry JSON, and unstorage reads
 * a `:` in a key as a namespace separator.
 *
 * The two live in separate LRUs. A catalog page's key space is attacker-driven (length-capped,
 * but still one entry per filter combination), while a live price's is one entry per Steam app a
 * visitor opened; sharing a 500-entry budget would let a walk of the first evict all of the
 * second, and a Steam request costs far more than an index read.
 *
 * They also differ in where they are kept. A live price is what Steam answered, and goes through
 * the same two levels as the upstream caches (`server/upstream/layeredCache.ts`): one instance's
 * read spares every other instance the request, for the six hours — or the one — it is good for.
 * A catalog page stays in this instance's memory: it is made from the index, which is a few
 * milliseconds away.
 */

interface CachedValue {
  expiresAt: number
  /** When it was written: how the shared level tells the newer of two prices. */
  storedAt: number
  value: unknown
}

type Level = Pick<LayeredCache<CachedValue>, 'get' | 'set'>

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** The prefix `server/graphql/resolvers/game.ts` gives its live Steam price entries. */
const LIVE_PRICE_PREFIX = 'steam-price:'

/** One entry per Steam app a visitor opened — a far smaller and far less exposed key space. */
const LIVE_PRICE_ENTRIES = 200

/**
 * The resolver cache over its two stores, wherever each of them is kept.
 *
 * Neither is ever served past its lifetime: unlike the upstream caches, an expired entry here is
 * not a stale-if-error fallback and has no stale window — a price nobody may serve and a page
 * nobody may serve are both simply misses, whichever level they came from.
 */
export function createResolverCache(stores: {
  pages: Level
  prices: Level
  now: () => number
}): ResolverCache {
  const { pages, prices, now } = stores
  const levelFor = (key: string) => (key.startsWith(LIVE_PRICE_PREFIX) ? prices : pages)

  return {
    get: async <T>(key: string, onSharedRead?: (read: SharedRead) => void) => {
      const told: { read?: SharedRead } = {}
      const entry = await levelFor(key).get(key, (read) => {
        told.read = read
      })
      const live = entry !== null && entry.expiresAt > now()
      // A read of the shared level is passed on as the read it was; it found something only when
      // what it found may still be served.
      if (told.read) onSharedRead?.({ ms: told.read.ms, hit: told.read.hit && live })
      return live ? (entry.value as T) : null
    },
    set: async (key, value, ttlSeconds) => {
      const storedAt = now()
      await levelFor(key).set(key, { expiresAt: storedAt + ttlSeconds * 1000, storedAt, value })
    },
  }
}

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

  instance = createResolverCache({
    pages: bounded('resolvers', MAX_CACHE_ENTRIES),
    prices: createLayeredCache({
      memory: bounded('steam-prices', LIVE_PRICE_ENTRIES),
      shared: useSharedLevel(),
      source: 'STEAM_PRICE',
      hashKey,
      now,
    }),
    now,
  })
  return instance
}
