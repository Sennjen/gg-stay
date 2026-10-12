import { describe, expect, it } from 'vitest'
import { RATE_KEPT_MS } from '../../../scripts/index/offers'
import type { IndexedExchangeRate, IndexedGame, IndexedOffer } from '../../../server/index/document'
import {
  APPROXIMATE_MARGIN_PERCENT,
  EXCHANGE_RATE_KEPT_MS,
  OFFER_FRESH_FOR_MS,
  cheapestRow,
  exchangeRateAt,
  freshOffers,
  hryvniaOf,
  isFreshOffer,
  listedOffers,
  markedCheapest,
  readableOffers,
  wholeHryvnia,
  type PricedRow,
} from '../../../server/index/offerRules'

/**
 * The site's own rules about the other stores' prices, each on its boundary. Time is a string the
 * case chooses: nothing here reads a clock, and nothing waits for one.
 */

const NOW = '2026-10-12T12:00:00.000Z'

/** `NOW` moved back by `ms`. */
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString()

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const gog = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'gog',
  amount: 899,
  regularAmount: 3999,
  currency: 'USD',
  discountPercent: 78,
  url: 'https://www.gog.com/en/game/the_witcher_3_wild_hunt',
  updatedAt: ago(6 * HOUR),
  ...overrides,
})

const microsoft = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'xbox-store',
  amount: 38_500,
  regularAmount: 38_500,
  currency: 'UAH',
  discountPercent: 0,
  url: 'https://www.microsoft.com/uk-ua/p/stardew-valley/c3d891z6tnqm',
  updatedAt: ago(6 * HOUR),
  ...overrides,
})

const RATE: IndexedExchangeRate = {
  currency: 'USD',
  uah: 44.9567,
  date: '2026-10-12',
  readAt: ago(6 * HOUR),
}

const game = (
  offers: unknown,
  stores: string[] = ['steam', 'gog', 'xbox-store'],
): Pick<IndexedGame, 'stores' | 'offers'> => ({ stores, offers: offers as IndexedOffer[] })

describe('the thirty-six hours an offer is a price for', () => {
  it('is thirty-six hours', () => {
    expect(OFFER_FRESH_FOR_MS).toBe(36 * HOUR)
  })

  it('counts an offer read thirty-six hours ago to the millisecond, and not one read before that', () => {
    expect(isFreshOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS) }, NOW)).toBe(true)
    expect(isFreshOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS + 1) }, NOW)).toBe(false)
  })

  it('counts an offer read a moment ago, and one a clock a little ahead of ours dated', () => {
    expect(isFreshOffer({ updatedAt: NOW }, NOW)).toBe(true)
    expect(isFreshOffer({ updatedAt: ago(-5_000) }, NOW)).toBe(true)
  })

  it.each([['not a date'], [''], [undefined], [null], [1_760_000_000_000]])(
    'does not count an offer dated %j: what cannot be dated is not shown as read just now',
    (updatedAt) => {
      expect(isFreshOffer({ updatedAt: updatedAt as unknown as string }, NOW)).toBe(false)
    },
  )

  it('counts nothing against a clock that cannot be read', () => {
    expect(isFreshOffer({ updatedAt: ago(HOUR) }, 'not a date')).toBe(false)
  })
})

describe('the seven days a rate is a rate for', () => {
  it('is the refresh job’s own seven days', () => {
    expect(EXCHANGE_RATE_KEPT_MS).toBe(7 * DAY)
    expect(EXCHANGE_RATE_KEPT_MS).toBe(RATE_KEPT_MS)
  })

  it('uses a rate read seven days ago to the millisecond, and not one read before that', () => {
    const kept = { ...RATE, readAt: ago(EXCHANGE_RATE_KEPT_MS) }
    expect(exchangeRateAt({ exchangeRate: kept }, NOW)).toBe(kept)
    const dropped = { ...RATE, readAt: ago(EXCHANGE_RATE_KEPT_MS + 1) }
    expect(exchangeRateAt({ exchangeRate: dropped }, NOW)).toBeNull()
  })

  it('has no rate without metadata, or with metadata written before the job read the bank', () => {
    expect(exchangeRateAt(null, NOW)).toBeNull()
    expect(exchangeRateAt(undefined, NOW)).toBeNull()
    expect(exchangeRateAt({}, NOW)).toBeNull()
  })

  it.each([
    ['read at a moment that cannot be read', { readAt: 'yesterday' }],
    ['with no read date at all', { readAt: undefined }],
    ['of another currency', { currency: 'EUR' }],
    ['of zero', { uah: 0 }],
    ['below zero', { uah: -44.9 }],
    ['that is not a number', { uah: Number.NaN }],
    ['that is a string', { uah: '44.9567' }],
    ['for a day that is not a day', { date: '12.10.2026' }],
    ['for no day', { date: undefined }],
  ])('has no rate in one %s', (_what, broken) => {
    const exchangeRate = { ...RATE, ...broken } as unknown as IndexedExchangeRate
    expect(exchangeRateAt({ exchangeRate }, NOW)).toBeNull()
  })

  it('has no rate against a clock that cannot be read', () => {
    expect(exchangeRateAt({ exchangeRate: RATE }, 'not a date')).toBeNull()
  })
})

describe('the offers a build can show', () => {
  it('are the document’s own, in its order', () => {
    const offers = [gog(), microsoft()]
    expect(readableOffers(game(offers))).toEqual(offers)
  })

  it('are none for a document without the field, as every document was before the job wrote it', () => {
    expect(readableOffers({})).toEqual([])
    expect(readableOffers(game(null))).toEqual([])
    expect(readableOffers(game('gog'))).toEqual([])
  })

  it('are one a store: a second offer for the same store is passed over', () => {
    const first = gog()
    expect(readableOffers(game([first, gog({ amount: 1 }), microsoft()]))).toEqual([
      first,
      microsoft(),
    ])
  })

  it.each([
    ['a store this build has never heard of', { store: 'epic-games' }],
    ['a currency this build cannot name', { currency: 'EUR' }],
    ['an amount that is not a number', { amount: '899' }],
    ['an amount with a fraction of a cent', { amount: 899.5 }],
    ['an amount below zero', { amount: -1 }],
    ['no amount', { amount: undefined }],
    ['a regular amount that is not a number', { regularAmount: null }],
    ['a regular amount below the current one', { regularAmount: 898 }],
    ['a discount that is not a whole percent', { discountPercent: 77.5 }],
    ['a discount past a hundred percent', { discountPercent: 101 }],
    ['a discount below zero', { discountPercent: -5 }],
    ['an address that is not a web address', { url: 'javascript:alert(1)' }],
    ['a relative address', { url: '/en/game/the_witcher_3_wild_hunt' }],
    ['no address', { url: undefined }],
  ])('pass over an offer with %s', (_what, broken) => {
    const offers = [{ ...gog(), ...broken }, microsoft()]
    expect(readableOffers(game(offers))).toEqual([microsoft()])
  })

  it.each([[null], ['gog'], [42], [undefined]])(
    'pass over %j where an offer should be',
    (notAnOffer) => {
      expect(readableOffers(game([notAnOffer, microsoft()]))).toEqual([microsoft()])
    },
  )

  it('keep an offer that is too old to be a price: it still names the store’s page', () => {
    const old = gog({ updatedAt: ago(3 * DAY) })
    expect(readableOffers(game([old]))).toEqual([old])
  })
})

describe('the offers of a page built from the document alone', () => {
  it('are for the stores RAWG lists the game on, and no other', () => {
    expect(listedOffers(game([gog(), microsoft()], ['steam', 'gog']))).toEqual([gog()])
    expect(listedOffers(game([gog(), microsoft()], ['steam']))).toEqual([])
  })

  it('are prices only while they are fresh', () => {
    const fresh = microsoft()
    const stale = gog({ updatedAt: ago(OFFER_FRESH_FOR_MS + 1) })
    expect(listedOffers(game([stale, fresh]))).toEqual([stale, fresh])
    expect(freshOffers(game([stale, fresh]), NOW)).toEqual([fresh])
  })

  it('hold no fresh offer for a store the game is not listed on', () => {
    expect(freshOffers(game([gog(), microsoft()], ['steam', 'xbox-store']), NOW)).toEqual([
      microsoft(),
    ])
  })
})

describe('what an offer comes to in hryvnia', () => {
  it('is the store’s own sum for a hryvnia price, with or without a rate', () => {
    expect(hryvniaOf(microsoft(), null)).toEqual({ uah: 385, approximate: false })
    expect(hryvniaOf(microsoft(), RATE)).toEqual({ uah: 385, approximate: false })
  })

  it('rounds kopecks to the nearest hryvnia', () => {
    expect(wholeHryvnia(50_820)).toBe(508)
    expect(wholeHryvnia(50_850)).toBe(509)
    expect(wholeHryvnia(50_849)).toBe(508)
    expect(hryvniaOf(microsoft({ amount: 50_820, regularAmount: 154_000 }), null)).toEqual({
      uah: 508,
      approximate: false,
    })
  })

  it('is an estimate at the bank’s rate for a dollar price: $8.99 is about 404 ₴', () => {
    // 8.99 × 44.9567 = 404.16
    expect(hryvniaOf(gog(), RATE)).toEqual({ uah: 404, approximate: true })
    // 29.99 × 44.9567 = 1 348.25
    expect(hryvniaOf(gog({ amount: 2999, regularAmount: 2999 }), RATE)).toEqual({
      uah: 1348,
      approximate: true,
    })
  })

  it('cannot be said for a dollar price without a rate', () => {
    expect(hryvniaOf(gog(), null)).toBeNull()
  })

  it('is an exact nothing for a free game, in either currency and without a rate', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    expect(hryvniaOf(gog(free), null)).toEqual({ uah: 0, approximate: false })
    expect(hryvniaOf(gog(free), RATE)).toEqual({ uah: 0, approximate: false })
    expect(hryvniaOf(microsoft(free), null)).toEqual({ uah: 0, approximate: false })
  })
})

describe('the cheapest row', () => {
  const exact = (store: string, uah: number): PricedRow => ({ store, uah, approximate: false })
  const estimate = (store: string, uah: number): PricedRow => ({ store, uah, approximate: true })
  const cheapest = (...rows: PricedRow[]): string | null => cheapestRow(rows)?.store ?? null

  it('is the margin of five percent', () => {
    expect(APPROXIMATE_MARGIN_PERCENT).toBe(5)
  })

  it('is nobody when there is nothing to be cheaper than', () => {
    expect(cheapest()).toBeNull()
    expect(cheapest(exact('steam', 675))).toBeNull()
    expect(cheapest(estimate('gog', 404))).toBeNull()
  })

  it('is the lower of two exact prices, whichever comes first', () => {
    expect(cheapest(exact('steam', 675), exact('xbox-store', 385))).toBe('xbox-store')
    expect(cheapest(exact('xbox-store', 385), exact('steam', 675))).toBe('xbox-store')
    expect(cheapest(exact('steam', 384), exact('xbox-store', 385))).toBe('steam')
  })

  it('is nobody when two rows share the lowest amount', () => {
    expect(cheapest(exact('steam', 385), exact('xbox-store', 385))).toBeNull()
    expect(cheapest(exact('steam', 404), estimate('gog', 404))).toBeNull()
    expect(cheapest(exact('steam', 0), exact('xbox-store', 0))).toBeNull()
  })

  it('is still the one below a tie further up', () => {
    expect(cheapest(exact('steam', 675), exact('xbox-store', 675), exact('gog', 0))).toBe('gog')
  })

  it('is an estimate that is clearly below the lowest exact price', () => {
    expect(cheapest(exact('steam', 675), estimate('gog', 404))).toBe('gog')
  })

  it('is an estimate five percent below to the hryvnia, and not one a hryvnia short of that', () => {
    // Five percent below 1 000 ₴ is 950 ₴.
    expect(cheapest(exact('steam', 1000), estimate('gog', 950))).toBe('gog')
    expect(cheapest(exact('steam', 1000), estimate('gog', 951))).toBeNull()
    // And below 425 ₴ it is 403.75 ₴: 404 ₴ is short of it, against 426 ₴ it is not.
    expect(cheapest(exact('steam', 425), estimate('gog', 404))).toBeNull()
    expect(cheapest(exact('steam', 426), estimate('gog', 404))).toBe('gog')
  })

  it('is nobody when an estimate only just undercuts: not the estimate, and not the price above it', () => {
    expect(cheapest(exact('steam', 410), estimate('gog', 404))).toBeNull()
  })

  it('measures an estimate against the lowest exact price, not against any of them', () => {
    // 404 ₴ is far below 675 ₴ and within five percent of 410 ₴.
    const rows = [exact('steam', 675), exact('xbox-store', 410), estimate('gog', 404)]
    expect(cheapest(...rows)).toBeNull()
  })

  it('is an exact price that is the lowest, with no margin asked of it', () => {
    expect(cheapest(exact('steam', 400), estimate('gog', 404))).toBe('steam')
    expect(cheapest(exact('steam', 403), estimate('gog', 404))).toBe('steam')
  })

  it('is the free one', () => {
    expect(cheapest(exact('steam', 0), exact('xbox-store', 385))).toBe('steam')
    expect(cheapest(exact('steam', 675), estimate('gog', 404), exact('xbox-store', 0))).toBe(
      'xbox-store',
    )
  })

  it('is the lower of two estimates when no price is exact', () => {
    expect(cheapest(estimate('gog', 404), estimate('other', 500))).toBe('gog')
    expect(cheapest(estimate('gog', 404), estimate('other', 404))).toBeNull()
  })

  it('hands back the very row it was given', () => {
    const steam = { ...exact('steam', 675), note: 'kept' }
    const xbox = { ...exact('xbox-store', 385), note: 'kept too' }
    expect(cheapestRow([steam, xbox])).toBe(xbox)
  })
})

describe('the row a page marks as the cheapest', () => {
  const exact = (store: string, uah: number): PricedRow => ({ store, uah, approximate: false })
  const estimate = (store: string, uah: number): PricedRow => ({ store, uah, approximate: true })
  const marked = (...rows: PricedRow[]): string | null => markedCheapest(rows)?.store ?? null

  it('is the cheapest row, by the same comparison', () => {
    expect(marked(exact('steam', 675), exact('xbox-store', 385))).toBe('xbox-store')
    expect(marked(exact('steam', 675), estimate('gog', 404))).toBe('gog')
    expect(marked(exact('steam', 400), estimate('gog', 404))).toBe('steam')
    // And nobody wherever the comparison names nobody.
    expect(marked(exact('steam', 675))).toBeNull()
    expect(marked(exact('steam', 385), exact('xbox-store', 385))).toBeNull()
    expect(marked(exact('steam', 410), estimate('gog', 404))).toBeNull()
  })

  it('is nobody when the lowest price is free: not the free row, and not the one above it', () => {
    expect(marked(exact('steam', 0), exact('xbox-store', 385))).toBeNull()
    expect(marked(exact('steam', 675), exact('gog', 0))).toBeNull()
    expect(marked(exact('steam', 675), exact('xbox-store', 385), exact('gog', 0))).toBeNull()
  })

  it('is a row that costs one hryvnia: only nothing is free', () => {
    expect(marked(exact('steam', 675), exact('xbox-store', 1))).toBe('xbox-store')
    expect(marked(exact('steam', 675), estimate('gog', 1))).toBe('gog')
  })

  it('hands back the very row it was given', () => {
    const steam = { ...exact('steam', 675), note: 'kept' }
    const xbox = { ...exact('xbox-store', 385), note: 'kept too' }
    expect(markedCheapest([steam, xbox])).toBe(xbox)
  })
})
