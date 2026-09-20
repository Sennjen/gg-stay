import { describe, expect, it, vi } from 'vitest'
import { createSteamPriceFetch, type SteamPriceFetchDeps } from '../../server/steam/steamPriceFetch'
import { UpstreamError } from '../../server/upstream/errors'
import type { SteamFetch } from '../../server/steam/steamFetch'
import realPricesFixture from '../fixtures/steam/prices.json'

function makeDeps(overrides: Partial<SteamPriceFetchDeps> = {}) {
  let clock = 1_000_000
  const deps: SteamPriceFetchDeps = {
    fixtures: false,
    fetchJson: vi.fn(async () => ({ status: 200, body: {} })),
    readFixture: vi.fn(async () => null),
    now: () => clock,
    sleep: vi.fn(async (ms: number) => void (clock += ms)),
    steamFetch: vi.fn<SteamFetch>(async () => ({})),
    ...overrides,
  }
  return { deps, advance: (ms: number) => void (clock += ms) }
}

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })

describe('fetchPrices', () => {
  it('requests appdetails with cc=ua and filters=price_overview', async () => {
    const { deps } = makeDeps({
      fetchJson: vi.fn(async () => ({
        status: 200,
        body: {
          '292030': {
            success: true,
            data: {
              price_overview: { currency: 'UAH', initial: 100, final: 100, discount_percent: 0 },
            },
          },
        },
      })),
    })
    await createSteamPriceFetch(deps).fetchPrices(['292030'])
    const url = new URL(vi.mocked(deps.fetchJson).mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://store.steampowered.com/api/appdetails')
    expect(url.searchParams.get('appids')).toBe('292030')
    expect(url.searchParams.get('cc')).toBe('ua')
    expect(url.searchParams.get('filters')).toBe('price_overview')
  })

  it('resolves a map with priced, free and absent entries', async () => {
    const { deps } = makeDeps({
      fetchJson: vi.fn(async () => ({
        status: 200,
        body: {
          '1': {
            success: true,
            data: {
              price_overview: { currency: 'UAH', initial: 100, final: 50, discount_percent: 50 },
            },
          },
          '2': { success: true, data: { is_free: true } },
          // '3' asked but absent from the response entirely.
        },
      })),
    })
    const result = await createSteamPriceFetch(deps).fetchPrices(['1', '2', '3'])
    expect(result.get('1')).toEqual({
      priceUah: 1,
      regularPriceUah: 1,
      discountPercent: 50,
      isFree: false,
    })
    expect(result.get('2')).toEqual({
      priceUah: 0,
      regularPriceUah: 0,
      discountPercent: 0,
      isFree: true,
    })
    expect(result.get('3')).toBeNull()
    expect(result.size).toBe(3)
  })

  it('chunks to at most 100 ids per request (250 ids -> 3 requests)', async () => {
    const fetchJson = vi.fn(async () => ({ status: 200, body: {} }))
    const { deps } = makeDeps({ fetchJson })
    const ids = Array.from({ length: 250 }, (_, i) => String(i))
    await createSteamPriceFetch(deps).fetchPrices(ids)
    expect(fetchJson).toHaveBeenCalledTimes(3)
    const sizes = fetchJson.mock.calls.map(
      ([url]) => new URL(url as string).searchParams.get('appids')!.split(',').length,
    )
    expect(sizes).toEqual([100, 100, 50])
  })

  it('de-duplicates ids before chunking', async () => {
    const fetchJson = vi.fn(async () => ({ status: 200, body: {} }))
    const { deps } = makeDeps({ fetchJson })
    const result = await createSteamPriceFetch(deps).fetchPrices(['1', '2', '1', '2', '1'])
    const url = new URL(fetchJson.mock.calls[0]![0] as string)
    expect(url.searchParams.get('appids')).toBe('1,2')
    expect(result.size).toBe(2)
  })

  it('spaces chunk requests minIntervalMs apart (the shared limiter)', async () => {
    const { deps } = makeDeps()
    const ids = Array.from({ length: 250 }, (_, i) => String(i))
    await createSteamPriceFetch(deps).fetchPrices(ids)
    const waits = vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)
    expect(waits).toEqual([1_500, 3_000])
  })

  it('retries once on 5xx and succeeds', async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 502, body: null })
      .mockResolvedValueOnce({ status: 200, body: { '1': { success: false } } })
    const { deps } = makeDeps({ fetchJson })
    const result = await createSteamPriceFetch(deps).fetchPrices(['1'])
    expect(result.get('1')).toBeNull()
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('retries once on timeout, then throws TIMEOUT', async () => {
    const fetchJson = vi.fn().mockRejectedValue(timeoutError())
    const { deps } = makeDeps({ fetchJson })
    await expect(createSteamPriceFetch(deps).fetchPrices(['1'])).rejects.toMatchObject({
      kind: 'TIMEOUT',
    })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('never caches: a second call re-fetches immediately, even with no clock advance', async () => {
    const fetchJson = vi.fn(async () => ({ status: 200, body: {} }))
    const { deps } = makeDeps({ fetchJson })
    const steamPrices = createSteamPriceFetch(deps)
    await steamPrices.fetchPrices(['1'])
    await steamPrices.fetchPrices(['1'])
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('reads the single "prices" fixture asset instead of fetching, in fixture mode', async () => {
    const readFixture = vi.fn(async (name: string) =>
      name === 'prices'
        ? { '292030': { success: false }, '413150': { success: true, data: {} } }
        : null,
    )
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const result = await createSteamPriceFetch(deps).fetchPrices(['292030', '413150', '999'])
    expect(readFixture).toHaveBeenCalledWith('prices')
    expect(result.get('292030')).toBeNull()
    expect(result.get('413150')).toBeNull()
    // '999' is asked but absent from the fixture map — same "asked but absent" null as live.
    expect(result.get('999')).toBeNull()
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })

  it('reads the fixture asset only once across several calls', async () => {
    const readFixture = vi.fn(async (name: string) => (name === 'prices' ? { '1': {} } : null))
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const steamPrices = createSteamPriceFetch(deps)
    await steamPrices.fetchPrices(['1'])
    await steamPrices.fetchPrices(['1'])
    expect(readFixture).toHaveBeenCalledTimes(1)
  })

  it('projects the real tests/fixtures/steam/prices.json asset (not a mock)', async () => {
    const readFixture = vi.fn(async (name: string) =>
      name === 'prices' ? realPricesFixture : null,
    )
    const { deps } = makeDeps({ fixtures: true, readFixture })
    // 292030 (The Witcher 3) and 413150 (Stardew Valley) are the same Steam app ids the RAWG
    // store-link fixtures point at (tests/fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json,
    // game-stardew-valley-stores.json) — a discounted game and a full-price game. 570 (Dota 2) is
    // the documented free/not-for-sale batched ambiguity (`data: []` -> null, see price.ts).
    // '99999999' stands in for an id the fixture map simply does not have.
    const result = await createSteamPriceFetch(deps).fetchPrices([
      '292030',
      '413150',
      '570',
      '99999999',
    ])
    expect(result.get('292030')).toEqual({
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      isFree: false,
    })
    expect(result.get('413150')).toEqual({
      priceUah: 449,
      regularPriceUah: 449,
      discountPercent: 0,
      isFree: false,
    })
    expect(result.get('570')).toBeNull()
    expect(result.get('99999999')).toBeNull()
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })
})

describe('fetchAppLanguages', () => {
  it('delegates to the injected per-app steamFetch for one unfiltered call', async () => {
    const steamFetch = vi.fn<SteamFetch>(async () => ({
      '292030': {
        success: true,
        data: {
          supported_languages: 'English, Українська<strong>*</strong>',
          price_overview: { currency: 'UAH', initial: 100, final: 100, discount_percent: 0 },
        },
      },
    }))
    const { deps } = makeDeps({ steamFetch })
    const result = await createSteamPriceFetch(deps).fetchAppLanguages('292030')
    expect(steamFetch).toHaveBeenCalledWith('292030')
    expect(result).toEqual({
      ukrainian: { text: true, audio: true },
      isFree: false,
      price: { priceUah: 1, regularPriceUah: 1, discountPercent: 0, isFree: false },
    })
  })

  it('reports isFree from data.is_free and a zeroed price to match', async () => {
    const steamFetch = vi.fn<SteamFetch>(async () => ({
      '570': { success: true, data: { is_free: true, supported_languages: 'Українська' } },
    }))
    const { deps } = makeDeps({ steamFetch })
    const result = await createSteamPriceFetch(deps).fetchAppLanguages('570')
    expect(result).toEqual({
      ukrainian: { text: true, audio: false },
      isFree: true,
      price: { priceUah: 0, regularPriceUah: 0, discountPercent: 0, isFree: true },
    })
  })

  it('returns falsy defaults when the app is missing from the response', async () => {
    const steamFetch = vi.fn<SteamFetch>(async () => ({}))
    const { deps } = makeDeps({ steamFetch })
    const result = await createSteamPriceFetch(deps).fetchAppLanguages('404404')
    expect(result).toEqual({ ukrainian: { text: false, audio: false }, isFree: false, price: null })
  })

  it('propagates a steamFetch failure (e.g. NOT_FOUND) unchanged', async () => {
    const steamFetch = vi.fn<SteamFetch>(async () => {
      throw new UpstreamError('STEAM', 'NOT_FOUND', 404)
    })
    const { deps } = makeDeps({ steamFetch })
    await expect(createSteamPriceFetch(deps).fetchAppLanguages('1')).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    })
  })
})
