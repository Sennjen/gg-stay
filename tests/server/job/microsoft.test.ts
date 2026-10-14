import { describe, expect, it } from 'vitest'
import {
  createMicrosoftFetches,
  createMicrosoftProductsFetch,
  MICROSOFT_DETAIL_IDS_PER_REQUEST,
  MICROSOFT_IDS_PER_REQUEST,
  microsoftProductName,
  microsoftProductTitle,
  microsoftProductUrl,
  microsoftPurchasePrice,
  parseMicrosoftProducts,
  parseMicrosoftRelations,
  parseMicrosoftSearch,
} from '../../../scripts/index/microsoft'
import { safeExternalUrl } from '../../../shared/url'
import {
  microsoftAvailability,
  microsoftDetail,
  microsoftProduct,
  microsoftSearchAnswer,
  microsoftSku,
  microsoftSubscriberAvailability,
} from '../../fixtures/index/jobStores'
import recordedDetails from '../../fixtures/microsoft/details.json' with { type: 'json' }
import recordedFound from '../../fixtures/microsoft/products-found.json' with { type: 'json' }
import recorded from '../../fixtures/microsoft/products.json' with { type: 'json' }
import searchDoom from '../../fixtures/microsoft/search-doom.json' with { type: 'json' }
import searchGta from '../../fixtures/microsoft/search-grand-theft-auto-v.json' with { type: 'json' }
import searchNothing from '../../fixtures/microsoft/search-nothing.json' with { type: 'json' }
import searchPrey from '../../fixtures/microsoft/search-prey.json' with { type: 'json' }
import searchVillage from '../../fixtures/microsoft/search-resident-evil-village.json' with { type: 'json' }

/**
 * The Microsoft Store's display catalog as the job reads it. `tests/fixtures/microsoft/
 * products.json` is an answer recorded on 2026-10-12 for `market=UA`, cut to the fields the job
 * reads. Its four products are the four things the catalog says:
 *
 * | product        | what it is                                                              |
 * | -------------- | ----------------------------------------------------------------------- |
 * | `9NP1P1WFS0LB` | Halo Infinite, on sale until 2026-10-15: 508.20 ₴ against 1 540 ₴, with |
 * |                | the subscriber's zero, a gift and eight subscriber licences beside it   |
 * | `BTQMHK78ZPF9` | LIMBO at its regular 250 ₴, and a trial SKU                             |
 * | `BR765873CQJD` | The Witcher 3 as RAWG links it: not sold in Ukraine, all `USD 0.0`      |
 * | `9PP5G1F0C2B6` | Halo Infinite's free multiplayer: the price anyone pays is 0            |
 */

/** The moment the answer was recorded, inside every window it states. */
const RECORDED_AT = Date.parse('2026-10-12T14:04:00.000Z')

const productOf = (id: string) => recorded.Products.find((product) => product.ProductId === id)

const price = (amount: number, regularAmount: number, discountPercent: number) => ({
  amount,
  regularAmount,
  discountPercent,
})

/**
 * What that recording says of a product beside its price and title: that it is a game, and of
 * its group and the date of its listing nothing. It was cut to the fields the job read on the day
 * it was made, and those two were not among them.
 */
const UNLISTED = { kind: 'Game', group: null, releasedAt: null }

describe('microsoftPurchasePrice on the recorded answer', () => {
  it('reads a sale: what is charged now, the regular price, and the discount between them', () => {
    expect(microsoftPurchasePrice(productOf('9NP1P1WFS0LB'), RECORDED_AT)).toEqual(
      price(50_820, 154_000, 67),
    )
  })

  it('reads a regular price', () => {
    expect(microsoftPurchasePrice(productOf('BTQMHK78ZPF9'), RECORDED_AT)).toEqual(
      price(25_000, 25_000, 0),
    )
  })

  it('reads no price for a product that is not sold in Ukraine, whatever zeroes it carries', () => {
    expect(microsoftPurchasePrice(productOf('BR765873CQJD'), RECORDED_AT)).toBeNull()
  })

  it('reads a free game as a price of zero', () => {
    expect(microsoftPurchasePrice(productOf('9PP5G1F0C2B6'), RECORDED_AT)).toEqual(price(0, 0, 0))
  })

  it('reads no price from a sale that has ended: the answer is about another week', () => {
    const afterTheSale = Date.parse('2026-10-16T00:00:00.000Z')

    expect(microsoftPurchasePrice(productOf('9NP1P1WFS0LB'), afterTheSale)).toBeNull()
    expect(microsoftPurchasePrice(productOf('BTQMHK78ZPF9'), afterTheSale)).toEqual(
      price(25_000, 25_000, 0),
    )
  })
})

describe('microsoftPurchasePrice', () => {
  const NOW = Date.parse('2026-10-12T12:15:00.000Z')
  const one = (...availabilities: unknown[]) => ({
    ProductId: 'BTQMHK78ZPF9',
    DisplaySkuAvailabilities: [microsoftSku(availabilities)],
  })
  const priceOf = (product: unknown) => microsoftPurchasePrice(product, NOW)

  it('takes the price anyone can pay, not the subscriber’s zero beside it', () => {
    expect(priceOf(microsoftProduct('BTQMHK78ZPF9', 385))).toEqual(price(38_500, 38_500, 0))
    expect(
      priceOf(one(microsoftSubscriberAvailability(), microsoftAvailability(385, 385))),
    ).toEqual(price(38_500, 38_500, 0))
  })

  it('reads no price \u2014 and no free game \u2014 from a product only subscribers get', () => {
    expect(priceOf(one(microsoftSubscriberAvailability()))).toBeNull()
    // A member's discount would look the same: a real sum, behind a remediation.
    expect(
      priceOf(one(microsoftAvailability(308, 385, { extra: { RemediationRequired: true } }))),
    ).toBeNull()
    expect(
      priceOf(
        one(microsoftAvailability(308, 385, { extra: { Remediations: [{ Type: 'Upsell' }] } })),
      ),
    ).toBeNull()
    expect(
      priceOf(one(microsoftAvailability(0, 0, { extra: { AffirmationId: '9WNZS2ZC9L74' } }))),
    ).toBeNull()
  })

  it.each([
    ['text', 'Upsell'],
    ['an object', { Type: 'Upsell', BigId: 'CFQ7TTC0KGQ8' }],
    ['a number', 1],
    ['true', true],
  ])('reads no price from an availability whose remediations are stated as %s', (_what, stated) => {
    // Not a list, so not a list that is empty: something is being said about a remedy, and an
    // availability that needs one is not a price anyone can pay.
    expect(
      priceOf(one(microsoftAvailability(385, 385, { extra: { Remediations: stated } }))),
    ).toBeNull()
  })

  it('takes an availability that states it needs no remediation', () => {
    const stated = { RemediationRequired: false, Remediations: [], AffirmationId: null }

    expect(priceOf(one(microsoftAvailability(385, 385, { extra: stated })))).toEqual(
      price(38_500, 38_500, 0),
    )
  })

  it('reads no price from a trial, though a trial can be had for nothing', () => {
    const trial = microsoftSku(
      [microsoftAvailability(0, 0, { actions: ['Details', 'Fulfill', 'Purchase'] })],
      'trial',
    )
    const full = microsoftSku([microsoftAvailability(385, 385)])

    expect(priceOf({ DisplaySkuAvailabilities: [trial] })).toBeNull()
    expect(priceOf({ DisplaySkuAvailabilities: [trial, full] })).toEqual(price(38_500, 38_500, 0))
    // A SKU that calls itself full and is flagged a trial is a trial.
    const flagged = microsoftSku([microsoftAvailability(0, 0)])
    flagged.Sku.Properties.IsTrial = true
    expect(priceOf({ DisplaySkuAvailabilities: [flagged] })).toBeNull()
  })

  it.each([
    ['a licence', ['License', 'Browse', 'Details']],
    ['a gift', ['Details', 'Browse', 'Curate', 'Gift']],
    ['a detail page', ['Details']],
    ['a code to redeem', ['Details', 'Redeem']],
    ['nothing', []],
  ])('reads no price from an availability that is %s and not a purchase', (_what, actions) => {
    expect(priceOf(one(microsoftAvailability(385, 385, { actions })))).toBeNull()
  })

  it('reads no price in another currency: the market was Ukraine, and it is priced in hryvnia', () => {
    expect(priceOf(one(microsoftAvailability(9.99, 9.99, { currency: 'USD' })))).toBeNull()
    expect(priceOf(one(microsoftAvailability(0, 0, { currency: 'USD' })))).toBeNull()
    expect(priceOf(one(microsoftAvailability(385, 385, { currency: 'uah' })))).toBeNull()
  })

  it('reads no price of another market', () => {
    expect(priceOf(one(microsoftAvailability(385, 385, { markets: ['US'] })))).toBeNull()
    expect(priceOf(one(microsoftAvailability(385, 385, { markets: [] })))).toBeNull()
    expect(priceOf(one({ ...microsoftAvailability(385, 385), Markets: undefined }))).toBeNull()
  })

  it.each([
    [
      'has not begun',
      { StartDate: '2026-10-13T10:00:00.0000000Z', EndDate: '9998-12-30T00:00:00.0000000Z' },
    ],
    [
      'has ended',
      { StartDate: '2026-08-14T10:00:00.0000000Z', EndDate: '2026-10-12T12:14:59.0000000Z' },
    ],
    ['has no end', { StartDate: '2026-08-14T10:00:00.0000000Z' }],
    ['has no start', { EndDate: '9998-12-30T00:00:00.0000000Z' }],
    ['is not dated', { StartDate: 'soon', EndDate: 'later' }],
  ])('reads no price from a window that %s', (_what, conditions) => {
    expect(priceOf(one(microsoftAvailability(385, 385, { conditions })))).toBeNull()
  })

  it.each([
    [
      'a start that names no zone',
      { StartDate: '2026-01-01T00:00:00', EndDate: '9998-12-30T00:00:00.0000000Z' },
    ],
    [
      'an end that names no zone',
      { StartDate: '2026-01-01T00:00:00.0000000Z', EndDate: '9998-12-30T00:00:00' },
    ],
    ['a date without a time', { StartDate: '2026-01-01', EndDate: '9998-12-30' }],
    [
      'a time with a space for the T',
      { StartDate: '2026-01-01 00:00:00Z', EndDate: '9998-12-30 00:00:00Z' },
    ],
    ['a number', { StartDate: 0, EndDate: 253370592000000 }],
  ])('reads no price from a window with %s: local time is no time', (_what, conditions) => {
    // `Date.parse` would read the first two as the runner's own time zone, and open and close
    // the window at a different moment on a laptop in Kyiv than on a runner in UTC.
    expect(
      priceOf(one(microsoftAvailability(385, 385, { conditions: conditions as never }))),
    ).toBeNull()
  })

  it('reads a window written with an offset, and with any number of fraction digits', () => {
    // 12:15 UTC on the 12th, the moment of these cases, is 15:15 at +03:00.
    const open = (StartDate: string, EndDate: string) =>
      priceOf(one(microsoftAvailability(385, 385, { conditions: { StartDate, EndDate } })))

    expect(open('2026-10-12T15:00:00+03:00', '2026-10-12T15:30:00+03:00')).toEqual(
      price(38_500, 38_500, 0),
    )
    expect(open('2026-10-12T15:20:00+03:00', '2026-10-12T15:30:00+03:00')).toBeNull()
    expect(open('2026-10-12T12:15:00Z', '2026-10-12T12:15:00.9Z')).toEqual(price(38_500, 38_500, 0))
    expect(open('2026-10-12T12:14:59.9999999Z', '2026-10-12T12:15:00.0000000Z')).toEqual(
      price(38_500, 38_500, 0),
    )
    expect(open('2026-10-12T12:15:00.0010000Z', '2026-10-12T13:00:00.0000000Z')).toBeNull()
  })

  it('reads a price up to the last second of its window', () => {
    const conditions = {
      StartDate: '2026-10-12T12:15:00.0000000Z',
      EndDate: '2026-10-12T12:15:00.0000000Z',
    }

    expect(priceOf(one(microsoftAvailability(385, 385, { conditions })))).toEqual(
      price(38_500, 38_500, 0),
    )
  })

  it.each([
    ['text', '385.00', 385],
    ['a negative sum', -1, 385],
    ['a sum with a third decimal', 508.255, 1540],
    ['not a number', Number.NaN, 385],
    ['infinite', Number.POSITIVE_INFINITY, 385],
    ['missing', undefined, 385],
    ['a regular price that is text', 385, '385'],
    ['a regular price that is missing', 385, undefined],
  ])('reads no price when a sum is %s \u2014 and never zero', (_what, list, msrp) => {
    expect(priceOf(one(microsoftAvailability(list as number, msrp as number)))).toBeNull()
  })

  it('reads kopecks exactly', () => {
    expect(priceOf(one(microsoftAvailability(508.2, 1540)))).toEqual(price(50_820, 154_000, 67))
    expect(priceOf(one(microsoftAvailability(19.99, 19.99)))).toEqual(price(1_999, 1_999, 0))
    expect(priceOf(one(microsoftAvailability(0.07, 0.07)))).toEqual(price(7, 7, 0))
  })

  it('never states a regular price below what is charged', () => {
    expect(priceOf(one(microsoftAvailability(385, 0)))).toEqual(price(38_500, 38_500, 0))
  })

  it('takes several prices anyone can pay when they agree, and none when they do not', () => {
    const agreeing = {
      DisplaySkuAvailabilities: [
        microsoftSku([microsoftAvailability(385, 385), microsoftAvailability(385, 385)]),
        microsoftSku([microsoftAvailability(385, 385)]),
      ],
    }
    const disagreeing = one(microsoftAvailability(385, 385), microsoftAvailability(308, 385))
    const twoEditions = {
      DisplaySkuAvailabilities: [
        microsoftSku([microsoftAvailability(385, 385)]),
        microsoftSku([microsoftAvailability(385, 770)]),
      ],
    }

    expect(priceOf(agreeing)).toEqual(price(38_500, 38_500, 0))
    // Which of the two a visitor would be charged cannot be told, so neither is published.
    expect(priceOf(disagreeing)).toBeNull()
    expect(priceOf(twoEditions)).toBeNull()
  })

  it.each([
    ['nothing', null],
    ['text', 'BTQMHK78ZPF9'],
    ['a product with no SKUs', { ProductId: 'BTQMHK78ZPF9' }],
    ['SKUs that are not a list', { DisplaySkuAvailabilities: {} }],
    ['an empty list of SKUs', { DisplaySkuAvailabilities: [] }],
    ['a SKU that is not one', { DisplaySkuAvailabilities: [null, 'x', {}] }],
    [
      'a SKU of no stated type',
      {
        DisplaySkuAvailabilities: [{ Sku: {}, Availabilities: [microsoftAvailability(385, 385)] }],
      },
    ],
    ['a SKU without availabilities', { DisplaySkuAvailabilities: [{ Sku: { SkuType: 'full' } }] }],
    [
      'availabilities that are not ones',
      { DisplaySkuAvailabilities: [microsoftSku([null, 'x', {}])] },
    ],
    [
      'an availability without a price',
      one({ ...microsoftAvailability(385, 385), OrderManagementData: {} }),
    ],
  ])('reads no price from %s', (_what, product) => {
    expect(priceOf(product)).toBeNull()
  })
})

describe('parseMicrosoftProducts', () => {
  const NOW = RECORDED_AT

  it('answers for every id it was asked about: a price, or none', () => {
    const ids = ['9NP1P1WFS0LB', 'BTQMHK78ZPF9', 'BR765873CQJD', '9PP5G1F0C2B6', 'BX3M8L83BBRW']

    expect(parseMicrosoftProducts(recorded, ids, NOW)).toEqual(
      new Map([
        [
          '9NP1P1WFS0LB',
          { price: price(50_820, 154_000, 67), title: 'Halo Infinite', ...UNLISTED },
        ],
        // The store's own spelling of the title, capitals and all.
        ['BTQMHK78ZPF9', { price: price(25_000, 25_000, 0), title: 'LIMBO', ...UNLISTED }],
        // In the answer, and not sold here: no price, so nothing at all — a title alone is no offer.
        ['BR765873CQJD', null],
        ['9PP5G1F0C2B6', { price: price(0, 0, 0), title: 'Halo Infinite', ...UNLISTED }],
        // Not in the answer at all: Microsoft leaves out what it does not sell or does not know.
        ['BX3M8L83BBRW', null],
      ]),
    )
  })

  it('says nothing of a product it was not asked about', () => {
    expect(parseMicrosoftProducts(recorded, ['BTQMHK78ZPF9'], NOW)).toEqual(
      new Map([['BTQMHK78ZPF9', { price: price(25_000, 25_000, 0), title: 'LIMBO', ...UNLISTED }]]),
    )
  })

  it('knows a product whose id the answer spells in lower case', () => {
    const answer = { Products: [microsoftProduct('btqmhk78zpf9', 250)] }

    expect(parseMicrosoftProducts(answer, ['BTQMHK78ZPF9'], NOW).get('BTQMHK78ZPF9')).toEqual({
      price: price(25_000, 25_000, 0),
      // A product that states no title is still a product, with its price.
      title: null,
      ...UNLISTED,
    })
  })

  it('reads an answer with no products as "none of these is sold"', () => {
    expect(parseMicrosoftProducts({ Products: [] }, ['BTQMHK78ZPF9'], NOW)).toEqual(
      new Map([['BTQMHK78ZPF9', null]]),
    )
  })

  it.each([
    ['nothing', null],
    ['text', 'Bad Gateway'],
    ['a list', [microsoftProduct('BTQMHK78ZPF9', 250)]],
    ['an object without products', { code: 'BadRequest', message: 'Invalid market' }],
    ['products that are not a list', { Products: 'none' }],
  ])('throws on an answer that is %s, rather than read it as "none is sold"', (_what, body) => {
    expect(() => parseMicrosoftProducts(body, ['BTQMHK78ZPF9'], NOW)).toThrow(
      expect.objectContaining({ source: 'MICROSOFT', kind: 'ERROR' }),
    )
  })
})

/**
 * `tests/fixtures/microsoft/products-found.json` is the answers recorded on 2026-10-13, with
 * `actionFilter=Purchase`, about the products the store's own ways lead to — the bundles Resident
 * Evil Village is sold in, and what its search found for Prey, Grand Theft Auto V, DOOM and
 * Terraria — cut to the fields the job reads.
 */
describe('parseMicrosoftProducts on the products the store’s own ways lead to', () => {
  /** The moment the answers were recorded, inside every window they state. */
  const NOW = Date.parse('2026-10-13T10:40:00.000Z')
  const ids = recordedFound.Products.map((product) => product.ProductId)
  const found = parseMicrosoftProducts(recordedFound, ids, NOW)

  it('reads the price, the title, the group and the date of the listing of each', () => {
    expect(found.get('9N2S04LGXXH4')).toEqual({
      price: price(119_900, 119_900, 0),
      title: 'Resident Evil Village',
      kind: 'Game',
      group: 'db97de36-8e9e-4a95-a5fd-d88bfbdd220b',
      // The listing's date, not the game's: Resident Evil Village is a game of 2021.
      releasedAt: Date.parse('2026-01-20T00:00:00.000Z'),
    })
    expect(found.get('9NXFX68ZNKK0')).toEqual({
      price: price(67_450, 134_900, 50),
      title: 'Grand Theft Auto V Enhanced (PC)',
      kind: 'Game',
      group: '29d3673e-f21c-43ed-8ca6-e703000663a0',
      releasedAt: Date.parse('2025-04-15T15:00:00.000Z'),
    })
  })

  it('reads every one of them as sold: the filter left nothing else in the answers', () => {
    expect([...found].map(([id, product]) => [id, product?.title, product?.price.amount])).toEqual([
      ['9N2S04LGXXH4', 'Resident Evil Village', 119_900],
      ['9N7T25ZJJQ9T', 'Resident Evil Village Gold Edition', 49_470],
      ['9NQWB2KZBS1P', 'Resident Evil 7 Gold Edition & Village Gold Edition', 199_900],
      ['9PBC1QFBW563', 'Prey', 61_000],
      ['9NGN8DQGSP29', 'Prey\u00AE: Digital Deluxe Edition', 130_000],
      ['9NXFX68ZNKK0', 'Grand Theft Auto V Enhanced (PC)', 67_450],
      // A listing its publisher wrote in Ukrainian comes back in Ukrainian.
      [
        '9P6ZXP2ZRQCV',
        'Grand Theft Auto V Enhanced (\u041F\u041A) \u0456 \u043A\u043E\u043C\u043F\u043B\u0435\u043A\u0442 \u043F\u043B\u0430\u0442\u0456\u0436\u043D\u043E\u0457 \u043A\u0430\u0440\u0442\u043A\u0438 \u00AB\u0411\u0456\u043B\u0430 \u0430\u043A\u0443\u043B\u0430\u00BB',
        199_900,
      ],
      ['9PK09BL31FK1', 'DOOM Eternal Standard Edition (PC)', 89_500],
      ['9N8TRM7F6KGC', 'DOOM Eternal Deluxe Edition (PC)', 149_000],
      ['9NBLGGH186XZ', 'Terraria', 12_750],
    ])
  })

  it('reads the editions of one game as one group, and another game as another', () => {
    const groupOf = (id: string) => found.get(id)?.group
    expect(groupOf('9N7T25ZJJQ9T')).toBe(groupOf('9N2S04LGXXH4'))
    expect(groupOf('9NGN8DQGSP29')).toBe(groupOf('9PBC1QFBW563'))
    expect(groupOf('9PBC1QFBW563')).not.toBe(groupOf('9N2S04LGXXH4'))
  })

  it('reads no group for a product the catalog files under none', () => {
    expect(found.get('9NBLGGH186XZ')).toMatchObject({
      group: null,
      // Any number of fraction digits, as the catalog happens to write them.
      releasedAt: Date.parse('2014-09-12T01:52:32.430Z'),
    })
  })
})

describe('parseMicrosoftProducts and what a listing says beside its price', () => {
  const NOW = RECORDED_AT
  const read = (product: unknown) =>
    parseMicrosoftProducts({ Products: [product] }, ['BTQMHK78ZPF9'], NOW).get('BTQMHK78ZPF9')
  const listed = (listing: object) => ({ ...microsoftProduct('BTQMHK78ZPF9', 250), ...listing })

  it('reads the group and the date a product states', () => {
    const product = microsoftProduct('BTQMHK78ZPF9', 250, 250, 'LIMBO', {
      group: 'limbo-group',
      released: '2014-12-05T00:00:00.0000000Z',
    })

    expect(read(product)).toMatchObject({
      group: 'limbo-group',
      releasedAt: Date.parse('2014-12-05T00:00:00.000Z'),
    })
  })

  it('reads the date the catalog gives a listing it has none for as no date', () => {
    const dated = (released: string) =>
      read(microsoftProduct('BTQMHK78ZPF9', 250, 250, 'LIMBO', { group: 'limbo', released }))

    // `9998-12-30` is how the catalog says it has no date; any year from 9000 on is read so.
    expect(dated('9998-12-30T00:00:00.0000000Z')?.releasedAt).toBeNull()
    expect(dated('9000-01-01T00:00:00.0000000Z')?.releasedAt).toBeNull()
    expect(dated('8999-12-31T23:59:59.0000000Z')?.releasedAt).toBe(
      Date.parse('8999-12-31T23:59:59.000Z'),
    )
    // The product is a product all the same, with its price.
    expect(dated('9998-12-30T00:00:00.0000000Z')?.price.amount).toBe(25_000)
  })

  it('reads what kind of product it is, and none when it states none', () => {
    expect(read(microsoftProduct('BTQMHK78ZPF9', 250))?.kind).toBe('Game')
    expect(read(microsoftProduct('BTQMHK78ZPF9', 250, 250, 'x', { kind: 'Durable' }))?.kind).toBe(
      'Durable',
    )
    const { ProductKind: _kind, ...unkinded } = microsoftProduct('BTQMHK78ZPF9', 250)
    expect(read(unkinded)?.kind).toBeNull()
  })

  it.each([
    ['no group', {}],
    ['an empty group', { Properties: { ProductGroupId: '  ' } }],
    ['a group that is not text', { Properties: { ProductGroupId: 42 } }],
    ['properties that are not an object', { Properties: 'limbo-group' }],
  ])('reads %s as none, and the product still as a product', (_what, listing) => {
    expect(read(listed(listing))).toMatchObject({ price: price(25_000, 25_000, 0), group: null })
  })

  it.each([
    ['no market properties', {}],
    ['market properties that are not a list', { MarketProperties: { Markets: ['UA'] } }],
    [
      'a date for another market only',
      {
        MarketProperties: [
          { Markets: ['US'], OriginalReleaseDate: '2014-12-05T00:00:00.0000000Z' },
        ],
      },
    ],
    [
      'a date that names no zone',
      { MarketProperties: [{ Markets: ['UA'], OriginalReleaseDate: '2014-12-05T00:00:00' }] },
    ],
    [
      'a date that is not text',
      { MarketProperties: [{ Markets: ['UA'], OriginalReleaseDate: 0 }] },
    ],
  ])('reads %s as no date', (_what, listing) => {
    expect(read(listed(listing))).toMatchObject({ releasedAt: null })
  })
})

/**
 * `tests/fixtures/microsoft/details.json` is two answers recorded on 2026-10-13 without
 * `actionFilter`, cut to the fields the job reads:
 *
 * | product        | what it is                                                              |
 * | -------------- | ----------------------------------------------------------------------- |
 * | `9MTNPF414F65` | Resident Evil Village as RAWG links it: a bundle nobody can buy, with   |
 * |                | the four things it was made of as its parents                           |
 * | `BTQMHK78ZPF9` | LIMBO: sold, no parent, in one bundle                                   |
 * | `BR765873CQJD` | The Witcher 3 as RAWG links it: not sold, no parent                     |
 * | `9MW7MFV29CMF` | the game inside the bundle, in the same group, and the twelve bundles   |
 * |                | it is in — the one on sale, `9N2S04LGXXH4`, among them                  |
 * | `9N19JBMWKSPT` | Resident Evil Re:Verse, which came with it: another group               |
 * | `9N1HZ1PWLXTV` | an add-on that came with it, in the game's group                        |
 * | `9N2TRSW63FM2` | another                                                                 |
 */
describe('parseMicrosoftRelations', () => {
  const VILLAGE = 'db97de36-8e9e-4a95-a5fd-d88bfbdd220b'
  const all = recordedDetails.Products.map((product) => product.ProductId)
  const relations = parseMicrosoftRelations(recordedDetails, all)

  it('reads what a bundle nobody can buy was made of', () => {
    expect(relations.get('9MTNPF414F65')).toEqual({
      title: 'Resident Evil Village',
      group: VILLAGE,
      parents: ['9MW7MFV29CMF', '9N19JBMWKSPT', '9N1HZ1PWLXTV', '9N2TRSW63FM2'],
      bundles: [],
    })
  })

  it('reads the group of each part, and the bundles it is in', () => {
    expect(relations.get('9MW7MFV29CMF')).toMatchObject({
      title: 'Resident Evil Village',
      group: VILLAGE,
      parents: [],
    })
    expect(relations.get('9MW7MFV29CMF')?.bundles).toHaveLength(12)
    expect(relations.get('9MW7MFV29CMF')?.bundles).toContain('9N2S04LGXXH4')
    // What came with the game is another product group; its bundles are not the game's.
    expect(relations.get('9N19JBMWKSPT')?.group).toBe('5db59777-8053-488a-9056-b0607c448bca')
    expect(relations.get('9N1HZ1PWLXTV')?.group).toBe(VILLAGE)
  })

  it('reads no parent for a product that has none', () => {
    expect(relations.get('BTQMHK78ZPF9')).toEqual({
      title: 'LIMBO',
      group: '0382d552-fcc2-4783-87e9-720b8c208d5a',
      parents: [],
      bundles: ['C1WP25BWLVTF'],
    })
    expect(relations.get('BR765873CQJD')).toMatchObject({ parents: [], bundles: ['BNV61JB748C5'] })
  })

  it('answers for every id it was asked about, and for no other', () => {
    expect(parseMicrosoftRelations(recordedDetails, ['BTQMHK78ZPF9', 'BX3M8L83BBRW'])).toEqual(
      new Map([
        ['BTQMHK78ZPF9', relations.get('BTQMHK78ZPF9')],
        // Not in the answer: a product Microsoft does not know for Ukraine.
        ['BX3M8L83BBRW', null],
      ]),
    )
  })

  it('knows a product whose id the answer spells in lower case', () => {
    const answer = { Products: [microsoftDetail('btqmhk78zpf9', 'LIMBO', { group: 'limbo' })] }

    expect(parseMicrosoftRelations(answer, ['BTQMHK78ZPF9']).get('BTQMHK78ZPF9')).toEqual({
      title: 'LIMBO',
      group: 'limbo',
      parents: [],
      bundles: [],
    })
  })

  it('passes on a related id only if it is one, in upper case and once', () => {
    const related = (RelatedProductId: unknown, RelationshipType = 'Parent') => ({
      RelatedProductId,
      RelationshipType,
    })
    const product = {
      ...microsoftDetail('BTQMHK78ZPF9', 'LIMBO'),
      MarketProperties: [
        {
          Markets: ['UA'],
          RelatedProducts: [
            related('9mw7mfv29cmf'),
            related('9MW7MFV29CMF'),
            // What would otherwise become part of the next request.
            related('9MW7MFV29CMF&market=US'),
            related('9MW7MFV29CM'),
            related(42),
            related('9N2S04LGXXH4', 'Bundle'),
            related('9NQZ2WNZN93L', 'Extends'),
            'BNV61JB748C5',
            null,
          ],
        },
      ],
    }

    expect(parseMicrosoftRelations({ Products: [product] }, ['BTQMHK78ZPF9'])).toEqual(
      new Map([
        [
          'BTQMHK78ZPF9',
          { title: 'LIMBO', group: null, parents: ['9MW7MFV29CMF'], bundles: ['9N2S04LGXXH4'] },
        ],
      ]),
    )
  })

  it('reads the relations the catalog states for Ukraine, and no other market’s', () => {
    const product = {
      ...microsoftDetail('BTQMHK78ZPF9', 'LIMBO'),
      MarketProperties: [
        {
          Markets: ['US'],
          RelatedProducts: [{ RelatedProductId: '9MW7MFV29CMF', RelationshipType: 'Parent' }],
        },
      ],
    }

    expect(
      parseMicrosoftRelations({ Products: [product] }, ['BTQMHK78ZPF9']).get('BTQMHK78ZPF9'),
    ).toMatchObject({ parents: [], bundles: [] })
  })

  it.each([
    ['nothing', null],
    ['text', 'Bad Gateway'],
    ['a list', [microsoftDetail('BTQMHK78ZPF9', 'LIMBO')]],
    ['an object without products', { code: 'BadRequest', message: 'Invalid market' }],
  ])('throws on an answer that is %s, rather than read it as "no relations"', (_what, body) => {
    expect(() => parseMicrosoftRelations(body, ['BTQMHK78ZPF9'])).toThrow(
      expect.objectContaining({ source: 'MICROSOFT', kind: 'ERROR' }),
    )
  })
})

/** Five answers of the store's search, recorded on 2026-10-13 and cut to the fields read. */
describe('parseMicrosoftSearch', () => {
  it('reads the games a search found, in the store’s order, and not an add-on', () => {
    expect(parseMicrosoftSearch(searchPrey)).toEqual([
      { id: '9PBC1QFBW563', title: 'Prey' },
      { id: '9NGN8DQGSP29', title: 'Prey\u00AE: Digital Deluxe Edition' },
      // "Prey®: Mooncrash (Add-On)" is a `Durable`, and is not among them.
    ])
  })

  it('reads two products under one title as two', () => {
    expect(parseMicrosoftSearch(searchVillage)).toEqual([
      { id: '9N2S04LGXXH4', title: 'Resident Evil Village' },
      { id: '9N7T25ZJJQ9T', title: 'Resident Evil Village Gold Edition' },
      // The game inside the bundles: in the catalog, and sold on its own nowhere.
      { id: '9MW7MFV29CMF', title: 'Resident Evil Village' },
    ])
  })

  it('reads a search that found only other games as those games', () => {
    const titles = parseMicrosoftSearch(searchDoom).map((game) => game.title)

    expect(titles).toEqual([
      'DOOM Eternal Deluxe Edition (PC)',
      'DOOM Eternal Standard Edition (PC)',
      'DOOM Eternal: The Ancient Gods - Part One (PC)',
      'DOOM Eternal: The Ancients Gods Expansion Pack (PC)',
      'DOOM: The Dark Ages',
      'DOOM: The Dark Ages Premium Edition',
      'DOOM + DOOM II',
      'DOOM 3',
      'DOOM 64',
    ])
    expect(titles).not.toContain('DOOM')
  })

  it('reads a title in whatever language the listing is written in', () => {
    expect(parseMicrosoftSearch(searchGta).map((game) => game.id)).toEqual([
      '9NXFX68ZNKK0',
      '9P6ZXP2ZRQCV',
      '9MSRG7MN6SP6',
      '9N9RSV4F7ZR0',
    ])
    expect(parseMicrosoftSearch(searchGta)[1]?.title).toMatch(/^Grand Theft Auto V Enhanced \(/)
  })

  it('reads a search that found nothing as no games', () => {
    expect(searchNothing).toEqual({ Results: [], TotalResultCount: 0 })
    expect(parseMicrosoftSearch(searchNothing)).toEqual([])
  })

  it('keeps a product only if it is a game with an id and a title, once', () => {
    const answer = {
      Results: [
        ...microsoftSearchAnswer([
          { id: '9pbc1qfbw563', title: '  Prey  ' },
          { id: '9PBC1QFBW563', title: 'Prey, again' },
          { id: '9MSVGC96BBHP', title: 'Prey: Mooncrash', type: 'Durable' },
          { id: '9NGN8DQGSP29&market=US', title: 'Prey: Digital Deluxe Edition' },
          { id: '9NGN8DQGSP29', title: ' \u200B ' },
        ]).Results,
        // Another family than the one that was asked for.
        {
          ProductFamilyName: 'Apps',
          Products: [{ ProductId: '9WZDNCRFJ3TJ', Type: 'Game', Title: 'Prey Companion' }],
        },
        { ProductFamilyName: 'Games', Products: 'none' },
        { ProductFamilyName: 'Games' },
        null,
      ],
    }

    expect(parseMicrosoftSearch(answer)).toEqual([{ id: '9PBC1QFBW563', title: 'Prey' }])
  })

  it.each([
    ['nothing', null],
    ['text', 'Bad Gateway'],
    ['a list', []],
    ['an object without results', { code: 'BadRequest' }],
    ['results that are not a list', { Results: 'none' }],
  ])('throws on an answer that is %s, rather than read it as "nothing found"', (_what, body) => {
    expect(() => parseMicrosoftSearch(body)).toThrow(
      expect.objectContaining({ source: 'MICROSOFT', kind: 'ERROR' }),
    )
  })
})

describe('microsoftProductTitle', () => {
  const listing = (...entries: unknown[]) => ({ LocalizedProperties: entries })
  const inLanguage = (Language: string, ProductTitle: unknown) => ({ Language, ProductTitle })

  it('reads what the recorded answer calls each product', () => {
    expect(recorded.Products.map((product) => microsoftProductTitle(product))).toEqual([
      'Halo Infinite',
      'LIMBO',
      'The Witcher 3: Wild Hunt',
      'Halo Infinite',
    ])
  })

  it('takes the one listing an answer carries, whatever language Microsoft chose for it', () => {
    expect(
      microsoftProductTitle(listing(inLanguage('en-us', 'Hollow Knight: Voidheart Edition'))),
    ).toBe('Hollow Knight: Voidheart Edition')
    expect(microsoftProductTitle(listing(inLanguage('uk', 'Destiny 2')))).toBe('Destiny 2')
    expect(microsoftProductTitle(listing(inLanguage('pl-pl', 'Wied\u017Amin 3')))).toBe(
      'Wied\u017Amin 3',
    )
    expect(microsoftProductTitle(listing({ ProductTitle: 'LIMBO' }))).toBe('LIMBO')
  })

  it('prefers the Ukrainian listing, then an English one, should an answer carry several', () => {
    const english = inLanguage('en-US', 'The Witcher 3: Wild Hunt')
    const ukrainian = inLanguage(
      'uk-UA',
      '\u0412\u0456\u0434\u044C\u043C\u0430\u043A 3: \u0414\u0438\u043A\u0438\u0439 \u0413\u0456\u043D',
    )
    const polish = inLanguage('pl-PL', 'Wied\u017Amin 3: Dziki Gon')

    // The order the job asks for the languages in, and the page its offer links to.
    expect(microsoftProductTitle(listing(polish, english, ukrainian))).toBe(
      '\u0412\u0456\u0434\u044C\u043C\u0430\u043A 3: \u0414\u0438\u043A\u0438\u0439 \u0413\u0456\u043D',
    )
    expect(microsoftProductTitle(listing(polish, english))).toBe('The Witcher 3: Wild Hunt')
    expect(microsoftProductTitle(listing(polish))).toBe('Wied\u017Amin 3: Dziki Gon')
    // A listing without a title does not count, whatever its language.
    expect(microsoftProductTitle(listing(inLanguage('uk-UA', '  '), english))).toBe(
      'The Witcher 3: Wild Hunt',
    )
  })

  it('reads it as plain text, on one line and bounded', () => {
    expect(microsoftProductTitle(listing(inLanguage('en', '  Halo\n Infinite  ')))).toBe(
      'Halo Infinite',
    )
    expect(microsoftProductTitle(listing(inLanguage('en', 'x'.repeat(500))))).toHaveLength(200)
  })

  it.each([
    ['a product without localised properties', { ProductId: 'BTQMHK78ZPF9' }],
    [
      'localised properties that are not a list',
      { LocalizedProperties: { ProductTitle: 'LIMBO' } },
    ],
    ['an empty list', listing()],
    ['a listing with no title', listing({ Language: 'en-us' })],
    ['a title that is not text', listing(inLanguage('en-us', 42), inLanguage('uk', ['LIMBO']))],
    ['nothing', null],
  ])('reads no title from %s', (_what, product) => {
    expect(microsoftProductTitle(product)).toBeNull()
  })
})

describe('microsoftProductUrl', () => {
  it('addresses the product page for Ukraine, where the price is the hryvnia one', () => {
    const url = microsoftProductUrl({ id: 'BTQMHK78ZPF9', name: 'limbo' })

    expect(url).toBe('https://www.microsoft.com/uk-ua/p/limbo/btqmhk78zpf9')
    // As it stands it is a link the site may show.
    expect(safeExternalUrl(url)).toBe(url)
  })
})

describe('microsoftProductName', () => {
  it('makes the name a page is addressed by from what the store calls the product', () => {
    expect(microsoftProductName('Resident Evil Village')).toBe('resident-evil-village')
    expect(microsoftProductName('Grand Theft Auto V Enhanced (PC)')).toBe(
      'grand-theft-auto-v-enhanced-pc',
    )
    expect(microsoftProductName('Prey\u00AE: Digital Deluxe Edition')).toBe(
      'prey-digital-deluxe-edition',
    )
    // As the store makes its own: a hyphen for each space, and the title's own hyphen kept.
    expect(microsoftProductName('Microsoft Flight Simulator: Standard - Preorder')).toBe(
      'microsoft-flight-simulator-standard---preorder',
    )
  })

  it('always makes a name the address can carry', () => {
    const names = [
      microsoftProductName('  LIMBO  '),
      microsoftProductName('-= N++ =-'),
      microsoftProductName('x'.repeat(500)),
      microsoftProductName(`${'x'.repeat(199)} y`),
      // Nothing of a title in another script is left, and neither is anything of no title.
      microsoftProductName('\u0412\u0456\u0434\u044C\u043C\u0430\u043A'),
      microsoftProductName(''),
      microsoftProductName(null),
    ]

    expect(names).toEqual(['limbo', 'n', 'x'.repeat(200), 'x'.repeat(199), 'game', 'game', 'game'])
    for (const name of names) {
      const url = microsoftProductUrl({ id: '9N2S04LGXXH4', name })
      expect(url).toBe(`https://www.microsoft.com/uk-ua/p/${name}/9n2s04lgxxh4`)
      expect(safeExternalUrl(url)).toBe(url)
    }
  })
})

describe('createMicrosoftFetches', () => {
  function transport(options: { fixtures?: boolean; status?: () => number } = {}) {
    const urls: string[] = []
    const waits: number[] = []
    const fixtures: string[] = []
    const microsoft = createMicrosoftFetches({
      fixtures: options.fixtures ?? false,
      fetchJson: async (url) => {
        urls.push(url)
        return { status: options.status?.() ?? 200, body: { Products: [], Results: [] } }
      },
      readFixture: async (name) => {
        fixtures.push(name)
        return name === 'details' ? recordedDetails : name === 'search-prey' ? searchPrey : null
      },
      now: () => 0,
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
    })
    return { microsoft, urls, waits, fixtures }
  }

  it('asks about products with nothing filtered out, for Ukraine', async () => {
    const { microsoft, urls } = transport()

    await microsoft.details(['9MTNPF414F65', 'BTQMHK78ZPF9'])

    expect(urls).toEqual([
      'https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=9MTNPF414F65,BTQMHK78ZPF9&market=UA&languages=uk-UA,en-US',
    ])
  })

  it('asks for twenty such products a request: an unfiltered answer is the heavier one', () => {
    expect(MICROSOFT_DETAIL_IDS_PER_REQUEST).toBe(20)
  })

  it('searches the store for Ukraine, among games, by the name as it stands', async () => {
    const { microsoft, urls } = transport()

    await microsoft.search('Resident Evil Village')
    await microsoft.search("Assassin's Creed: Odyssey & more?#")

    expect(urls).toEqual([
      'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=UA&languages=uk-UA,en-US&productFamilyNames=Games&query=Resident%20Evil%20Village',
      // Whatever a name holds is the query, and never a second parameter.
      "https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=UA&languages=uk-UA,en-US&productFamilyNames=Games&query=Assassin's%20Creed%3A%20Odyssey%20%26%20more%3F%23",
    ])
    expect(new URL(urls[1]!).searchParams.get('query')).toBe("Assassin's Creed: Odyssey & more?#")
  })

  it('sends no more of a name than a name is long', async () => {
    const { microsoft, urls } = transport()

    await microsoft.search('x'.repeat(5_000))

    expect(new URL(urls[0]!).searchParams.get('query')).toBe('x'.repeat(200))
  })

  it('sends all three kinds of request through one limiter: a request a second', async () => {
    const { microsoft, waits } = transport()

    await Promise.all([
      microsoft.products(['BTQMHK78ZPF9']),
      microsoft.details(['9MTNPF414F65']),
      microsoft.search('Prey'),
    ])

    expect(waits).toEqual([1_000, 2_000])
  })

  it('sends a search once, where a read of products is tried again', async () => {
    const failing = transport({ status: () => 503 })

    await expect(failing.microsoft.search('Prey')).rejects.toMatchObject({
      source: 'MICROSOFT',
      status: 503,
    })
    expect(failing.urls).toHaveLength(1)

    await expect(failing.microsoft.details(['9MTNPF414F65'])).rejects.toMatchObject({
      status: 503,
    })
    await expect(failing.microsoft.products(['BTQMHK78ZPF9'])).rejects.toMatchObject({
      status: 503,
    })
    expect(failing.urls).toHaveLength(5)
  })

  it.each([
    [403, 'ERROR'],
    [429, 'RATE_LIMITED'],
  ])('says so when the store refuses a search with a %i, and asks once', async (status, kind) => {
    const refused = transport({ status: () => status })

    await expect(refused.microsoft.search('Prey')).rejects.toMatchObject({ kind, status })
    expect(refused.urls).toHaveLength(1)
  })

  it('serves the recordings in fixture mode, each under its own name', async () => {
    const { microsoft, urls, fixtures } = transport({ fixtures: true })

    expect(await microsoft.details(['9MTNPF414F65'])).toBe(recordedDetails)
    expect(await microsoft.details(['BTQMHK78ZPF9', '9MW7MFV29CMF'])).toBe(recordedDetails)
    expect(await microsoft.search('Prey')).toBe(searchPrey)
    await expect(microsoft.search('Grand Theft Auto V')).rejects.toMatchObject({
      kind: 'NOT_FOUND',
    })

    expect(fixtures).toEqual(['details', 'details', 'search-prey', 'search-grand-theft-auto-v'])
    expect(urls).toHaveLength(0)
  })
})

describe('createMicrosoftProductsFetch', () => {
  function transport(fixtures = false) {
    const urls: string[] = []
    const waits: number[] = []
    const fetchProducts = createMicrosoftProductsFetch({
      fixtures,
      fetchJson: async (url) => {
        urls.push(url)
        return { status: 200, body: { Products: [] } }
      },
      readFixture: async (name) => (name === 'products' ? recorded : null),
      now: () => 0,
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
    })
    return { fetchProducts, urls, waits }
  }

  it('asks for Ukraine, and only for what can be bought', async () => {
    const { fetchProducts, urls } = transport()

    await fetchProducts(['BTQMHK78ZPF9', '9NP1P1WFS0LB'])

    expect(urls).toEqual([
      'https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=BTQMHK78ZPF9,9NP1P1WFS0LB&market=UA&languages=uk-UA,en-US&actionFilter=Purchase',
    ])
  })

  it('sends a request a second, with no burst', async () => {
    const { fetchProducts, waits } = transport()

    await Promise.all(
      ['BTQMHK78ZPF9', '9NP1P1WFS0LB', '9PP5G1F0C2B6'].map((id) => fetchProducts([id])),
    )

    expect(waits).toEqual([1_000, 2_000])
  })

  it('serves the recorded answer to every batch in fixture mode, and asks the network nothing', async () => {
    const { fetchProducts, urls } = transport(true)

    expect(await fetchProducts(['BTQMHK78ZPF9'])).toBe(recorded)
    expect(await fetchProducts(['9NP1P1WFS0LB', 'BX3M8L83BBRW'])).toBe(recorded)
    expect(urls).toHaveLength(0)
  })

  it('asks about a hundred products a request', () => {
    expect(MICROSOFT_IDS_PER_REQUEST).toBe(100)
  })
})
