import { describe, expect, it } from 'vitest'
import { createBoundedCache, type ExpiringEntry } from '../../server/utils/boundedCache'

/** The in-memory driver Nitro uses by default, reduced to the three methods the cache calls. */
function createStorage() {
  const items = new Map<string, unknown>()
  return {
    items,
    getItem: async <T>(key: string) => (items.get(key) as T) ?? null,
    setItem: async (key: string, value: unknown) => {
      items.set(key, value)
    },
    removeItem: async (key: string) => {
      items.delete(key)
    },
    getKeys: async () => [...items.keys()],
  }
}

interface Entry extends ExpiringEntry {
  value: string
}

function setup(maxEntries: number, start = 1_000) {
  const storage = createStorage()
  let clock = start
  const cache = createBoundedCache<Entry>({
    storage,
    maxEntries,
    now: () => clock,
  })
  return {
    cache,
    storage,
    advance: (ms: number) => {
      clock += ms
    },
    /** Every key still present in the underlying storage. */
    keys: () => storage.getKeys(),
  }
}

const live = (value: string, expiresAt = 9_999_999): Entry => ({ value, expiresAt })

describe('createBoundedCache', () => {
  it('stores and reads entries back', async () => {
    const { cache } = setup(10)
    await cache.set('a', live('A'))
    expect(await cache.get('a')).toEqual(live('A'))
    expect(await cache.get('missing')).toBeNull()
  })

  it('never grows past the maximum entry count', async () => {
    const { cache, keys } = setup(3)
    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, live(String(i)))
    expect(cache.size()).toBe(3)
    expect(await keys()).toHaveLength(3)
  })

  it('evicts the least recently used entry first', async () => {
    const { cache, keys } = setup(3)
    await cache.set('a', live('A'))
    await cache.set('b', live('B'))
    await cache.set('c', live('C'))
    await cache.set('d', live('D'))

    expect((await keys()).sort()).toEqual(['b', 'c', 'd'])
    expect(await cache.get('a')).toBeNull()
  })

  it('keeps a hot key alive: reading it makes it the most recent', async () => {
    const { cache, keys } = setup(3)
    await cache.set('hot', live('HOT'))
    await cache.set('b', live('B'))
    await cache.set('c', live('C'))

    // Re-reading 'hot' moves it to the end of the recency order, so 'b' becomes the victim.
    expect(await cache.get('hot')).toEqual(live('HOT'))
    await cache.set('d', live('D'))

    expect((await keys()).sort()).toEqual(['c', 'd', 'hot'])
    expect(await cache.get('hot')).toEqual(live('HOT'))
  })

  it('offers an expired entry up for eviction before any live one', async () => {
    const { cache, advance, keys } = setup(3)
    await cache.set('stale', { value: 'S', expiresAt: 1_500 })
    await cache.set('b', live('B'))
    await cache.set('c', live('C'))

    // 'stale' is the oldest AND expired; it goes even though 'b' is older than 'c'.
    advance(1_000)
    await cache.set('d', live('D'))
    expect((await keys()).sort()).toEqual(['b', 'c', 'd'])

    // With nothing expired, eviction falls back to plain LRU.
    await cache.set('e', live('E'))
    expect((await keys()).sort()).toEqual(['c', 'd', 'e'])
  })

  it('serves an expired entry until its slot is actually needed (stale-if-error)', async () => {
    const { cache, advance } = setup(3)
    await cache.set('stale', { value: 'S', expiresAt: 1_500 })
    advance(10_000)
    expect(await cache.get('stale')).toEqual({ value: 'S', expiresAt: 1_500 })
  })

  it('stops tracking a key the storage no longer holds', async () => {
    const { cache, storage } = setup(3)
    await cache.set('a', live('A'))
    await storage.removeItem('a')
    expect(await cache.get('a')).toBeNull()
    expect(cache.size()).toBe(0)
  })

  it('hashes storage keys when a hash is given, and still evicts them', async () => {
    const storage = createStorage()
    const cache = createBoundedCache<Entry>({
      storage,
      maxEntries: 1,
      now: () => 0,
      hashKey: (key) => `h-${key}`,
    })
    await cache.set('a', live('A'))
    expect(await storage.getKeys()).toEqual(['h-a'])
    await cache.set('b', live('B'))
    expect(await storage.getKeys()).toEqual(['h-b'])
    expect(await cache.get('a')).toBeNull()
  })
})
