import { describe, expect, it, vi } from 'vitest'
import {
  createSteamFetch,
  fixtureName,
  type SteamCacheEntry,
  type SteamDeps,
} from '../../server/steam/steamFetch'
import { UpstreamError } from '../../server/upstream/errors'

function makeDeps(overrides: Partial<SteamDeps> = {}) {
  const store = new Map<string, SteamCacheEntry>()
  let clock = 1_000_000
  const deps: SteamDeps = {
    fixtures: false,
    fetchJson: vi.fn(async () => ({ status: 200, body: { '292030': { success: true } } })),
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
  it('maps app ids to fixture names', () => {
    expect(fixtureName('292030')).toBe('appdetails-292030')
  })
})

describe('createSteamFetch', () => {
  it('requests appdetails with the fixed cc/l params and no filters, so text fields are present', async () => {
    const { deps } = makeDeps()
    const result = await createSteamFetch(deps)('292030')
    expect(result).toEqual({ '292030': { success: true } })
    const url = new URL(vi.mocked(deps.fetchJson).mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://store.steampowered.com/api/appdetails')
    expect(url.searchParams.get('appids')).toBe('292030')
    expect(url.searchParams.get('cc')).toBe('ua')
    expect(url.searchParams.get('l')).toBe('ukrainian')
    expect(url.searchParams.has('filters')).toBe(false)
  })

  it('serves a fresh cache entry without fetching', async () => {
    const { deps } = makeDeps()
    const steam = createSteamFetch(deps)
    await steam('292030')
    await steam('292030')
    expect(deps.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('refetches after the ttl expires', async () => {
    const { deps, advance } = makeDeps()
    const steam = createSteamFetch(deps)
    await steam('292030')
    advance(86_401_000)
    await steam('292030')
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
  })

  it('retries once on 5xx and succeeds', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 502, body: null })
      .mockResolvedValueOnce({ status: 200, body: { '292030': { success: true, data: {} } } })
    const { deps } = makeDeps({ fetchJson })
    expect(await createSteamFetch(deps)('292030')).toEqual({
      '292030': { success: true, data: {} },
    })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('retries once on timeout, then throws TIMEOUT', async () => {
    const fetchJson = vi.fn().mockRejectedValue(timeoutError())
    const { deps } = makeDeps({ fetchJson })
    await expect(createSteamFetch(deps)('292030')).rejects.toMatchObject({ kind: 'TIMEOUT' })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 429', async () => {
    const fetchJson = vi.fn().mockResolvedValue({ status: 429, body: null })
    const { deps } = makeDeps({ fetchJson })
    await expect(createSteamFetch(deps)('292030')).rejects.toMatchObject({ kind: 'RATE_LIMITED' })
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('reports failures as Steam, not as RAWG', async () => {
    const { deps } = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ status: 500, body: null }) })
    await expect(createSteamFetch(deps)('292030')).rejects.toMatchObject({ source: 'STEAM' })
    await expect(createSteamFetch(deps)('292030')).rejects.toThrow(/^STEAM upstream failure/)
  })

  it('maps 404 to NOT_FOUND and 5xx to ERROR', async () => {
    const notFound = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ status: 404, body: null }) })
    await expect(createSteamFetch(notFound.deps)('999')).rejects.toBeInstanceOf(UpstreamError)
    await expect(createSteamFetch(notFound.deps)('999')).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    })
    const broken = makeDeps({ fetchJson: vi.fn().mockResolvedValue({ status: 500, body: null }) })
    await expect(createSteamFetch(broken.deps)('292030')).rejects.toMatchObject({ kind: 'ERROR' })
  })

  it('serves a stale entry when the upstream fails', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { '292030': { success: true } } })
      .mockResolvedValue({ status: 500, body: null })
    const { deps, advance } = makeDeps({ fetchJson })
    const steam = createSteamFetch(deps)
    await steam('292030')
    advance(86_401_000)
    expect(await steam('292030')).toEqual({ '292030': { success: true } })
  })

  it('never serves stale data for NOT_FOUND', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { '292030': { success: true } } })
      .mockResolvedValue({ status: 404, body: null })
    const { deps, advance } = makeDeps({ fetchJson })
    const steam = createSteamFetch(deps)
    await steam('292030')
    advance(86_401_000)
    await expect(steam('292030')).rejects.toMatchObject({ kind: 'NOT_FOUND' })
  })

  it('spaces requests 1.5s apart', async () => {
    const { deps } = makeDeps()
    const steam = createSteamFetch(deps)
    await Promise.all([steam('1'), steam('2'), steam('3')])
    const waits = vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)
    expect(waits).toEqual([1_500, 3_000])
  })

  it('reads fixtures instead of fetching when fixture mode is on', async () => {
    const readFixture = vi.fn(async (name: string) =>
      name === 'appdetails-292030' ? { '292030': { success: true } } : null,
    )
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const steam = createSteamFetch(deps)
    expect(await steam('292030')).toEqual({ '292030': { success: true } })
    await expect(steam('999')).rejects.toMatchObject({ kind: 'NOT_FOUND' })
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })

  it('caches an entry for the ttl override instead of the default', async () => {
    const { deps, advance } = makeDeps()
    const steam = createSteamFetch(deps)
    await steam('292030', { ttl: 60 })
    advance(61_000)
    await steam('292030', { ttl: 60 })
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
  })

  it('caches and returns only the projected fields, dropping the rest of a large payload', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        '292030': {
          success: true,
          data: {
            // A handful of the many fields the real payload carries that this app never reads.
            detailed_description: '<p>huge…</p>'.repeat(500),
            header_image: 'https://example.com/header.jpg',
            screenshots: Array.from({ length: 20 }, (_, i) => ({ id: i })),
            short_description: 'Короткий опис.',
            about_the_game: '<p>Про гру</p>',
            movies: [{ id: 1, name: 'Trailer', highlight: true, hls_h264: 'https://x/1.m3u8' }],
          },
        },
      },
    })
    const { deps, store } = makeDeps({ fetchJson })
    const result = await createSteamFetch(deps)('292030')

    const expected = {
      '292030': {
        success: true,
        data: {
          short_description: 'Короткий опис.',
          about_the_game: '<p>Про гру</p>',
          movies: [{ highlight: true, hls_h264: 'https://x/1.m3u8' }],
        },
      },
    }
    expect(result).toEqual(expected)
    // The cache entry itself holds the projected shape, not the full payload.
    expect(store.get('292030')?.value).toEqual(expected)
  })
})
