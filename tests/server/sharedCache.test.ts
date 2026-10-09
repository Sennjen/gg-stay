import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRawgFetch, type CacheEntry } from '../../server/rawg/rawgFetch'
import { createSteamFetch } from '../../server/steam/steamFetch'
import { createLayeredCache, createSharedLevel } from '../../server/upstream/layeredCache'
import { sharedLevelFor } from '../../server/utils/sharedCache'
import { createFakeSharedStore } from './support/sharedStore'

/**
 * Where the shared level exists, and what a transport built on it lets out of the function: the
 * decision the site's wiring makes (`server/utils/sharedCache.ts`), and the real transports over
 * a layered cache whose shared store is a map.
 */

const sha256 = (key: string) => createHash('sha256').update(key).digest('hex')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('where the shared level exists', () => {
  const level = { read: async () => null, write: () => {} }

  it('is built for a function on Vercel that is not serving fixtures', () => {
    const create = vi.fn(() => level)
    expect(sharedLevelFor({ vercel: '1', fixtures: false }, create)).toBe(level)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['off Vercel', { vercel: undefined, fixtures: false }],
    ['off Vercel, with the variable empty', { vercel: '', fixtures: false }],
    ['in fixture mode on Vercel', { vercel: '1', fixtures: true }],
    ['in fixture mode anywhere else', { vercel: undefined, fixtures: true }],
  ])('is not built %s, and nothing of the platform is touched', (_where, where) => {
    const create = vi.fn(() => level)
    expect(sharedLevelFor(where, create)).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it('builds the platform’s own when it is not handed another, without asking it anything', () => {
    // Off the platform, as here, building it is all that is safe to do — and it is safe.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const built = sharedLevelFor({ vercel: '1', fixtures: false })
    expect(built).toMatchObject({ read: expect.any(Function), write: expect.any(Function) })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('what a transport over the shared level lets out of the function', () => {
  const API_KEY = 'a-very-secret-rawg-key'
  const NOW = 1_000_000
  const DAY = 86_400

  /**
   * One instance of the function: its own memory over the store every instance shares, and the
   * two real transports on top. `keepAlive` is what gives a transport its stale window, for the
   * requests it has one for.
   */
  function instance(
    options: { store?: ReturnType<typeof createFakeSharedStore>; keepAlive?: () => void } = {},
  ) {
    const store = options.store ?? createFakeSharedStore()
    const level = createSharedLevel(store, { now: () => NOW, keepAlive: () => {} })
    const cacheOf = (source: string) => {
      const held = new Map<string, CacheEntry>()
      return createLayeredCache<CacheEntry>({
        memory: {
          get: async (key) => held.get(key) ?? null,
          set: async (key, entry) => void held.set(key, entry),
        },
        shared: level,
        source,
        hashKey: sha256,
        now: () => NOW,
      })
    }
    // A body with nothing of the request in it: whatever else gets stored came from this side.
    const fetchJson = vi.fn(async (url: string) => ({
      status: 200,
      body: url.includes('steampowered') ? { '620': { success: true } } : { id: 4200 },
    }))
    const deps = {
      fixtures: false,
      fetchJson,
      readFixture: async () => null,
      now: () => NOW,
      sleep: async () => {},
      log: () => {},
      keepAlive: options.keepAlive,
    }
    return {
      store,
      fetchJson,
      rawg: createRawgFetch({ ...deps, apiKey: API_KEY, cache: cacheOf('RAWG') }),
      steam: createSteamFetch({ ...deps, cache: cacheOf('STEAM') }),
    }
  }

  /** Lets the write nobody waited for land. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('shares a RAWG answer under a key that holds no secret and nothing of the request', async () => {
    const { rawg, store, fetchJson } = instance()

    // A list the landing keeps for a day: the one kind of list that is shared.
    await rawg('games', { ordering: '-added', page_size: 40 }, { ttl: DAY })
    await settle()

    // The request itself carried the key, as it must.
    expect(fetchJson.mock.calls[0]![0]).toContain(`key=${API_KEY}`)
    expect(store.writes).toHaveLength(1)
    const { key } = store.writes[0]!
    expect(key).toBe(`v1.RAWG.${sha256('games?ordering=-added&page_size=40')}`)
    for (const hidden of [API_KEY, 'key=', 'ordering', 'added', 'page_size', 'http', '?']) {
      expect(key).not.toContain(hidden)
    }
    expect([...store.reads, ...store.entries.keys()]).toEqual([key, key])
  })

  it.each([
    ['a search, on a list', 'games', { search: 'half life', page: 2 }, undefined],
    ['a search, on a list kept for a day', 'games', { search: 'half life' }, { ttl: DAY }],
    ['a search, on a taxonomy', 'developers', { search: 'va', page_size: 10 }, undefined],
    ['a ten-minute list, though nobody typed any of it', 'games', { genres: 'rpg' }, undefined],
  ])(
    'keeps %s in memory alone: the shared store is neither read nor written',
    async (_what, path, params, options) => {
      const { rawg, store, fetchJson } = instance()

      const first = await rawg(path, params, options)
      await settle()
      // Memory still answers the instance that asked.
      expect(await rawg(path, params, options)).toBe(first)

      expect(fetchJson).toHaveBeenCalledTimes(1)
      expect(store.reads).toEqual([])
      expect(store.writes).toEqual([])
    },
  )

  it('stores the body the upstream gave and its two moments, and no address or key beside it', async () => {
    const { rawg, store } = instance()

    expect(await rawg('games/portal-2')).toEqual({ id: 4200 })
    await settle()

    expect(store.writes).toHaveLength(1)
    expect(store.writes[0]!.value).toEqual({
      value: { id: 4200 },
      expiresAt: NOW + DAY * 1000,
      storedAt: NOW,
    })
    const stored = JSON.stringify([...store.entries])
    for (const hidden of [API_KEY, 'key=', 'api.rawg.io', 'http']) {
      expect(stored).not.toContain(hidden)
    }
  })

  it('lets a second instance answer from what the first one fetched, and asks the upstream nothing', async () => {
    const first = instance()
    const second = instance({ store: createFakeSharedStore(first.store.entries) })

    const fetched = await first.rawg('games/portal-2')
    await first.steam('620')
    await settle()

    // A new instance: empty memory, the same shared store.
    expect(await second.rawg('games/portal-2')).toEqual(fetched)
    expect(await second.steam('620')).toEqual({ '620': { success: true } })
    expect(second.fetchJson).not.toHaveBeenCalled()
    expect(second.store.reads).toEqual([
      `v1.RAWG.${sha256('games/portal-2')}`,
      `v1.STEAM.${sha256('620')}`,
    ])
  })

  it('keeps what a game page is made of for eight days; Steam’s page and a day-long list for a day past their freshness', async () => {
    const { rawg, steam, store } = instance({ keepAlive: () => {} })

    for (const path of ['games/portal-2', 'games/portal-2/stores', 'games/portal-2/screenshots']) {
      await rawg(path)
    }
    await steam('620')
    await rawg('games', { ordering: '-added' }, { ttl: DAY })
    await rawg('games/3328/movies')
    await rawg('genres')
    await rawg('platforms')
    await settle()

    expect(store.writes.map((write) => [write.key.split('.')[1], write.ttlSeconds])).toEqual([
      // A day fresh and a week stale: the cap.
      ['RAWG', 8 * DAY],
      ['RAWG', 8 * DAY],
      ['RAWG', 8 * DAY],
      // No stale window, Steam's page included: the freshness and a day.
      ['STEAM', DAY + DAY],
      ['RAWG', DAY + DAY],
      ['RAWG', DAY + DAY],
      // A week fresh: the cap again.
      ['RAWG', 8 * DAY],
      ['RAWG', 8 * DAY],
    ])
  })

  it('keeps a game for its freshness and a day where nothing can be served stale', async () => {
    // No keep-alive: these transports have no stale window to keep an entry through.
    const { rawg, steam, store } = instance()

    await rawg('games/portal-2')
    await steam('620')
    await settle()

    expect(store.writes.map((write) => write.ttlSeconds)).toEqual([DAY + DAY, DAY + DAY])
  })
})
