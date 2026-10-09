import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The caches as the site wires them (`server/utils/rawg.ts`, `steam.ts`, `resolverCache.ts`), on
 * Vercel and off it. Nothing here is a double of ours except the edges of the process: Nitro's
 * two auto-imports, `fetch`, and the request context the Vercel runtime keeps under a global
 * symbol — where `@vercel/functions` finds the platform's cache and its `waitUntil`. So what a
 * case sees reach the platform is what a deployed function would send it.
 *
 * Each case imports the modules afresh: they build their transports once per process, and a case
 * is a process of its own — which is also how a second instance of the function is made.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')
const DAY_MS = 86_400_000
const START = 1_700_000_000_000

const sha256 = (key: string) => createHash('sha256').update(key).digest('hex')

/**
 * The platform's Runtime Cache: one map for every instance, and a record of what was asked of
 * it.
 */
function platform() {
  const held = new Map<string, string>()
  const kept: Promise<unknown>[] = []
  const cache = {
    get: vi.fn(async (key: string): Promise<unknown> => {
      const stored = held.get(key)
      return stored === undefined ? null : JSON.parse(stored)
    }),
    set: vi.fn(async (key: string, value: unknown, _options?: { ttl?: number }) => {
      held.set(key, JSON.stringify(value))
    }),
    delete: vi.fn(async () => {}),
    expireTag: vi.fn(async () => {}),
  }
  const waitUntil = vi.fn((work: Promise<unknown>) => void kept.push(work))
  return { held, kept, cache, waitUntil }
}

type Platform = ReturnType<typeof platform>

/** Nitro's in-memory storage driver, one per mount, as far as the caches use it. */
function storages() {
  const mounts = new Map<string, Map<string, unknown>>()
  return (base: string) => {
    const items = mounts.get(base) ?? new Map<string, unknown>()
    mounts.set(base, items)
    return {
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: unknown) => void items.set(key, value),
      removeItem: async (key: string) => void items.delete(key),
    }
  }
}

/** Steam's page about app 620, as far as the transport keeps it, saying `text`. */
const steamPage = (text: string) => ({
  '620': { success: true, data: { short_description: text } },
})

/**
 * A new instance of the function. `vercel` is whether it runs on the platform — the variable and
 * the request context — and `fixtures` is fixture mode; `upstream` is what RAWG answers, and what
 * Steam's page says.
 */
async function instance(options: {
  vercel: Platform | null
  fixtures?: boolean
  upstream?: () => unknown
}) {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  if (options.vercel) {
    vi.stubEnv('VERCEL', '1')
    const { cache, waitUntil } = options.vercel
    vi.stubGlobal(REQUEST_CONTEXT as unknown as string, { get: () => ({ cache, waitUntil }) })
  } else {
    vi.stubEnv('VERCEL', undefined)
  }
  vi.stubGlobal('useRuntimeConfig', () => ({
    rawgApiKey: 'a-very-secret-rawg-key',
    rawgFixtures: options.fixtures ? 1 : '',
  }))
  const storage = storages()
  // The fixture mounts answer every name, as a recording would.
  vi.stubGlobal('useStorage', (base: string) =>
    base.startsWith('assets:') ? { getItem: async () => ({ recorded: true }) } : storage(base),
  )
  const fetched: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      const answer = options.upstream?.() ?? { ok: true }
      const body = url.includes('steampowered') ? steamPage(JSON.stringify(answer)) : answer
      return new Response(JSON.stringify(body))
    }),
  )

  const { useRawg } = await import('../../server/utils/rawg')
  const { useSteam } = await import('../../server/utils/steam')
  const { useResolverCache } = await import('../../server/utils/resolverCache')
  return { rawg: useRawg(), steam: useSteam(), cache: useResolverCache(), fetched }
}

/** Lets the writes and the refreshes nobody waited for run to their end. */
async function settle(kept: Promise<unknown>[] = []): Promise<void> {
  await Promise.all(kept)
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * `work`, with the limiter's wait between two requests to one upstream run through rather than
 * waited out.
 */
async function behindTheLimiter<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return work
}

beforeEach(() => {
  // `setImmediate` stays real, for `settle`; the clock and every timer are the test's.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: START })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the caches of a function on Vercel', () => {
  it('share what RAWG answered: under this project’s name, a version, the source and a hash', async () => {
    const vercel = platform()
    const first = await instance({ vercel, upstream: () => ({ id: 4200 }) })

    expect(await first.rawg('games/portal-2')).toEqual({ id: 4200 })
    await settle(vercel.kept)

    const key = `gg-stay$v1.RAWG.${sha256('games/portal-2')}`
    expect(vercel.cache.get).toHaveBeenCalledExactlyOnceWith(key)
    expect(vercel.cache.set).toHaveBeenCalledTimes(1)
    const [writtenKey, entry, written] = vercel.cache.set.mock.calls[0]!
    expect(writtenKey).toBe(key)
    expect(entry).toEqual({ value: { id: 4200 }, expiresAt: START + DAY_MS, storedAt: START })
    // A day fresh and a week stale, and a day past that: the cap of eight.
    expect(written).toMatchObject({ ttl: 8 * 86_400 })
    // The write was not waited for: it was handed to the request to keep alive.
    expect(vercel.waitUntil).toHaveBeenCalledTimes(1)

    // A new instance — empty memory, the same platform — asks RAWG nothing.
    const second = await instance({ vercel })
    expect(await second.rawg('games/portal-2')).toEqual({ id: 4200 })
    expect(second.fetched).toEqual([])
  })

  it('share nothing that holds the API key or anything of the request', async () => {
    const vercel = platform()
    const { rawg, fetched } = await instance({ vercel, upstream: () => ({ results: [] }) })

    // A list the landing keeps for a day.
    await rawg('games', { ordering: '-added', page_size: 40 }, { ttl: 86_400 })
    await settle(vercel.kept)

    expect(fetched[0]).toContain('key=a-very-secret-rawg-key')
    const [key, , options] = vercel.cache.set.mock.calls[0]!
    expect(key).toBe(`gg-stay$v1.RAWG.${sha256('games?ordering=-added&page_size=40')}`)
    const sent = JSON.stringify([vercel.cache.get.mock.calls, vercel.cache.set.mock.calls, options])
    for (const hidden of ['a-very-secret-rawg-key', 'key=', 'ordering', 'added', 'api.rawg.io']) {
      expect(sent).not.toContain(hidden)
    }
    // Fresh for a day, and kept for one more.
    expect(options).toMatchObject({ ttl: 2 * 86_400 })
  })

  it('share every kind of answer that lives a day or longer and that no visitor typed', async () => {
    const vercel = platform()
    const { rawg, steam, cache } = await instance({ vercel, upstream: () => ({ ok: true }) })

    const asked: [
      string,
      Record<string, string | number> | undefined,
      { ttl: number } | undefined,
    ][] = [
      ['games/portal-2', undefined, undefined],
      ['games/portal-2/stores', undefined, undefined],
      ['games/portal-2/screenshots', undefined, undefined],
      ['games/3328/movies', undefined, undefined],
      ['genres', undefined, undefined],
      ['platforms', undefined, undefined],
      // The landing's lists: asked with a day's lifetime.
      ['games', { ordering: '-added', page_size: 40 }, { ttl: 86_400 }],
    ]
    for (const [path, params, options] of asked) {
      await behindTheLimiter(rawg(path, params, options))
    }
    await steam('620')
    await cache.set('steam-price:620', { price: null, fetchedAt: 'then' }, 3_600)
    await settle(vercel.kept)

    const DAY = 86_400
    expect(vercel.cache.set.mock.calls.map(([key, , options]) => [key, options?.ttl])).toEqual([
      [`gg-stay$v1.RAWG.${sha256('games/portal-2')}`, 8 * DAY],
      [`gg-stay$v1.RAWG.${sha256('games/portal-2/stores')}`, 8 * DAY],
      [`gg-stay$v1.RAWG.${sha256('games/portal-2/screenshots')}`, 8 * DAY],
      [`gg-stay$v1.RAWG.${sha256('games/3328/movies')}`, 2 * DAY],
      [`gg-stay$v1.RAWG.${sha256('genres')}`, 8 * DAY],
      [`gg-stay$v1.RAWG.${sha256('platforms')}`, 8 * DAY],
      [`gg-stay$v1.RAWG.${sha256('games?ordering=-added&page_size=40')}`, 2 * DAY],
      [`gg-stay$v1.STEAM.${sha256('620')}`, 2 * DAY],
      [`gg-stay$v1.STEAM_PRICE.${sha256('steam-price:620')}`, 3_600 + DAY],
    ])
    // Each was looked for there first, the price aside: it was only written here.
    expect(vercel.cache.get).toHaveBeenCalledTimes(8)
  })

  it('keep in memory alone what lives ten minutes and whatever a visitor typed', async () => {
    const vercel = platform()
    const { rawg, fetched } = await instance({ vercel, upstream: () => ({ ok: true }) })

    const asked: [string, Record<string, string | number>, { ttl: number } | undefined][] = [
      // A catalog page, the header's suggestions, the developer filter's autocomplete…
      ['games', { genres: 'rpg', page: 2 }, undefined],
      ['games', { search: 'half life', page_size: 5 }, undefined],
      ['developers', { search: 'va', page_size: 10 }, undefined],
      // …and a search however long its answer is kept.
      ['games', { search: 'portal' }, { ttl: 86_400 }],
    ]
    for (const [path, params, options] of asked) {
      await behindTheLimiter(rawg(path, params, options))
    }
    await settle(vercel.kept)

    expect(vercel.cache.get).not.toHaveBeenCalled()
    expect(vercel.cache.set).not.toHaveBeenCalled()
    expect(vercel.waitUntil).not.toHaveBeenCalled()

    // Memory keeps them for the instance, exactly as it did before there was a second level.
    for (const [path, params, options] of asked) await rawg(path, params, options)
    expect(fetched).toHaveLength(4)
  })

  it('share Steam’s page about an app, and the live price of a game page', async () => {
    const vercel = platform()
    const first = await instance({ vercel, upstream: () => 'first' })

    await first.steam('620')
    await first.cache.set('steam-price:620', { price: null, fetchedAt: 'then' }, 3_600)
    await settle(vercel.kept)

    expect(vercel.cache.set.mock.calls.map(([key, , options]) => [key, options?.ttl])).toEqual([
      // A day fresh and never served stale: kept for that day and one more.
      [`gg-stay$v1.STEAM.${sha256('620')}`, 2 * 86_400],
      [`gg-stay$v1.STEAM_PRICE.${sha256('steam-price:620')}`, 3_600 + 86_400],
    ])

    const second = await instance({ vercel })
    expect(await second.steam('620')).toEqual(steamPage('"first"'))
    expect(await second.cache.get('steam-price:620')).toEqual({ price: null, fetchedAt: 'then' })
    expect(second.fetched).toEqual([])
    // And a price is never served past its hour, whoever still holds it.
    vi.setSystemTime(START + 3_600_000)
    const third = await instance({ vercel })
    expect(await third.cache.get('steam-price:620')).toBeNull()
  })

  it('keep a catalog page the index answered in memory alone', async () => {
    const vercel = platform()
    const { cache } = await instance({ vercel })

    await cache.set('index-page:{"genres":["rpg"]}', { games: [1] }, 600)
    expect(await cache.get('index-page:{"genres":["rpg"]}')).toEqual({ games: [1] })
    expect(await cache.get('index-page:other')).toBeNull()
    await settle(vercel.kept)

    expect(vercel.cache.get).not.toHaveBeenCalled()
    expect(vercel.cache.set).not.toHaveBeenCalled()
  })

  it('serve a game past its day at once, from another instance’s copy, and refresh it behind the answer', async () => {
    const vercel = platform()
    const first = await instance({ vercel, upstream: () => ({ version: 1 }) })
    await first.rawg('games/portal-2')
    await settle(vercel.kept)

    vi.setSystemTime(START + 2 * DAY_MS)
    const second = await instance({ vercel, upstream: () => ({ version: 2 }) })
    expect(await second.rawg('games/portal-2')).toEqual({ version: 1 })

    // The refresh went to the platform to be kept alive, and brings back what is served next.
    await settle(vercel.kept)
    expect(second.fetched).toHaveLength(1)
    expect(await second.rawg('games/portal-2')).toEqual({ version: 2 })
    expect(second.fetched).toHaveLength(1)
  })

  it('ask Steam again for its page about an app past its day, and wait: an old trailer link may not play', async () => {
    const vercel = platform()
    const first = await instance({ vercel, upstream: () => ({ version: 1 }) })
    await first.steam('620')
    await settle(vercel.kept)
    const kept = vercel.waitUntil.mock.calls.length

    // Inside its day another instance is spared the request, as for any shared answer…
    vi.setSystemTime(START + DAY_MS - 1)
    const second = await instance({ vercel, upstream: () => ({ version: 2 }) })
    expect(await second.steam('620')).toEqual(steamPage('{"version":1}'))
    expect(second.fetched).toEqual([])

    // …and past it nobody is handed the old page, though the shared cache still holds it.
    vi.setSystemTime(START + DAY_MS)
    const third = await instance({ vercel, upstream: () => ({ version: 3 }) })
    expect(await third.steam('620')).toEqual(steamPage('{"version":3}'))
    expect(third.fetched).toHaveLength(1)
    await settle(vercel.kept)
    // Nothing was left running behind the answer but the write of what Steam just gave.
    expect(vercel.waitUntil).toHaveBeenCalledTimes(kept + 1)
  })

  it('answer from RAWG, and leave the shared cache alone, when the platform’s cache fails', async () => {
    const vercel = platform()
    vercel.cache.get.mockRejectedValue(new Error('the cache is down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { rawg, steam, cache } = await instance({ vercel, upstream: () => ({ ok: true }) })

    expect(await rawg('games/portal-2')).toEqual({ ok: true })
    expect(await behindTheLimiter(rawg('games/portal-2/stores'))).toEqual({ ok: true })
    expect(await steam('620')).toEqual(steamPage('{"ok":true}'))
    expect(await cache.get('steam-price:620')).toBeNull()
    await settle(vercel.kept)

    // One read found it down; no other read and no write was sent after it.
    expect(vercel.cache.get).toHaveBeenCalledTimes(1)
    expect(vercel.cache.set).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[shared-cache] a read failed (Error: the cache is down); left alone for 30 s',
    )
  })
  it('go on reading, and say so once, when the platform refuses writes', async () => {
    const vercel = platform()
    // Another instance's entry is there to be read; this instance's own writes are refused.
    const earlier = await instance({ vercel, upstream: () => ({ version: 1 }) })
    await earlier.rawg('games/portal-2')
    await settle(vercel.kept)
    vercel.cache.set.mockRejectedValue(new Error('quota exceeded'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { rawg, steam, cache } = await instance({ vercel, upstream: () => ({ version: 2 }) })
    expect(await rawg('games/half-life')).toEqual({ version: 2 })
    expect(await steam('620')).toEqual(steamPage('{"version":2}'))
    await cache.set('steam-price:620', { price: null }, 3_600)
    await settle(vercel.kept)

    // Three writes were refused, and one line says so.
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[shared-cache] a write failed (Error: quota exceeded); reads go on, not reported again for 30 s',
    )
    // Reads were never paused: what the other instance left is still found.
    expect(await rawg('games/portal-2')).toEqual({ version: 1 })
  })
})

describe('the caches anywhere else', () => {
  it.each([
    ['off Vercel', { vercel: false, fixtures: false }],
    ['in fixture mode on Vercel', { vercel: true, fixtures: true }],
    ['in fixture mode off Vercel', { vercel: false, fixtures: true }],
  ])('have no shared level %s: the platform is asked nothing', async (_where, where) => {
    // A request context is there in every case, so that only the decision keeps the cache out.
    const there = platform()
    const made = await instance({
      vercel: where.vercel ? there : null,
      fixtures: where.fixtures,
      upstream: () => ({ ok: true }),
    })
    vi.stubGlobal(REQUEST_CONTEXT as unknown as string, {
      get: () => ({ cache: there.cache, waitUntil: there.waitUntil }),
    })

    await made.rawg('games/portal-2')
    await behindTheLimiter(made.rawg('games', { page: 2 }))
    await made.steam('620')
    await made.cache.set('steam-price:620', { price: null }, 3_600)
    expect(await made.cache.get('steam-price:620')).toEqual({ price: null })
    await made.cache.get('steam-price:440')
    await settle()

    expect(there.cache.get).not.toHaveBeenCalled()
    expect(there.cache.set).not.toHaveBeenCalled()
    expect(there.waitUntil).not.toHaveBeenCalled()
    expect(made.fetched).toHaveLength(where.fixtures ? 0 : 3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('have no stale window off Vercel: a game past its day is asked for again, and waited for', async () => {
    let version = 1
    const { rawg, steam, fetched } = await instance({
      vercel: null,
      upstream: () => ({ version: version++ }),
    })
    await rawg('games/portal-2')
    await steam('620')

    vi.setSystemTime(START + DAY_MS)
    expect(await rawg('games/portal-2')).toEqual({ version: 3 })
    expect(await steam('620')).toEqual(steamPage('{"version":4}'))
    expect(fetched).toHaveLength(4)
  })

  it('answer from memory exactly as before: the entry is fresh for its ttl and expired after it', async () => {
    let version = 1
    const { rawg, fetched } = await instance({
      vercel: null,
      upstream: () => ({ version: version++ }),
    })

    await rawg('games', { page: 1 })
    vi.setSystemTime(START + 600_000 - 1)
    expect(await rawg('games', { page: 1 })).toEqual({ version: 1 })
    vi.setSystemTime(START + 600_000)
    expect(await rawg('games', { page: 1 })).toEqual({ version: 2 })
    expect(fetched).toHaveLength(2)
  })
})
