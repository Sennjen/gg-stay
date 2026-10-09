import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedRead } from '../../server/upstream/createUpstreamFetch'
import { createLayeredCache, createSharedLevel } from '../../server/upstream/layeredCache'
import { createBoundedCache } from '../../server/utils/boundedCache'
import { createResolverCache } from '../../server/utils/resolverCache'
import { createFakeSharedStore, type FakeSharedStore } from './support/sharedStore'

/**
 * The resolvers' cache over its two stores: catalog pages the index answered, in this instance's
 * memory alone, and the live Steam price of a game page, in memory and in the store every
 * instance shares. Neither is ever served past its lifetime.
 */

const START = 1_700_000_000_000
const HOUR = 3_600
const DAY = 86_400
const PRICE_KEY = 'steam-price:620'
const PAGE_KEY = 'index-page:{"genres":["rpg"]}:v87'

const sha256 = (key: string) => createHash('sha256').update(key).digest('hex')
const sharedKeyOf = (key: string) => `v2.STEAM_PRICE.${sha256(key)}`

interface Cached {
  expiresAt: number
  storedAt: number
  value: unknown
}

/** The in-memory driver Nitro uses by default, reduced to the three methods the cache calls. */
function memoryStorage() {
  const items = new Map<string, unknown>()
  return {
    items,
    getItem: async <T>(key: string) => (items.get(key) as T) ?? null,
    setItem: async (key: string, value: unknown) => void items.set(key, value),
    removeItem: async (key: string) => void items.delete(key),
  }
}

/** One instance of the function, built the way the site builds its own (`useResolverCache`). */
function instance(store: FakeSharedStore | null) {
  const now = () => Date.now()
  const bounded = () =>
    createBoundedCache<Cached>({ storage: memoryStorage(), maxEntries: 10, now, hashKey: sha256 })
  const shared = store ? createSharedLevel(store, { now, keepAlive: () => {} }) : undefined
  return createResolverCache({
    pages: bounded(),
    prices: createLayeredCache({
      memory: bounded(),
      shared,
      source: 'STEAM_PRICE',
      hashKey: sha256,
      now,
    }),
    now,
  })
}

const PRICE = { price: { priceUah: 249, regularPriceUah: 499, discountPercent: 50, isFree: false } }

/** Lets the write nobody waited for land. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a live price', () => {
  it('is written to both levels, and kept by the shared one for its own lifetime and a day', async () => {
    const store = createFakeSharedStore()
    const cache = instance(store)

    await cache.set(PRICE_KEY, PRICE, 6 * HOUR)
    await cache.set('steam-price:999', { price: null }, HOUR)
    await settle()

    expect(store.writes).toEqual([
      {
        key: sharedKeyOf(PRICE_KEY),
        value: { expiresAt: START + 6 * HOUR * 1000, storedAt: START, value: PRICE },
        ttlSeconds: 6 * HOUR + DAY,
      },
      {
        key: sharedKeyOf('steam-price:999'),
        value: { expiresAt: START + HOUR * 1000, storedAt: START, value: { price: null } },
        ttlSeconds: HOUR + DAY,
      },
    ])
    // Memory answers the instance that wrote it: the shared store is not read.
    expect(await cache.get(PRICE_KEY)).toEqual(PRICE)
    expect(store.reads).toEqual([])
  })

  it('is found by another instance in the shared store, and from then on in its own memory', async () => {
    const store = createFakeSharedStore()
    await instance(store).set(PRICE_KEY, PRICE, 6 * HOUR)
    await settle()

    const other = createFakeSharedStore(store.entries)
    const cache = instance(other)
    expect(await cache.get(PRICE_KEY)).toEqual(PRICE)
    expect(await cache.get(PRICE_KEY)).toEqual(PRICE)
    expect(other.reads).toEqual([sharedKeyOf(PRICE_KEY)])
  })

  it('is a miss the moment it expires, though both levels still hold it', async () => {
    const store = createFakeSharedStore()
    const cache = instance(store)
    await cache.set(PRICE_KEY, PRICE, 6 * HOUR)
    await settle()

    await vi.advanceTimersByTimeAsync(6 * HOUR * 1000 - 1)
    expect(await cache.get(PRICE_KEY)).toEqual(PRICE)
    await vi.advanceTimersByTimeAsync(1)
    // The shared store keeps it a day longer, and hands it back; nobody is served it.
    expect(store.entries.has(sharedKeyOf(PRICE_KEY))).toBe(true)
    expect(await cache.get(PRICE_KEY)).toBeNull()
    expect(store.reads).toEqual([sharedKeyOf(PRICE_KEY)])

    // Nor is a new instance, which finds it in the shared store alone.
    expect(await instance(createFakeSharedStore(store.entries)).get(PRICE_KEY)).toBeNull()
  })

  it('is replaced for every instance by a newer read of the same app', async () => {
    const store = createFakeSharedStore()
    const first = instance(store)
    const second = instance(createFakeSharedStore(store.entries))
    await first.set(PRICE_KEY, PRICE, HOUR)
    await settle()
    await vi.advanceTimersByTimeAsync(HOUR * 1000)

    // The second instance reads Steam again once the hour is up, and writes what it found.
    const newer = { price: { ...PRICE.price, priceUah: 199 } }
    await second.set(PRICE_KEY, newer, 6 * HOUR)
    await settle()

    // The first still holds the old one in memory, expired; the newer of the two wins.
    expect(await first.get(PRICE_KEY)).toEqual(newer)
  })

  it('says when it was read from the shared store, and whether what was found may be served', async () => {
    const store = createFakeSharedStore()
    await instance(store).set(PRICE_KEY, PRICE, HOUR)
    await settle()
    const told = vi.fn<(read: SharedRead) => void>()

    const cache = instance(createFakeSharedStore(store.entries))
    await cache.get(PRICE_KEY, told)
    // Out of memory now: no read of the shared store, and nothing to say.
    await cache.get(PRICE_KEY, told)
    expect(told.mock.calls).toEqual([[{ ms: 0, hit: true }]])

    // An expired price that the shared store still hands back was read, and answered nothing.
    await vi.advanceTimersByTimeAsync(HOUR * 1000)
    await instance(createFakeSharedStore(store.entries)).get(PRICE_KEY, told)
    await cache.get('steam-price:unknown', told)
    expect(told.mock.calls.slice(1)).toEqual([[{ ms: 0, hit: false }], [{ ms: 0, hit: false }]])
  })

  it('stays in memory alone where there is no shared level, exactly as it was', async () => {
    const cache = instance(null)
    const told = vi.fn()

    await cache.set(PRICE_KEY, PRICE, HOUR)
    expect(await cache.get(PRICE_KEY, told)).toEqual(PRICE)
    await vi.advanceTimersByTimeAsync(HOUR * 1000)
    expect(await cache.get(PRICE_KEY, told)).toBeNull()
    expect(told).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a catalog page the index answered', () => {
  it('is kept in this instance’s memory and never reaches the shared store', async () => {
    const store = createFakeSharedStore()
    const cache = instance(store)
    const told = vi.fn()

    await cache.set(PAGE_KEY, { games: [1, 2, 3] }, 600)
    await settle()
    expect(await cache.get(PAGE_KEY, told)).toEqual({ games: [1, 2, 3] })
    // A miss is a miss in memory: the index is a few milliseconds away, and is asked instead.
    expect(await cache.get('index-page:other', told)).toBeNull()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(await cache.get(PAGE_KEY, told)).toBeNull()

    expect(store.reads).toEqual([])
    expect(store.writes).toEqual([])
    expect(told).not.toHaveBeenCalled()
  })
})
