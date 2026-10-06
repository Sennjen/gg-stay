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

  it('shares a read that is already in flight, and still keeps nothing afterwards', async () => {
    const fetchJson = vi.fn(async () => ({
      status: 200,
      body: { '1': { success: true, data: { is_free: true } } },
    }))
    const { deps } = makeDeps({ fetchJson })
    const steamPrices = createSteamPriceFetch(deps)
    // Two readers of the same game page at the same moment are one request to Steam...
    const [first, second] = await Promise.all([
      steamPrices.fetchPrices(['1']),
      steamPrices.fetchPrices(['1']),
    ])
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(first.get('1')).toEqual(second.get('1'))
    // ...and the answer is gone the moment it has been given: the next reader asks again.
    await steamPrices.fetchPrices(['1'])
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('writes a line about a failed price read, naming the apps it asked about', async () => {
    const log = vi.fn<(line: string) => void>()
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, body: null })
      .mockResolvedValueOnce({ status: 200, body: {} })
    const { deps } = makeDeps({ fetchJson, log })
    const steamPrices = createSteamPriceFetch(deps)
    await expect(steamPrices.fetchPrices(['292030', '620'])).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    })
    expect(log.mock.calls).toEqual([
      ['[upstream] STEAM 292030,620 attempt 1: 0 ms, RATE_LIMITED (429)'],
    ])
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

describe('fetchPrice', () => {
  const UAH_100 = {
    success: true,
    data: {
      price_overview: { currency: 'UAH', initial: 10000, final: 5000, discount_percent: 50 },
    },
  }

  /** The transport over a Steam that answers every request with `body` under a 200. */
  function answering(body: unknown) {
    const fetchJson = vi.fn(async (_url: string) => ({ status: 200, body }))
    const { deps } = makeDeps({ fetchJson })
    return { steamPrices: createSteamPriceFetch(deps), fetchJson }
  }

  it('asks Steam for the one app, with cc=ua and the price filter, and gives its price', async () => {
    const { steamPrices, fetchJson } = answering({ '292030': UAH_100 })

    expect(await steamPrices.fetchPrice('292030')).toEqual({
      priceUah: 50,
      regularPriceUah: 100,
      discountPercent: 50,
      isFree: false,
    })
    const url = new URL(fetchJson.mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe('https://store.steampowered.com/api/appdetails')
    expect(url.searchParams.get('appids')).toBe('292030')
    expect(url.searchParams.get('cc')).toBe('ua')
    expect(url.searchParams.get('filters')).toBe('price_overview')
  })

  it.each([
    [{ '1': { success: false } }, 'an app Steam will not describe to this region'],
    [{ '1': { success: true, data: [] } }, 'a free or not-for-sale app under the price filter'],
    [{ '1': { success: true, data: {} } }, 'an app whose data carries no price'],
  ])('answers null when Steam says it has no price for the app: %j (%s)', async (body, _what) => {
    const { steamPrices, fetchJson } = answering(body)

    expect(await steamPrices.fetchPrice('1')).toBeNull()
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  /** What Steam can send under a 200 that is not its answer about app 1. */
  const NOT_AN_ANSWER: [body: unknown, what: string][] = [
    [null, 'an empty body'],
    [[], 'a list'],
    ['<html>Service Unavailable</html>', 'an error page'],
    [{}, 'an object with nothing in it'],
    [{ '2': UAH_100 }, 'an answer about another app only'],
    [{ '1': null }, 'an entry of null'],
    [{ '1': { success: true } }, 'success with no data'],
    [
      {
        '1': {
          success: true,
          data: {
            price_overview: { currency: 'USD', initial: 1999, final: 1999, discount_percent: 0 },
          },
        },
      },
      'a price that is not in hryvnia',
    ],
  ]

  it.each(NOT_AN_ANSWER)(
    'fails, as a read that failed, when the answer cannot be read: %j (%s)',
    async (body) => {
      const { steamPrices, fetchJson } = answering(body)

      const failure = await steamPrices.fetchPrice('1').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(UpstreamError)
      expect(failure).toMatchObject({ source: 'STEAM', kind: 'ERROR' })
      // A 200 is an answer to the transport: it is not asked for again, whatever was in it.
      expect(fetchJson).toHaveBeenCalledTimes(1)
    },
  )

  it.each(NOT_AN_ANSWER)(
    'leaves the batched read as it was for the same answer, which is "no price": %j (%s)',
    async (body) => {
      const { steamPrices } = answering(body)

      // The refresh job's reader: it does its own accounting of which answers were definitive.
      const prices = await steamPrices.fetchPrices(['1'])
      expect([...prices]).toEqual([['1', null]])
    },
  )

  it('fails as the transport fails, after its one retry, when Steam does not answer', async () => {
    const fetchJson = vi.fn().mockRejectedValue(timeoutError())
    const { deps } = makeDeps({ fetchJson })

    await expect(createSteamPriceFetch(deps).fetchPrice('1')).rejects.toMatchObject({
      kind: 'TIMEOUT',
    })
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing: the next read asks Steam again', async () => {
    const { steamPrices, fetchJson } = answering({ '1': UAH_100 })

    await steamPrices.fetchPrice('1')
    await steamPrices.fetchPrice('1')
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  it('is the same request as a batched read of that one app, so the two share it in flight', async () => {
    const { steamPrices, fetchJson } = answering({ '1': UAH_100 })

    const [one, batch] = await Promise.all([
      steamPrices.fetchPrice('1'),
      steamPrices.fetchPrices(['1']),
    ])
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(batch.get('1')).toEqual(one)
  })

  it('reads the recorded file in fixture mode, where an app it does not hold has no price', async () => {
    const readFixture = vi.fn(async (name: string) =>
      name === 'prices' ? realPricesFixture : null,
    )
    const { deps } = makeDeps({ fixtures: true, readFixture })
    const steamPrices = createSteamPriceFetch(deps)

    expect(await steamPrices.fetchPrice('292030')).toEqual({
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      isFree: false,
    })
    // Recorded with `data: []`: Steam's own "no price".
    expect(await steamPrices.fetchPrice('570')).toBeNull()
    // Not recorded at all: the file is the whole of Steam here, and there is nobody to ask again.
    expect(await steamPrices.fetchPrice('99999999')).toBeNull()
    expect(deps.fetchJson).not.toHaveBeenCalled()
    expect(readFixture).toHaveBeenCalledTimes(1)
  })

  it('still fails in fixture mode on a recorded entry that cannot be read', async () => {
    const readFixture = vi.fn(async () => ({ '1': 'not an entry' }))
    const { deps } = makeDeps({ fixtures: true, readFixture })

    await expect(createSteamPriceFetch(deps).fetchPrice('1')).rejects.toMatchObject({
      source: 'STEAM',
      kind: 'ERROR',
    })
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
