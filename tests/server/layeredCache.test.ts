import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedRead } from '../../server/upstream/createUpstreamFetch'
import {
  createLayeredCache,
  createSharedLevel,
  SHARED_CACHE_DEADLINE_MS,
  SHARED_CACHE_MAX_BYTES,
  SHARED_CACHE_MAX_TTL_SECONDS,
  SHARED_CACHE_PAUSE_MS,
  SHARED_CACHE_SCHEMA,
  sharedTtlSeconds,
  type SharedLevel,
  type SharedStore,
} from '../../server/upstream/layeredCache'
import { createFakeSharedStore } from './support/sharedStore'

/**
 * The cache in two levels — the instance's memory and the store every instance shares — over a
 * shared store that is a map, or a promise the case settles by hand. Time is the fake timers':
 * the deadline, the pause and the clock the cache reads all move together, and no case waits.
 */

interface Entry {
  value: unknown
  expiresAt: number
  storedAt?: number
}

/** The moment every case starts at. */
const START = 1_700_000_000_000

const sha256 = (key: string) => createHash('sha256').update(key).digest('hex')

/** The key the shared store holds `key` under, for a cache of `source`. */
const sharedKeyOf = (key: string, source = 'RAWG') =>
  `${SHARED_CACHE_SCHEMA}.${source}.${sha256(key)}`

/** An entry stored `age` ms ago with `ttl` ms to live from then. */
const entryOf = (value: unknown, { age = 0, ttl = 600_000 } = {}): Entry => ({
  value,
  expiresAt: Date.now() - age + ttl,
  storedAt: Date.now() - age,
})

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** Lets everything that is ready to run, run: a real turn of the event loop, not a wait. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Whether `work` has settled yet, without waiting for it. */
function watch(work: Promise<unknown>) {
  const seen = { settled: false }
  const mark = () => void (seen.settled = true)
  work.then(mark, mark)
  return seen
}

function memoryLevel() {
  const held = new Map<string, Entry>()
  return {
    held,
    get: vi.fn(async (key: string) => held.get(key) ?? null),
    set: vi.fn(async (key: string, entry: Entry) => void held.set(key, entry)),
  }
}

/** One shared level over `store`, with what it handed to the keep-alive and what it warned of. */
function levelOver(store: SharedStore) {
  const kept: Promise<unknown>[] = []
  const warn = vi.fn<(line: string) => void>()
  const level = createSharedLevel(store, {
    now: () => Date.now(),
    keepAlive: (work) => void kept.push(work),
    warn,
  })
  return { level, kept, warn, lines: () => warn.mock.calls.map(([line]) => line) }
}

function cacheOver(level: SharedLevel | undefined, source = 'RAWG') {
  const memory = memoryLevel()
  const cache = createLayeredCache<Entry>({
    memory,
    shared: level,
    source,
    hashKey: sha256,
    now: () => Date.now(),
  })
  return { cache, memory }
}

/** A layered cache over a shared store that is a map. */
function setup(store = createFakeSharedStore()) {
  const shared = levelOver(store)
  return { store, ...shared, ...cacheOver(shared.level) }
}

/** Puts `entry` in the shared store as another instance would have written it. */
function shareEntry(store: ReturnType<typeof createFakeSharedStore>, key: string, entry: Entry) {
  store.entries.set(sharedKeyOf(key), JSON.stringify(entry))
}

beforeEach(() => {
  // `setImmediate` stays real, for `settle`; the clock and the timers are the test's.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a read', () => {
  it('is answered by memory when memory holds a live entry, and the shared store is not asked', async () => {
    const { cache, memory, store } = setup()
    const local = entryOf({ id: 1 })
    memory.held.set('games/portal-2', local)
    shareEntry(store, 'games/portal-2', { ...entryOf({ id: 2 }), storedAt: Date.now() + 1 })

    expect(await cache.get('games/portal-2')).toBe(local)
    expect(store.reads).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks the shared store when memory has nothing, and copies what it finds into memory', async () => {
    const { cache, memory, store } = setup()
    const remote = entryOf({ id: 4200 }, { age: 60_000 })
    shareEntry(store, 'games/portal-2', remote)

    expect(await cache.get('games/portal-2')).toEqual(remote)
    expect(store.reads).toEqual([sharedKeyOf('games/portal-2')])
    expect(memory.set).toHaveBeenCalledExactlyOnceWith('games/portal-2', remote)

    // From now on it is memory's: the second read never leaves the instance.
    expect(await cache.get('games/portal-2')).toEqual(remote)
    expect(store.reads).toHaveLength(1)
  })

  it('asks the shared store when memory holds only an expired entry, and takes the newer one', async () => {
    const { cache, memory, store } = setup()
    memory.held.set('games', entryOf({ page: 'old' }, { age: 700_000 }))
    const remote = entryOf({ page: 'new' }, { age: 5_000 })
    shareEntry(store, 'games', remote)

    expect(await cache.get('games')).toEqual(remote)
    expect(store.reads).toEqual([sharedKeyOf('games')])
    expect(memory.held.get('games')).toEqual(remote)
  })

  it.each([
    ['the very entry memory holds', 700_000],
    ['an older one', 900_000],
  ])('keeps memory’s entry when the shared store has %s', async (_what, sharedAge) => {
    const { cache, memory, store } = setup()
    const local = entryOf({ page: 'mine' }, { age: 700_000 })
    memory.held.set('games', local)
    shareEntry(store, 'games', entryOf({ page: 'theirs' }, { age: sharedAge }))

    expect(await cache.get('games')).toBe(local)
    expect(store.reads).toHaveLength(1)
    expect(memory.set).not.toHaveBeenCalled()
  })

  it('hands back the expired entry memory holds when the shared store has nothing', async () => {
    const { cache, memory, store } = setup()
    const local = entryOf({ page: 'mine' }, { age: 700_000 })
    memory.held.set('games', local)

    // Still the fallback for a refresh that fails, exactly as it was with memory alone.
    expect(await cache.get('games')).toBe(local)
    expect(store.reads).toHaveLength(1)
  })

  it.each([
    ['only an expired entry', true],
    ['nothing', false],
  ])(
    'does not cover what memory gained while the shared store was read, when memory had %s',
    async (_what, hadEntry) => {
      const reading = deferred<unknown>()
      const { level } = levelOver({ get: () => reading.promise, set: async () => {} })
      const { cache, memory } = cacheOver(level)
      if (hadEntry) memory.held.set('games/portal-2', entryOf({ v: 0 }, { age: 700_000 }))
      const told = vi.fn<(read: SharedRead) => void>()

      const read = cache.get('games/portal-2', told)
      await settle()
      // This instance's own refresh lands while the read is out…
      const refreshed = entryOf({ v: 2 })
      memory.held.set('games/portal-2', refreshed)
      // …and the shared store answers with what another instance wrote five minutes ago.
      reading.resolve(entryOf({ v: 1 }, { age: 300_000 }))

      // The newer of the two still wins, and is still what memory holds.
      expect(await read).toBe(refreshed)
      expect(memory.held.get('games/portal-2')).toBe(refreshed)
      expect(memory.set).not.toHaveBeenCalled()
      expect(told).toHaveBeenCalledExactlyOnceWith({ ms: 0, hit: false })
    },
  )

  it('hands back what memory gained while the shared store was read, when that store had nothing', async () => {
    const reading = deferred<unknown>()
    const { level } = levelOver({ get: () => reading.promise, set: async () => {} })
    const { cache, memory } = cacheOver(level)
    memory.held.set('games/portal-2', entryOf({ v: 0 }, { age: 700_000 }))

    const read = cache.get('games/portal-2')
    await settle()
    const refreshed = entryOf({ v: 2 })
    memory.held.set('games/portal-2', refreshed)
    reading.resolve(null)

    // Not the expired entry the call first found: nobody need fetch what is already here.
    expect(await read).toBe(refreshed)
  })

  it('is a miss when neither level holds the key', async () => {
    const { cache, store } = setup()
    expect(await cache.get('games/nope')).toBeNull()
    expect(store.reads).toHaveLength(1)
  })

  it.each([
    ['nothing', null],
    ['text', '{"value":1}'],
    ['a number', 42],
    ['an entry with no moments at all', { value: { id: 1 } }],
    ['an entry that does not say when it was stored', { value: { id: 1 }, expiresAt: START * 2 }],
    ['an entry whose moments are not numbers', { value: 1, expiresAt: '9', storedAt: '1' }],
  ])('takes %s from the shared store for no entry, and for no failure', async (_what, stored) => {
    const { cache, memory, store, warn } = setup()
    store.entries.set(sharedKeyOf('games'), JSON.stringify(stored))

    expect(await cache.get('games')).toBeNull()
    expect(memory.set).not.toHaveBeenCalled()
    // The store answered; what it answered was not ours. It is asked again the next time.
    expect(warn).not.toHaveBeenCalled()
    await cache.get('games')
    expect(store.reads).toHaveLength(2)
  })
})

describe('a write', () => {
  it('goes to memory and to the shared store', async () => {
    const { cache, memory, store } = setup()
    const entry = entryOf({ id: 4200 })

    await cache.set('games/portal-2', entry)
    await settle()

    expect(memory.held.get('games/portal-2')).toBe(entry)
    expect(store.writes).toEqual([
      { key: sharedKeyOf('games/portal-2'), value: entry, ttlSeconds: 87_000 },
    ])
  })

  it('writes memory first, and the shared store only once memory has the entry', async () => {
    const order: string[] = []
    const store = createFakeSharedStore()
    const shared = levelOver({
      get: store.get,
      set: async (...write) => {
        order.push('shared')
        return store.set(...write)
      },
    })
    const { cache, memory } = cacheOver(shared.level)
    const inMemory = deferred<undefined>()
    memory.set.mockImplementation(async () => {
      order.push('memory')
      await inMemory.promise
    })

    const written = cache.set('games', entryOf({ ok: true }))
    await settle()
    expect(order).toEqual(['memory'])
    inMemory.resolve(undefined)
    await written
    expect(order).toEqual(['memory', 'shared'])
  })

  it('is not waited for: the call is over while the shared store is still writing', async () => {
    const writing = deferred<undefined>()
    const set = vi.fn(() => writing.promise)
    const { level, kept } = levelOver({ get: async () => null, set })
    const { cache, memory } = cacheOver(level)
    const entry = entryOf({ id: 1 })

    await cache.set('games', entry)

    expect(memory.held.get('games')).toBe(entry)
    expect(set).toHaveBeenCalledTimes(1)
    // The write was handed to the request's keep-alive, and is still out.
    expect(kept).toHaveLength(1)
    const handedOver = watch(kept[0]!)
    await settle()
    expect(handedOver.settled).toBe(false)

    writing.resolve(undefined)
    await settle()
    expect(handedOver.settled).toBe(true)
  })

  it.each<[string, Partial<SharedStore>, unknown]>([
    ['the store rejects', { set: () => Promise.reject(new Error('the store is down')) }, 1],
    [
      'the store throws',
      {
        set: () => {
          throw new Error('the store is broken')
        },
      },
      1,
    ],
    // A number JSON cannot write: `JSON.stringify` throws on it.
    ['the entry cannot be serialised', {}, 10n],
  ])('cannot fail the call when %s', async (_what, broken, value) => {
    const { level, kept } = levelOver({ ...createFakeSharedStore(), ...broken })
    const { cache, memory } = cacheOver(level)
    const entry = entryOf(value)

    await expect(cache.set('games', entry)).resolves.toBeUndefined()
    expect(memory.held.get('games')).toBe(entry)
    // Whatever was handed to the keep-alive cannot reject either: the platform's does not catch.
    for (const work of kept) await expect(work).resolves.toBeUndefined()
  })

  it('cannot fail the call when the keep-alive will not take the work', async () => {
    const store = createFakeSharedStore()
    const level = createSharedLevel(store, {
      now: () => Date.now(),
      keepAlive: () => {
        throw new Error('the response has already been sent')
      },
    })
    const { cache, memory } = cacheOver(level)

    await expect(cache.set('games', entryOf({ ok: true }))).resolves.toBeUndefined()
    expect(memory.held.has('games')).toBe(true)
  })

  it('pauses nothing and says nothing when it fails', async () => {
    const store = createFakeSharedStore()
    const { level, warn } = levelOver({
      get: store.get,
      set: () => Promise.reject(new Error('the store is down')),
    })
    const { cache } = cacheOver(level)

    await cache.set('games', entryOf({ ok: true }))
    await settle()

    expect(warn).not.toHaveBeenCalled()
    await cache.get('games/portal-2')
    expect(store.reads).toHaveLength(1)
  })

  it('keeps an entry that does not say when it was stored in memory alone', async () => {
    const { cache, memory, store } = setup()
    const entry: Entry = { value: { id: 1 }, expiresAt: Date.now() + 600_000 }

    await cache.set('games', entry)
    await settle()

    expect(memory.held.get('games')).toBe(entry)
    expect(store.writes).toEqual([])
  })
})

describe('how long the shared store keeps an entry', () => {
  const DAY = 86_400

  it.each([
    ['a list: ten minutes fresh, no stale window', 600, 0, 600 + DAY],
    ['a landing list: a day fresh', DAY, 0, 2 * DAY],
    ['a game: a day fresh, a week stale', DAY, 7 * DAY, 8 * DAY],
    ['a taxonomy: a week fresh', 7 * DAY, 0, 8 * DAY],
    ['a live price: six hours', 6 * 3_600, 0, 6 * 3_600 + DAY],
    ['no live price: one hour', 3_600, 0, 3_600 + DAY],
    ['a stale window shorter than the freshness', 7_200, 3_600, 7_200 + DAY],
  ])('%s', (_what, freshness, stale, expected) => {
    expect(sharedTtlSeconds(freshness, stale)).toBe(expected)
  })

  it('is never more than eight days, however long an entry may be served', () => {
    expect(SHARED_CACHE_MAX_TTL_SECONDS).toBe(8 * DAY)
    expect(sharedTtlSeconds(30 * DAY, 0)).toBe(8 * DAY)
    expect(sharedTtlSeconds(DAY, 30 * DAY)).toBe(8 * DAY)
    expect(sharedTtlSeconds(Number.POSITIVE_INFINITY, 0)).toBe(8 * DAY)
  })

  it('is a whole number of seconds, and a day for an entry with no lifetime to speak of', () => {
    expect(sharedTtlSeconds(600.2, 0)).toBe(601 + DAY)
    expect(sharedTtlSeconds(0, 0)).toBe(DAY)
    expect(sharedTtlSeconds(-5, -5)).toBe(DAY)
    expect(sharedTtlSeconds(Number.NaN, Number.NaN)).toBe(DAY)
  })

  it('is worked out from the entry’s own freshness and the stale window it was written with', async () => {
    const { cache, store } = setup()

    await cache.set('games', entryOf({ list: true }, { ttl: 600_000 }))
    await cache.set('games/portal-2', entryOf({ id: 1 }, { ttl: DAY * 1000 }), 7 * DAY)
    // Written a while after it was stored: the freshness is the entry's, not what is left of it.
    await cache.set('genres', entryOf({ genres: [] }, { age: 5_000, ttl: 3_600_000 }))
    await settle()

    expect(store.writes.map((write) => write.ttlSeconds)).toEqual([600 + DAY, 8 * DAY, 3_600 + DAY])
  })
})

describe('the key an entry is shared under', () => {
  it('is the schema version, the source and the hash of the caller’s key', async () => {
    const { cache, store } = setup()
    const key = 'games?page=2&search=half life'

    await cache.get(key)
    await cache.set(key, entryOf({ results: [] }))
    await settle()

    const expected = `v1.RAWG.${sha256(key)}`
    expect(store.reads).toEqual([expected])
    expect(store.writes.map((write) => write.key)).toEqual([expected])
    // Nothing of what the visitor typed is in it.
    for (const typed of ['half', 'life', 'search', 'page', '?', '=', ' ']) {
      expect(expected).not.toContain(typed)
    }
    expect(expected).toMatch(/^v1\.RAWG\.[0-9a-f]{64}$/)
  })

  it('keeps two sources apart, though they were given the same key', async () => {
    const store = createFakeSharedStore()
    const { level } = levelOver(store)
    const rawg = cacheOver(level, 'RAWG').cache
    const steam = cacheOver(level, 'STEAM').cache

    await rawg.set('292030', entryOf({ from: 'rawg' }))
    await settle()

    expect(await steam.get('292030')).toBeNull()
    expect(store.reads).toEqual([`v1.STEAM.${sha256('292030')}`])
    expect([...store.entries.keys()]).toEqual([`v1.RAWG.${sha256('292030')}`])
  })
})

describe('an entry too large for the shared store', () => {
  /**
   * An entry whose JSON is exactly `bytes` long, in the two-byte letters a Ukrainian text is
   * made of.
   */
  function entryOfBytes(bytes: number): Entry {
    const empty: Entry = { value: '', expiresAt: START + 600_000, storedAt: START }
    const room = bytes - Buffer.byteLength(JSON.stringify(empty))
    const entry = { ...empty, value: 'я'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2) }
    expect(Buffer.byteLength(JSON.stringify(entry))).toBe(bytes)
    return entry
  }

  it('is 1.5 MB serialised, counted in bytes', () => {
    expect(SHARED_CACHE_MAX_BYTES).toBe(1_500_000)
  })

  it('is kept in memory and not written to the shared store', async () => {
    const { cache, memory, store, kept, warn } = setup()
    const entry = entryOfBytes(SHARED_CACHE_MAX_BYTES + 1)
    // Well under the limit in characters: it is the bytes that count.
    expect(JSON.stringify(entry).length).toBeLessThan(SHARED_CACHE_MAX_BYTES * 0.6)

    await cache.set('games/huge', entry)
    await settle()

    expect(memory.held.get('games/huge')).toBe(entry)
    expect(store.writes).toEqual([])
    expect(kept).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('is written when it is exactly at the limit', async () => {
    const { cache, store } = setup()

    await cache.set('games/large', entryOfBytes(SHARED_CACHE_MAX_BYTES))
    await settle()

    expect(store.writes).toHaveLength(1)
  })
})

describe('the deadline of a shared read', () => {
  /** A layered cache over a store whose one read the case answers by hand. */
  function slowStore() {
    const reading = deferred<unknown>()
    const get = vi.fn(() => reading.promise)
    const shared = levelOver({ get, set: async () => {} })
    return { reading, get, ...shared, ...cacheOver(shared.level) }
  }

  it('is 150 ms', () => {
    expect(SHARED_CACHE_DEADLINE_MS).toBe(150)
  })

  it('takes an answer that arrives a millisecond inside it', async () => {
    const { cache, reading, warn } = slowStore()
    const remote = entryOf({ id: 4200 })

    const read = cache.get('games/portal-2')
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS - 1)
    reading.resolve(remote)

    expect(await read).toEqual(remote)
    expect(warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is a miss at 150 ms and not a moment later, whatever the store goes on to answer', async () => {
    const { cache, memory, reading } = slowStore()
    const local = entryOf({ page: 'mine' }, { age: 700_000 })
    memory.held.set('games', local)

    const read = cache.get('games')
    const seen = watch(read)
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS - 1)
    expect(seen.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.settled).toBe(true)
    // What memory holds, as if the shared store had nothing.
    expect(await read).toBe(local)
    expect(vi.getTimerCount()).toBe(0)

    // The answer that comes too late changes nothing: it is not copied into memory behind the call.
    reading.resolve(entryOf({ page: 'theirs' }))
    await settle()
    expect(memory.held.get('games')).toBe(local)
    expect(memory.set).not.toHaveBeenCalled()
  })

  it('leaves no timer behind an answer in time, a failure, or a store that throws', async () => {
    const answered = slowStore()
    const first = answered.cache.get('games')
    answered.reading.resolve(null)
    await first
    expect(vi.getTimerCount()).toBe(0)

    const failed = slowStore()
    const second = failed.cache.get('games')
    failed.reading.reject(new Error('the store is down'))
    await second
    expect(vi.getTimerCount()).toBe(0)

    const { level } = levelOver({
      get: () => {
        throw new Error('the store is broken')
      },
      set: async () => {},
    })
    await cacheOver(level).cache.get('games')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a read it gave up on to fail by itself, with no unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { cache, reading } = slowStore()
      const read = cache.get('games')
      await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS)
      expect(await read).toBeNull()

      reading.reject(new Error('the store gave up long after the answer'))
      await settle()
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('a shared store that fails', () => {
  /** A shared store that is a map until a case breaks it. */
  function breakable() {
    const store = createFakeSharedStore()
    const state: { broken: 'rejects' | 'throws' | 'hangs' | null } = { broken: null }
    const get = vi.fn((key: string) => {
      if (state.broken === 'throws') throw new Error('the store is broken')
      if (state.broken === 'rejects') return Promise.reject(new Error('the store is down'))
      if (state.broken === 'hangs') return new Promise<unknown>(() => {})
      return store.get(key)
    })
    const shared = levelOver({ get, set: store.set })
    return { store, state, get, ...shared, ...cacheOver(shared.level) }
  }

  it.each(['rejects', 'throws'] as const)(
    'is a miss when its read %s: the call gets what memory holds',
    async (broken) => {
      const { cache, memory, state } = breakable()
      state.broken = broken
      const local = entryOf({ page: 'mine' }, { age: 700_000 })
      memory.held.set('games', local)

      expect(await cache.get('games')).toBe(local)
      expect(await cache.get('games/portal-2')).toBeNull()
    },
  )

  it('is left alone for thirty seconds, reads and writes alike, and is then asked again', async () => {
    expect(SHARED_CACHE_PAUSE_MS).toBe(30_000)
    const { cache, store, state, get } = breakable()
    shareEntry(store, 'games/portal-2', entryOf({ id: 4200 }))
    state.broken = 'rejects'
    await cache.get('games')
    expect(get).toHaveBeenCalledTimes(1)

    // The store is fine again a moment later, and nobody finds out for thirty seconds.
    state.broken = null
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_PAUSE_MS - 1)
    expect(await cache.get('games/portal-2')).toBeNull()
    await cache.set('genres', entryOf({ genres: [] }))
    await settle()
    expect(get).toHaveBeenCalledTimes(1)
    expect(store.writes).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(await cache.get('games/portal-2')).toMatchObject({ value: { id: 4200 } })
    expect(get).toHaveBeenCalledTimes(2)
    await cache.set('genres', entryOf({ genres: [] }))
    await settle()
    expect(store.writes).toHaveLength(1)
  })

  it('costs a request one deadline, not one for every call it makes', async () => {
    const { cache, state, get } = breakable()
    state.broken = 'hangs'

    // The first call waits out the deadline.
    const first = cache.get('games/portal-2')
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS)
    expect(await first).toBeNull()

    // The calls after it are answered without a wait, and without a timer.
    for (const key of ['games/portal-2/stores', 'games/portal-2/screenshots']) {
      expect(await cache.get(key)).toBeNull()
    }
    expect(get).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('spares every cache built on the same level, whatever each of them keeps', async () => {
    const store = createFakeSharedStore()
    const get = vi.fn(() => Promise.reject(new Error('the store is down')))
    const { level, warn } = levelOver({ get, set: store.set })
    const rawg = cacheOver(level, 'RAWG').cache
    const steam = cacheOver(level, 'STEAM').cache
    const prices = cacheOver(level, 'STEAM_PRICE').cache

    await rawg.get('games/portal-2')
    await steam.get('620')
    await prices.get('steam-price:620')

    expect(get).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('says so once for a pause, in one line that names no key', async () => {
    const { cache, state, lines } = breakable()
    state.broken = 'rejects'

    await cache.get('games?search=half life')
    await cache.get('games/portal-2')

    expect(lines()).toEqual([
      '[shared-cache] a read failed (Error: the store is down); left alone for 30 s',
    ])
  })

  it('says so once when several reads find it down at the same moment', async () => {
    const { cache, state, get, lines } = breakable()
    state.broken = 'hangs'

    // One page: the game, its store links and its screenshots, asked for side by side.
    const reads = ['games/a', 'games/a/stores', 'games/a/screenshots'].map((key) => cache.get(key))
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS)

    expect(await Promise.all(reads)).toEqual([null, null, null])
    expect(get).toHaveBeenCalledTimes(3)
    expect(lines()).toEqual(['[shared-cache] a read took longer than 150 ms; left alone for 30 s'])
  })

  it('says so again for the next pause, when it is still down after the first', async () => {
    const { cache, state, get, warn } = breakable()
    state.broken = 'rejects'

    await cache.get('games')
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_PAUSE_MS)
    await cache.get('games')
    await cache.get('games')

    expect(get).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('cuts whatever the store said about its failure to a line of a fixed length', async () => {
    const { level, lines } = levelOver({
      get: () => Promise.reject(new Error(`too\nmany\twords ${'x'.repeat(5_000)}`)),
      set: async () => {},
    })
    await cacheOver(level).cache.get('games')

    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toMatch(
      /^\[shared-cache\] a read failed \(Error: too many words x+…\); left/,
    )
    expect(lines()[0]!.length).toBeLessThan(230)
  })

  it('goes to console.warn when nothing else was asked for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const level = createSharedLevel(
      { get: () => Promise.reject(new Error('the store is down')), set: async () => {} },
      { now: () => Date.now(), keepAlive: () => {} },
    )
    await cacheOver(level).cache.get('games')

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[shared-cache] a read failed (Error: the store is down); left alone for 30 s',
    )
  })
})

describe('a read that is measured', () => {
  it('says how long the shared read took, and that its entry was the one handed back', async () => {
    const store = createFakeSharedStore()
    const { level } = levelOver({
      get: (key) => new Promise((resolve) => setTimeout(() => resolve(store.get(key)), 12)),
      set: store.set,
    })
    const { cache } = cacheOver(level)
    shareEntry(store, 'games/portal-2', entryOf({ id: 4200 }))
    const told = vi.fn<(read: SharedRead) => void>()

    const read = cache.get('games/portal-2', told)
    await vi.advanceTimersByTimeAsync(12)
    // Told by the time the read is over, not after it.
    const calls = await read.then(() => told.mock.calls.length)

    expect(calls).toBe(1)
    expect(told).toHaveBeenCalledExactlyOnceWith({ ms: 12, hit: true })
  })

  it('says a read found nothing when the store had nothing, or nothing newer than memory', async () => {
    const { cache, memory, store } = setup()
    const told = vi.fn<(read: SharedRead) => void>()

    await cache.get('games/nope', told)
    memory.held.set('games', entryOf({ page: 'mine' }, { age: 700_000 }))
    shareEntry(store, 'games', entryOf({ page: 'theirs' }, { age: 700_000 }))
    await cache.get('games', told)

    expect(told.mock.calls).toEqual([[{ ms: 0, hit: false }], [{ ms: 0, hit: false }]])
  })

  it('says a read that ran out of time took the whole deadline and found nothing', async () => {
    const { level } = levelOver({ get: () => new Promise(() => {}), set: async () => {} })
    const told = vi.fn<(read: SharedRead) => void>()

    const read = cacheOver(level).cache.get('games', told)
    await vi.advanceTimersByTimeAsync(SHARED_CACHE_DEADLINE_MS)
    await read

    expect(told).toHaveBeenCalledExactlyOnceWith({ ms: SHARED_CACHE_DEADLINE_MS, hit: false })
  })

  it('says nothing of a read memory answered, or of a store that is being left alone', async () => {
    const store = createFakeSharedStore()
    const get = vi.fn(() => Promise.reject(new Error('the store is down')))
    const { level } = levelOver({ get, set: store.set })
    const { cache, memory } = cacheOver(level)
    memory.held.set('games', entryOf({ page: 'mine' }))
    const told = vi.fn<(read: SharedRead) => void>()

    await cache.get('games', told)
    expect(told).not.toHaveBeenCalled()

    // The read that finds the store down is a read; the ones it spares are not.
    await cache.get('games/a', told)
    await cache.get('games/b', told)
    expect(told).toHaveBeenCalledExactlyOnceWith({ ms: 0, hit: false })
  })

  it('answers whatever its listener does with the news', async () => {
    const { cache, store } = setup()
    const remote = entryOf({ id: 4200 })
    shareEntry(store, 'games/portal-2', remote)

    const read = cache.get('games/portal-2', () => {
      throw new Error('the collector failed')
    })

    expect(await read).toEqual(remote)
  })
})

describe('a cache with no shared level', () => {
  it('is the memory it was given: the same two functions, and nothing in front of them', async () => {
    const { cache, memory } = cacheOver(undefined)

    expect(cache.get).toBe(memory.get)
    expect(cache.set).toBe(memory.set)

    const entry = entryOf({ id: 1 })
    await cache.set('games', entry, 604_800)
    expect(await cache.get('games', () => {})).toBe(entry)
    expect(vi.getTimerCount()).toBe(0)
  })
})
