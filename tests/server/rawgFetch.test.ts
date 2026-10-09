import { describe, expect, it, vi } from 'vitest'
import {
  createRawgFetch,
  fixtureName,
  normalizeKey,
  staleFor,
  ttlFor,
  UpstreamError,
  type CacheEntry,
  type RawgDeps,
} from '../../server/rawg/rawgFetch'

function makeDeps(overrides: Partial<RawgDeps> = {}) {
  const store = new Map<string, CacheEntry>()
  let clock = 1_000_000
  const deps: RawgDeps = {
    apiKey: 'test-key',
    fixtures: false,
    fetchJson: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    readFixture: vi.fn(async () => null),
    cache: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, entry) => void store.set(key, entry),
    },
    now: () => clock,
    sleep: vi.fn(async (ms: number) => void (clock += ms)),
    ...overrides,
  }
  return { deps, store, advance: (ms: number) => void (clock += ms) }
}

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })

describe('helpers', () => {
  it('normalizes keys: sorted params, empty values dropped, no api key', () => {
    expect(normalizeKey('games', { page: 1, genres: 'rpg', search: undefined, tags: '' })).toBe(
      'games?genres=rpg&page=1',
    )
    expect(normalizeKey('genres')).toBe('genres')
  })

  it('picks ttl by resource', () => {
    expect(ttlFor('games')).toBe(600)
    expect(ttlFor('games/portal-2')).toBe(86_400)
    expect(ttlFor('games/portal-2/stores')).toBe(86_400)
    expect(ttlFor('genres')).toBe(604_800)
    expect(ttlFor('developers')).toBe(604_800)
  })

  it('gives a week’s stale window to what a game page is made of, and none to anything else', () => {
    expect(staleFor('games/portal-2')).toBe(604_800)
    expect(staleFor('games/portal-2/stores')).toBe(604_800)
    expect(staleFor('games/portal-2/screenshots')).toBe(604_800)
    // Lists, the taxonomies, and a game's other sub-paths keep the lifetimes they had.
    expect(staleFor('games')).toBe(0)
    expect(staleFor('genres')).toBe(0)
    expect(staleFor('platforms')).toBe(0)
    expect(staleFor('developers')).toBe(0)
    expect(staleFor('games/3328/movies')).toBe(0)
    expect(staleFor('games/portal-2/stores/steam')).toBe(0)
    expect(staleFor('games/')).toBe(0)
    expect(staleFor('genres/action')).toBe(0)
  })

  it('maps paths to fixture names', () => {
    expect(fixtureName('games')).toBe('games')
    expect(fixtureName('games/portal-2')).toBe('game-portal-2')
    expect(fixtureName('games/portal-2/stores')).toBe('game-portal-2-stores')
    expect(fixtureName('genres')).toBe('genres')
  })

  it('gives a whole calendar year of games its own fixture, whatever the year', () => {
    // The "best of this year" shelf, and the catalog page its link opens.
    expect(fixtureName('games', { ordering: '-added', dates: '2026-01-01,2026-12-31' })).toBe(
      'games-calendar-year',
    )
    expect(fixtureName('games', { dates: '2031-01-01,2031-12-31', page: 2 })).toBe(
      'games-calendar-year',
    )
    // Any other window, or a window across years, is the ordinary list.
    expect(fixtureName('games', { dates: '2015-01-01,2020-12-31' })).toBe('games')
    expect(fixtureName('games', { dates: '2026-09-19,2099-12-31' })).toBe('games')
    expect(fixtureName('games', {})).toBe('games')
    expect(fixtureName('games/portal-2', { dates: '2026-01-01,2026-12-31' })).toBe('game-portal-2')
  })
})

describe('createRawgFetch', () => {
  it('adds the api key to the url and returns the body', async () => {
    const { deps } = makeDeps()
    const result = await createRawgFetch(deps)('games', { genres: 'rpg' })
    expect(result).toEqual({ ok: true })
    const url = new URL(vi.mocked(deps.fetchJson).mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://api.rawg.io/api/games')
    expect(url.searchParams.get('key')).toBe('test-key')
    expect(url.searchParams.get('genres')).toBe('rpg')
  })

  it('serves a fresh cache entry without fetching', async () => {
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    await rawg('games', { page: 1 })
    await rawg('games', { page: 1 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('tells a caller that asked to know when the cache answered, and only then', async () => {
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    const onCached = vi.fn()

    // RAWG is asked the first time; the second answer was already here.
    await rawg('games', { page: 1 }, { onCached })
    expect(onCached).not.toHaveBeenCalled()
    expect(await rawg('games', { page: 1 }, { onCached })).toEqual({ ok: true })
    expect(onCached).toHaveBeenCalledTimes(1)
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('shares one request and one cache entry between a call that asks to know and one that does not', async () => {
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    await Promise.all([rawg('games', { page: 1 }), rawg('games', { page: 1 }, { onCached() {} })])
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
    await rawg('games', { page: 1 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('refetches after the ttl expires', async () => {
    const { deps, advance } = makeDeps()
    const rawg = createRawgFetch(deps)
    await rawg('games')
    advance(601_000)
    await rawg('games')
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
  })

  it('retries once on 5xx and succeeds', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 502, body: null })
      .mockResolvedValueOnce({ status: 200, body: { ok: 1 } })
    const { deps } = makeDeps({ fetchJson })
    expect(await createRawgFetch(deps)('games')).toEqual({ ok: 1 })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('re-reads the clock before throttling a retry, instead of reusing a stale one', async () => {
    const fetchJson = vi.fn()
    const { deps, advance } = makeDeps({ fetchJson })
    fetchJson
      .mockImplementationOnce(async () => {
        // Simulate a slow failed request: real time passes before we even
        // get to decide whether to retry.
        advance(2_000)
        return { status: 502, body: null }
      })
      .mockResolvedValueOnce({ status: 200, body: { ok: 1 } })

    expect(await createRawgFetch(deps)('games')).toEqual({ ok: 1 })
    expect(fetchJson).toHaveBeenCalledTimes(2)
    // The 250 ms slot has long since passed by the time of the retry, so the
    // retry must not sleep at all.
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('retries once on timeout, then throws TIMEOUT', async () => {
    const fetchJson = vi.fn().mockRejectedValue(timeoutError())
    const { deps } = makeDeps({ fetchJson })
    await expect(createRawgFetch(deps)('games')).rejects.toMatchObject({ kind: 'TIMEOUT' })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('makes a single, shorter attempt when the caller asks for one', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchJson = vi.fn().mockRejectedValue(timeoutError())
    const { deps } = makeDeps({ fetchJson })
    await expect(
      createRawgFetch(deps)('games', { search: 'x' }, { timeoutMs: 4_000, maxAttempts: 1 }),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' })
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(4_000)
    timeout.mockRestore()
  })

  it('does not retry on 429', async () => {
    const fetchJson = vi.fn().mockResolvedValue({ status: 429, body: null })
    const { deps } = makeDeps({ fetchJson })
    await expect(createRawgFetch(deps)('games')).rejects.toMatchObject({ kind: 'RATE_LIMITED' })
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('maps 404 to NOT_FOUND and 5xx to ERROR', async () => {
    const notFound = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ status: 404, body: null }) })
    await expect(createRawgFetch(notFound.deps)('games/nope')).rejects.toBeInstanceOf(UpstreamError)
    await expect(createRawgFetch(notFound.deps)('games/nope')).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    })
    const broken = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ status: 500, body: null }) })
    await expect(createRawgFetch(broken.deps)('games')).rejects.toMatchObject({ kind: 'ERROR' })
  })

  it('serves a stale entry when the upstream fails', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { v: 1 } })
      .mockResolvedValue({ status: 500, body: null })
    const { deps, advance } = makeDeps({ fetchJson })
    const rawg = createRawgFetch(deps)
    await rawg('games')
    advance(601_000)
    expect(await rawg('games')).toEqual({ v: 1 })
  })

  it('never serves stale data for NOT_FOUND', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { v: 1 } })
      .mockResolvedValue({ status: 404, body: null })
    const { deps, advance } = makeDeps({ fetchJson })
    const rawg = createRawgFetch(deps)
    await rawg('games/x')
    advance(86_401_000)
    await expect(rawg('games/x')).rejects.toMatchObject({ kind: 'NOT_FOUND' })
  })

  it('spaces requests 250 ms apart (4 rps)', async () => {
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    await Promise.all([
      rawg('games', { page: 1 }),
      rawg('games', { page: 2 }),
      rawg('games', { page: 3 }),
    ])
    const waits = vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)
    expect(waits).toEqual([250, 500])
  })

  it('sends one request for two calls for the same list made at the same time', async () => {
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    // The same key however the params are ordered, and whatever empty ones ride along.
    const [first, second] = await Promise.all([
      rawg('games', { genres: 'rpg', page: 1 }),
      rawg('games', { page: 1, search: '', genres: 'rpg' }),
    ])
    expect(first).toEqual({ ok: true })
    expect(second).toBe(first)
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('shares a request between calls that differ only in how long they would cache it', async () => {
    // The landing keeps a list for a day and the catalog for ten minutes. Asked for at the same
    // moment it is one request, cached for as long as the call that started it asked.
    const { deps, store } = makeDeps()
    const rawg = createRawgFetch(deps)
    await Promise.all([rawg('games', { page: 1 }, { ttl: 86_400 }), rawg('games', { page: 1 })])
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
    expect(store.get('games?page=1')?.expiresAt).toBe(1_000_000 + 86_400_000)
  })

  it('keeps a call with tighter limits out of a request made with the defaults', async () => {
    // What `/api/ask` asks for: its single short attempt must not sit through the two long ones
    // a catalog page is prepared to wait for, nor the other way round.
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { deps } = makeDeps()
    const rawg = createRawgFetch(deps)
    await Promise.all([
      rawg('games', { search: 'x' }),
      rawg('games', { search: 'x' }, { timeoutMs: 4_000, maxAttempts: 1 }),
    ])
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([5_000, 4_000])
    timeout.mockRestore()
  })

  it('writes a line about a failed attempt that carries no URL, no query and no API key', async () => {
    const log = vi.fn<(line: string) => void>()
    const fetchJson = vi.fn().mockResolvedValue({ status: 500, body: null })
    const { deps } = makeDeps({ fetchJson, log })
    await expect(
      createRawgFetch(deps)('games', { search: 'half life', page: 2 }, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ kind: 'ERROR' })

    // The request itself carried all three...
    const url = fetchJson.mock.calls[0]![0] as string
    expect(url).toContain('https://api.rawg.io/api/games?')
    expect(url).toContain('search=half+life')
    expect(url).toContain('key=test-key')
    // ...and the line about it names the path, and nothing else of it.
    expect(log.mock.calls).toEqual([['[upstream] RAWG games attempt 1: 0 ms, ERROR (500)']])
    for (const hidden of ['test-key', 'key=', 'api.rawg.io', 'https', 'search', 'half', 'page']) {
      expect(log.mock.calls[0]![0]).not.toContain(hidden)
    }
  })

  it('names the game a failed attempt was about, by its path', async () => {
    const log = vi.fn<(line: string) => void>()
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 502, body: null })
      .mockResolvedValueOnce({ status: 200, body: { results: [] } })
    const { deps } = makeDeps({ fetchJson, log })
    await createRawgFetch(deps)('games/portal-2/stores')
    expect(log.mock.calls).toEqual([
      ['[upstream] RAWG games/portal-2/stores attempt 1: 0 ms, ERROR (502)'],
    ])
  })

  it('reads fixtures instead of fetching when fixture mode is on', async () => {
    const readFixture = vi.fn(async (name: string) => (name === 'genres' ? { results: [] } : null))
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const rawg = createRawgFetch(deps)
    expect(await rawg('genres')).toEqual({ results: [] })
    await expect(rawg('games/unknown')).rejects.toMatchObject({ kind: 'NOT_FOUND' })
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })

  it('caches an entry for the ttl override instead of the path default', async () => {
    const { deps, advance } = makeDeps()
    const rawg = createRawgFetch(deps)
    await rawg('games', { page: 1 }, { ttl: 86_400 })
    advance(601_000) // past the default 600s ttl for "games"
    await rawg('games', { page: 1 }, { ttl: 86_400 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
    advance(86_400_000) // past the 86400s override, from the first call
    await rawg('games', { page: 1 }, { ttl: 86_400 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
  })

  it('serves a stale entry past a ttl override when the upstream then fails', async () => {
    // A short per-call ttl override still leaves the fetched value in the cache as a
    // stale-if-error fallback — expiring sooner (per the override) doesn't mean the entry
    // stops being usable once the upstream starts failing.
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { v: 1 } })
      .mockResolvedValue({ status: 500, body: null })
    const { deps, advance } = makeDeps({ fetchJson })
    const rawg = createRawgFetch(deps)
    await rawg('games', { page: 1 }, { ttl: 30 })
    advance(31_000) // past the 30s override
    expect(await rawg('games', { page: 1 }, { ttl: 30 })).toEqual({ v: 1 })
    // 1 (initial fetch) + 2 (the second call's own 5xx retry, per "retries once on 5xx") before
    // falling back to the stale cache entry.
    expect(fetchJson).toHaveBeenCalledTimes(3)
  })

  describe('a body that is not a JSON object', () => {
    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'Service Unavailable'],
    ])(
      'hands %s back once and never caches it, so the next call asks RAWG again',
      async (_name, body) => {
        const fetchJson = vi
          .fn()
          .mockResolvedValueOnce({ status: 200, body })
          .mockResolvedValueOnce({ status: 200, body: { results: [{ id: 1 }] } })
        const { deps, store } = makeDeps({ fetchJson })
        const rawg = createRawgFetch(deps)

        expect(await rawg('games', { page: 2 })).toEqual(body)
        expect(store.size).toBe(0)
        expect(await rawg('games', { page: 2 })).toEqual({ results: [{ id: 1 }] })
        expect(fetchJson).toHaveBeenCalledTimes(2)
      },
    )

    it('never serves one from the cache or as a stale fallback', async () => {
      const fetchJson = vi.fn().mockResolvedValue({ status: 500, body: null })
      const { deps, store } = makeDeps({ fetchJson })
      // Written by a build that still cached empty bodies.
      store.set('games?page=2', { value: null, expiresAt: Number.MAX_SAFE_INTEGER })
      const rawg = createRawgFetch(deps)

      await expect(rawg('games', { page: 2 })).rejects.toMatchObject({ kind: 'ERROR' })
      expect(fetchJson).toHaveBeenCalled()
    })
  })
})

describe('the stale window of a RAWG answer', () => {
  const DAY_MS = 86_400_000

  /** RAWG answering `{ version: 1 }` first and `{ version: 2 }` ever after. */
  function versions() {
    return vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { version: 1 } })
      .mockResolvedValue({ status: 200, body: { version: 2 } })
  }

  /** Lets a refresh nobody waited for run to its end. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  it.each(['games/portal-2', 'games/portal-2/stores', 'games/portal-2/screenshots'])(
    'hands %s over past its day while RAWG is asked again, and for a week',
    async (path) => {
      const keepAlive = vi.fn()
      const { deps, advance } = makeDeps({ fetchJson: versions(), keepAlive })
      const rawg = createRawgFetch(deps)
      await rawg(path)

      advance(DAY_MS)
      expect(await rawg(path)).toEqual({ version: 1 })
      expect(keepAlive).toHaveBeenCalledTimes(1)
      await settle()
      expect(deps.fetchJson).toHaveBeenCalledTimes(2)
      // What the refresh brought back is fresh for a day, and stale for the rest of its own week.
      expect(await rawg(path)).toEqual({ version: 2 })
      advance(7 * DAY_MS - 1)
      expect(await rawg(path)).toEqual({ version: 2 })
      await settle()
      expect(deps.fetchJson).toHaveBeenCalledTimes(3)

      // A week after it was stored the entry is expired: RAWG is asked, and waited for.
      const fetchJson = vi.fn().mockResolvedValue({ status: 200, body: { version: 9 } })
      const late = makeDeps({ fetchJson, keepAlive: vi.fn() })
      late.store.set(path, { value: { version: 1 }, expiresAt: 1_000_000, storedAt: 1_000_000 })
      late.advance(7 * DAY_MS)
      expect(await createRawgFetch(late.deps)(path)).toEqual({ version: 9 })
    },
  )

  it.each([
    ['a list', 'games', 600_000, undefined],
    ['a list the landing keeps for a day', 'games', DAY_MS, { ttl: 86_400 }],
    ['a taxonomy', 'genres', 7 * DAY_MS, undefined],
    ['a game’s clips', 'games/3328/movies', DAY_MS, undefined],
  ])(
    'lets %s expire as it always has: past its ttl the caller waits for RAWG',
    async (_what, path, ttlMs, options) => {
      const keepAlive = vi.fn()
      const { deps, advance } = makeDeps({ fetchJson: versions(), keepAlive })
      const rawg = createRawgFetch(deps)
      await rawg(path, undefined, options)

      advance(ttlMs - 1)
      expect(await rawg(path, undefined, options)).toEqual({ version: 1 })
      expect(deps.fetchJson).toHaveBeenCalledTimes(1)
      advance(1)
      expect(await rawg(path, undefined, options)).toEqual({ version: 2 })
      expect(keepAlive).not.toHaveBeenCalled()
    },
  )

  it('is off without a keep-alive: a game past its day is asked for again, and waited for', async () => {
    // The refresh job's transport, and every transport off the platform.
    const { deps, advance } = makeDeps({ fetchJson: versions() })
    const rawg = createRawgFetch(deps)
    await rawg('games/portal-2')

    advance(DAY_MS)
    expect(await rawg('games/portal-2')).toEqual({ version: 2 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('a RAWG call that asks what its read of the cache came to', () => {
  it('is told when the read went to the cache every instance shares, and what it found', async () => {
    const { deps, store } = makeDeps()
    store.set('games/portal-2', { value: { id: 4200 }, expiresAt: 2_000_000, storedAt: 900_000 })
    deps.cache.get = async (key, onSharedRead) => {
      onSharedRead?.({ ms: 11, hit: true })
      return store.get(key) ?? null
    }
    const onSharedRead = vi.fn()

    await createRawgFetch(deps)('games/portal-2', undefined, { onSharedRead })

    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 11, hit: true })
  })
})
