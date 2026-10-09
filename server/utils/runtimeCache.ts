import { getCache } from '@vercel/functions'
import { SharedStoreAbsent, type SharedStore } from '../upstream/layeredCache'

/**
 * Vercel's Runtime Cache as the shared level of the upstream caches (`layeredCache.ts`): regional,
 * shared by every instance of the function, kept across deployments, separate for production and
 * preview. This is the only file that knows it.
 *
 * What `@vercel/functions` 3.9 does, read from its source rather than assumed, and what each of
 * those facts costs here:
 *
 * - **`getCache()` is a thin wrapper, and looks the real cache up on every call** — in the
 *   request's context, which the platform keeps under a global symbol
 *   (`Symbol.for('@vercel/request-context')`), exactly as `waitUntil` finds its own. So one wrapper
 *   is held for the life of the process, and each read and write still reaches the cache of the
 *   request that made it.
 * - **Without that context it does not fail and it does not miss: it quietly becomes a map in this
 *   process**, after one `console.warn`. That map has no bound — it keeps every value as a JSON
 *   string until a read finds it expired — and the key space here is driven by what visitors ask
 *   for, which is the very thing the bounded memory level exists to contain. So the store below
 *   refuses to work unless the platform's cache is there: no cache is an absent store
 *   (`SharedStoreAbsent`), which the level above reports once and never asks again. (On a build
 *   machine the same branch can reach a remote build cache over HTTP instead; it is refused the
 *   same way.)
 * - **A miss is `null`.** The package's own two implementations never reject a read; the
 *   platform's is not in the package, so nothing is assumed of it. The wrapper is an ordinary
 *   function, so a cache that throws would throw at the caller rather than reject — the methods
 *   below are `async`, which makes any of that a rejection, and the level above gives the read a
 *   deadline whatever it does.
 * - **The default key hash is 32 bits** (djb2, as eight hex digits). On a plan where every project
 *   of a team shares one cache, two keys with one hash is a matter of time, and what a collision
 *   serves is another game's page. The keys that arrive here already carry a SHA-256
 *   (`SHARED_CACHE_SCHEMA`), so the hash is switched off and the key is stored as given, under the
 *   namespace.
 * - **The key as given is also the entry's label in the platform's observability**, unless a name
 *   is passed. One more reason it is hashed before it gets here: a RAWG key carries the search a
 *   visitor typed.
 * - **Values are JSON**, on the way in and on the way out, and **`ttl` is in seconds**; an entry
 *   written without one is kept until it is evicted, so one is always passed.
 */

/** What every key of this project starts with: on the Hobby plan the cache is the whole team's. */
export const SHARED_CACHE_NAMESPACE = 'gg-stay'

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')

/** Whether the platform has given the request that is running a cache — the package's own test. */
function platformCacheIsThere(): boolean {
  const holder = (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] as
    { get?: () => { cache?: unknown } | undefined } | undefined
  return Boolean(holder?.get?.()?.cache)
}

/**
 * Refuses to go on without the platform's cache — as an absence, not as a failure: if a function
 * built this way is given none, no later request will be given one either, so the level above
 * says it once and stops asking instead of finding it out again every thirty seconds.
 */
function requirePlatformCache(): void {
  if (!platformCacheIsThere()) {
    throw new SharedStoreAbsent('the platform gave this function no cache')
  }
}

export function createRuntimeCacheStore(): SharedStore {
  const cache = getCache({ namespace: SHARED_CACHE_NAMESPACE, keyHashFunction: (key) => key })
  return {
    async get(key) {
      requirePlatformCache()
      return cache.get(key)
    },
    async set(key, value, ttlSeconds) {
      requirePlatformCache()
      await cache.set(key, value, { ttl: ttlSeconds })
    },
  }
}
