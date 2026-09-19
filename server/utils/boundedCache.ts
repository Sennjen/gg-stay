/**
 * The upstream response caches run on Nitro's in-memory driver, and their key space is driven by
 * the query string: every distinct filter combination, page and search term mints a permanent
 * entry. Nothing ever removed one — an expired entry is deliberately kept as the stale-if-error
 * fallback — so the map only ever grew, and anyone could walk that space from the outside.
 *
 * This wrapper bounds it: at most `maxEntries` live keys, evicted least-recently-used first, with
 * entries whose ttl has already elapsed offered up before any live entry. Expiry stays lazy (no
 * timers, no sweeps): an expired entry keeps serving stale-if-error until the cache actually needs
 * its slot. Recency is tracked next to the storage rather than inside it, because it is a property
 * of this instance, exactly like the storage it bounds.
 */

/**
 * Entry ceiling per upstream cache. A catalog page is a few KB of mapped JSON, so 500 entries is
 * well under a serverless instance's memory while still covering far more distinct filter
 * combinations than real traffic produces between cold starts.
 */
export const MAX_CACHE_ENTRIES = 500

export interface ExpiringEntry {
  expiresAt: number
}

/**
 * The slice of unstorage's `Storage` this wrapper uses. Declared structurally rather than imported
 * so the module stays dependency-free and testable with a plain Map.
 */
export interface KeyValueStorage {
  getItem: <T>(key: string) => Promise<T | null>
  setItem: (key: string, value: unknown) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

export interface BoundedCache<T extends ExpiringEntry> {
  get: (key: string) => Promise<T | null>
  set: (key: string, entry: T) => Promise<void>
  /** Number of keys currently tracked. Exposed for tests and for a future metric. */
  size: () => number
}

export interface BoundedCacheOptions {
  storage: KeyValueStorage
  maxEntries: number
  now: () => number
  /** Hashes the caller's key into the storage key; identity when omitted. */
  hashKey?: (key: string) => string
}

export function createBoundedCache<T extends ExpiringEntry>(
  options: BoundedCacheOptions,
): BoundedCache<T> {
  const { storage, maxEntries, now } = options
  const hashKey = options.hashKey ?? ((key: string) => key)
  // Insertion order is recency order: a `delete` + `set` moves a key to the end, so the first key
  // the iterator yields is always the least recently used one.
  const recency = new Map<string, number>()

  function touch(key: string, expiresAt: number) {
    recency.delete(key)
    recency.set(key, expiresAt)
  }

  async function evict(): Promise<void> {
    while (recency.size > maxEntries) {
      const moment = now()
      let victim: string | undefined
      for (const [key, expiresAt] of recency) {
        if (expiresAt <= moment) {
          victim = key
          break
        }
      }
      // Nothing has expired: fall back to the least recently used key.
      victim ??= recency.keys().next().value
      if (victim === undefined) return
      recency.delete(victim)
      await storage.removeItem(hashKey(victim))
    }
  }

  return {
    async get(key) {
      const entry = await storage.getItem<T>(hashKey(key))
      if (!entry) {
        // The storage dropped it (or it was never ours): stop tracking a key that costs a slot
        // and can never be served.
        recency.delete(key)
        return null
      }
      touch(key, entry.expiresAt)
      return entry
    },
    async set(key, entry) {
      touch(key, entry.expiresAt)
      await storage.setItem(hashKey(key), entry)
      await evict()
    },
    size: () => recency.size,
  }
}
