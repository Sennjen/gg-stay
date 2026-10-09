import { describe, expect, it } from 'vitest'
import { parseSteamPrice, readSteamPrice } from '../../../server/steam/price'
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

describe('readSteamPrice', () => {
  const batch = pricesBatch as Record<string, unknown>

  it.each([
    ['292030', 'a full-price game'],
    ['413150', 'a discounted game'],
    ['570', 'a free game'],
    ['12345', 'a price that needs rounding'],
  ])('reads the entry of %s as its price (%s)', (appId, _what) => {
    const price = parseSteamPrice(batch[appId])
    expect(price).not.toBeNull()
    expect(readSteamPrice(batch[appId])).toEqual({ kind: 'price', price })
  })

  it.each([
    [{ success: false }, 'an app Steam will not describe to this region'],
    [
      {
        success: false,
        data: {
          price_overview: { currency: 'UAH', initial: 100, final: 100, discount_percent: 0 },
        },
      },
      'a refusal, whatever rides along with it',
    ],
    [{ success: true, data: [] }, 'the empty list of a free or not-for-sale app'],
    [{ success: true, data: {} }, 'data with no price overview'],
    [{ success: true, data: { is_free: false } }, 'a paid app with no price overview'],
  ])('reads %j as Steam having no price (%s)', (entry, _what) => {
    expect(readSteamPrice(entry)).toEqual({ kind: 'none' })
  })

  it.each([
    [undefined, 'no entry at all'],
    [null, 'a null entry'],
    ['<html>Service Unavailable</html>', 'a string where an entry should be'],
    [42, 'a number where an entry should be'],
    [[], 'a list where an entry should be'],
    [{}, 'an entry that says neither success nor failure'],
    [{ success: 'false' }, 'a success that is not a boolean'],
    [{ data: [] }, 'an empty list with no word on success'],
    [{ success: true }, 'success with no data at all'],
    [{ success: true, data: null }, 'success over null data'],
    [{ success: true, data: 'not an object' }, 'a malformed data field'],
    [{ success: true, data: { price_overview: null } }, 'a price overview of null'],
    [{ success: true, data: { price_overview: 'not an object' } }, 'a malformed price overview'],
    [
      { success: true, data: { price_overview: { currency: 'UAH', initial: 100 } } },
      'a price overview missing its amounts',
    ],
    [
      {
        success: true,
        data: {
          price_overview: { currency: 'USD', initial: 1999, final: 1999, discount_percent: 0 },
        },
      },
      'a price in a currency that is not hryvnia',
    ],
  ])('reads %j as unreadable, not as "no price" (%s)', (entry, _what) => {
    expect(readSteamPrice(entry)).toEqual({ kind: 'unreadable' })
    // What the batched reader reports for the same entry, and why it cannot be the one to ask.
    expect(parseSteamPrice(entry)).toBeNull()
  })

  it('reads the recorded non-hryvnia entry as unreadable too', () => {
    expect(readSteamPrice(batch['620'])).toEqual({ kind: 'unreadable' })
  })
})
