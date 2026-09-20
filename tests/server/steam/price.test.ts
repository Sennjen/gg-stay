import { describe, expect, it } from 'vitest'
import { parseSteamPrice } from '../../../server/steam/price'
import pricesBatch from '../../fixtures/steam/prices-batch.json'

describe('parseSteamPrice', () => {
  it.each([
    [
      '292030',
      { priceUah: 1349, regularPriceUah: 1349, discountPercent: 0, isFree: false },
      'a full-price game',
    ],
    [
      '413150',
      { priceUah: 112, regularPriceUah: 449, discountPercent: 75, isFree: false },
      'a discounted game',
    ],
    ['570', { priceUah: 0, regularPriceUah: 0, discountPercent: 0, isFree: true }, 'a free game'],
    ['999999', null, 'data: [] (free or not-for-sale, indistinguishable here)'],
    ['1000000', null, 'success: false'],
    ['620', null, 'a non-UAH currency, never converted'],
    [
      '12345',
      { priceUah: 12, regularPriceUah: 13, discountPercent: 2, isFree: false },
      'round half up (12.25 -> 12, 12.50 -> 13)',
    ],
  ])('parses %s -> %j (%s)', (appId, expected) => {
    const entry = (pricesBatch as Record<string, unknown>)[appId]
    expect(parseSteamPrice(entry)).toEqual(expected)
  })

  it.each([
    [undefined, 'undefined entry'],
    [null, 'null entry'],
    ['a string', 'a non-object entry'],
    [42, 'a number entry'],
    [{}, 'an entry with neither success nor data'],
    [{ success: true }, 'success: true with no data at all'],
    [{ success: true, data: 'not an object' }, 'a malformed data field'],
    [{ success: true, data: {} }, 'an empty data object (not for sale, unfiltered call)'],
    [{ success: true, data: { price_overview: 'not an object' } }, 'a malformed price_overview'],
    [
      { success: true, data: { price_overview: { currency: 'UAH', initial: 100 } } },
      'a price_overview missing final/discount_percent',
    ],
  ])('returns null for %j (%s)', (entry) => {
    expect(parseSteamPrice(entry)).toBeNull()
  })

  it('treats is_free as free regardless of an accompanying price_overview', () => {
    expect(
      parseSteamPrice({
        success: true,
        data: {
          is_free: true,
          price_overview: { currency: 'UAH', initial: 100, final: 100, discount_percent: 0 },
        },
      }),
    ).toEqual({ priceUah: 0, regularPriceUah: 0, discountPercent: 0, isFree: true })
  })

  it('ignores unrelated fields on the entry (the same shape carries movies/description too)', () => {
    expect(
      parseSteamPrice({
        success: true,
        data: {
          movies: [{ highlight: true, hls_h264: 'https://x/1.m3u8' }],
          supported_languages: 'English, Українська',
          price_overview: { currency: 'UAH', initial: 100, final: 100, discount_percent: 0 },
        },
      }),
    ).toEqual({ priceUah: 1, regularPriceUah: 1, discountPercent: 0, isFree: false })
  })
})
