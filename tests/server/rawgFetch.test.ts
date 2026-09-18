import { describe, expect, it, vi } from 'vitest'
import {
  createRawgFetch,
  fixtureName,
  normalizeKey,
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

  it('maps paths to fixture names', () => {
    expect(fixtureName('games')).toBe('games')
    expect(fixtureName('games/portal-2')).toBe('game-portal-2')
    expect(fixtureName('games/portal-2/stores')).toBe('game-portal-2-stores')
    expect(fixtureName('genres')).toBe('genres')
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

  it('reads fixtures instead of fetching when fixture mode is on', async () => {
    const readFixture = vi.fn(async (name: string) => (name === 'genres' ? { results: [] } : null))
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const rawg = createRawgFetch(deps)
    expect(await rawg('genres')).toEqual({ results: [] })
    await expect(rawg('games/unknown')).rejects.toMatchObject({ kind: 'NOT_FOUND' })
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })
})
