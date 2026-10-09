import { createHash } from 'node:crypto'
import { getCache } from '@vercel/functions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeCacheStore, SHARED_CACHE_NAMESPACE } from '../../server/utils/runtimeCache'

/**
 * The Runtime Cache store, over `@vercel/functions` as it is installed. The package finds the
 * platform's cache in the request's context, which the Vercel runtime keeps under a global symbol;
 * a stand-in under the same symbol is how a test sees what a deployed function would send to the
 * platform, without a deployment and without a cache (`keepRunning.test.ts` does the same for
 * `waitUntil`).
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')

type WithRequestContext = typeof globalThis & {
  [REQUEST_CONTEXT]?: { get: () => { cache?: unknown } }
}

/** The platform's cache of one request, as the package calls it. */
function platformCache() {
  const held = new Map<string, unknown>()
  return {
    held,
    get: vi.fn(async (key: string): Promise<unknown> => held.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: unknown, _options?: unknown) => void held.set(key, value),
    ),
    delete: vi.fn(async () => {}),
    expireTag: vi.fn(async () => {}),
  }
}

function onVercelWith(cache: unknown): void {
  ;(globalThis as WithRequestContext)[REQUEST_CONTEXT] = { get: () => ({ cache }) }
}

const KEY = `v2.RAWG.${createHash('sha256').update('games/portal-2').digest('hex')}`

afterEach(() => {
  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT)
  vi.restoreAllMocks()
})

describe('the Runtime Cache store', () => {
  it('names every key of this project, and stores it as given rather than under the package’s 32-bit hash', async () => {
    expect(SHARED_CACHE_NAMESPACE).toBe('gg-stay')
    const cache = platformCache()
    onVercelWith(cache)
    const store = createRuntimeCacheStore()

    await store.set(KEY, { value: { id: 4200 } }, 691_200)
    await store.get(KEY)

    expect(cache.set.mock.calls[0]![0]).toBe(`gg-stay$${KEY}`)
    expect(cache.get).toHaveBeenCalledExactlyOnceWith(`gg-stay$${KEY}`)
  })

  it('writes the value with its lifetime in seconds', async () => {
    const cache = platformCache()
    onVercelWith(cache)
    const entry = { value: { id: 4200 }, expiresAt: 2, storedAt: 1 }

    await createRuntimeCacheStore().set(KEY, entry, 87_000)

    expect(cache.set).toHaveBeenCalledTimes(1)
    const [, value, options] = cache.set.mock.calls[0]!
    expect(value).toBe(entry)
    expect(options).toMatchObject({ ttl: 87_000 })
    // The label the platform's observability shows is the key as given: a hash, and no more.
    expect(options).toMatchObject({ name: KEY })
  })

  it('reads back what the platform holds, and nothing for a key it does not', async () => {
    const cache = platformCache()
    onVercelWith(cache)
    const store = createRuntimeCacheStore()
    cache.held.set(`gg-stay$${KEY}`, { value: { id: 4200 }, expiresAt: 2, storedAt: 1 })

    expect(await store.get(KEY)).toEqual({ value: { id: 4200 }, expiresAt: 2, storedAt: 1 })
    expect(await store.get('v2.RAWG.unknown')).toBeNull()
  })

  it('uses the cache of the request that is running, each time it is asked', async () => {
    const store = createRuntimeCacheStore()
    const first = platformCache()
    const second = platformCache()

    onVercelWith(first)
    await store.get(KEY)
    onVercelWith(second)
    await store.get(KEY)

    expect(first.get).toHaveBeenCalledTimes(1)
    expect(second.get).toHaveBeenCalledTimes(1)
  })

  it('fails where the platform gave the request no cache, rather than keep a map of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createRuntimeCacheStore()

    await expect(store.set(KEY, { value: 1 }, 600)).rejects.toThrow('no cache')
    await expect(store.get(KEY)).rejects.toThrow('no cache')
    // Not as a failure that a pause might see the end of: as a store that is not there.
    await expect(store.get(KEY)).rejects.toMatchObject({ name: 'SharedStoreAbsent' })
    await expect(store.set(KEY, { value: 1 }, 600)).rejects.toMatchObject({
      name: 'SharedStoreAbsent',
    })
    // A context that is there but holds no cache is no better.
    ;(globalThis as WithRequestContext)[REQUEST_CONTEXT] = { get: () => ({}) }
    await expect(store.set(KEY, { value: 1 }, 600)).rejects.toThrow('no cache')
    await expect(store.get(KEY)).rejects.toThrow('no cache')
    expect(warn).not.toHaveBeenCalled()

    // What the package would have done by itself: warn once, and keep the value in this process
    // for good. Its own map, read the way the store would read it, holds nothing of the two writes.
    const packageOwn = getCache({
      namespace: SHARED_CACHE_NAMESPACE,
      keyHashFunction: (key) => key,
    })
    expect(await packageOwn.get(KEY)).toBeNull()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Runtime Cache unavailable in this environment. Falling back to in-memory cache.',
    )
    await packageOwn.set(KEY, { value: 1 }, { ttl: 600 })
    expect(await packageOwn.get(KEY)).toEqual({ value: 1 })
    await packageOwn.delete(KEY)
  })

  it('turns a platform cache that throws into a rejection, for a read and for a write', async () => {
    onVercelWith({
      get: () => {
        throw new Error('the platform threw')
      },
      set: () => {
        throw new Error('the platform threw')
      },
    })
    const store = createRuntimeCacheStore()

    // Called without `await` on purpose: neither may throw at the caller.
    const read = store.get(KEY)
    const write = store.set(KEY, { value: 1 }, 600)
    await expect(read).rejects.toThrow('the platform threw')
    await expect(write).rejects.toThrow('the platform threw')
  })
})
