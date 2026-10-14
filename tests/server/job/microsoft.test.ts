import { describe, expect, it } from 'vitest'
import {
  createMicrosoftProductsFetch,
  MICROSOFT_IDS_PER_REQUEST,
  microsoftProductTitle,
  microsoftProductUrl,
  microsoftPurchasePrice,
  parseMicrosoftProducts,
} from '../../../scripts/index/microsoft'
import { safeExternalUrl } from '../../../shared/url'
import {
  microsoftAvailability,
  microsoftProduct,
  microsoftSku,
  microsoftSubscriberAvailability,
} from '../../fixtures/index/jobStores'
import recorded from '../../fixtures/microsoft/products.json' with { type: 'json' }

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

describe('microsoftPurchasePrice on the recorded answer', () => {
  it('reads a sale: what is charged now, the regular price, and the discount between them', () => {
    expect(microsoftPurchasePrice(productOf('9NP1P1WFS0LB'), RECORDED_AT)).toEqual(
      price(50_820, 154_000, 67),
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

  it('reads no price — and no free game — from a product only subscribers get', () => {
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

  it('reads no price from an availability whose remediations are stated as an object', () => {
    // Not a list, so not a list that is empty: something is being said about a remedy, and an
    // availability that needs one is not a price anyone can pay.
    const stated = { Type: 'Upsell', BigId: 'CFQ7TTC0KGQ8' }
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
    ['has no end', { StartDate: '2026-08-14T10:00:00.0000000Z' }],
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
    ['a negative sum', -1, 385],
    ['a sum with a third decimal', 508.255, 1540],
    ['not a number', Number.NaN, 385],
    ['missing', undefined, 385],
    ['a regular price that is text', 385, '385'],
  ])('reads no price when a sum is %s — and never zero', (_what, list, msrp) => {
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
        ['9NP1P1WFS0LB', { price: price(50_820, 154_000, 67), title: 'Halo Infinite' }],
        // The store's own spelling of the title, capitals and all.
        ['BTQMHK78ZPF9', { price: price(25_000, 25_000, 0), title: 'LIMBO' }],
        // In the answer, and not sold here: no price, so nothing at all — a title alone is no offer.
        ['BR765873CQJD', null],
        ['9PP5G1F0C2B6', { price: price(0, 0, 0), title: 'Halo Infinite' }],
        // Not in the answer at all: Microsoft leaves out what it does not sell or does not know.
        ['BX3M8L83BBRW', null],
      ]),
    )
  })

  it('says nothing of a product it was not asked about', () => {
    expect(parseMicrosoftProducts(recorded, ['BTQMHK78ZPF9'], NOW)).toEqual(
      new Map([['BTQMHK78ZPF9', { price: price(25_000, 25_000, 0), title: 'LIMBO' }]]),
    )
  })

  it('knows a product whose id the answer spells in lower case', () => {
    const answer = { Products: [microsoftProduct('btqmhk78zpf9', 250)] }

    expect(parseMicrosoftProducts(answer, ['BTQMHK78ZPF9'], NOW).get('BTQMHK78ZPF9')).toEqual({
      price: price(25_000, 25_000, 0),
      // A product that states no title is still a product, with its price.
      title: null,
    })
  })

  it('reads an answer with no products as "none of these is sold"', () => {
    expect(parseMicrosoftProducts({ Products: [] }, ['BTQMHK78ZPF9'], NOW)).toEqual(
      new Map([['BTQMHK78ZPF9', null]]),
    )
  })

  it.each([
    ['a list', [microsoftProduct('BTQMHK78ZPF9', 250)]],
    ['an object without products', { code: 'BadRequest', message: 'Invalid market' }],
    ['products that are not a list', { Products: 'none' }],
  ])('throws on an answer that is %s, rather than read it as "none is sold"', (_what, body) => {
    expect(() => parseMicrosoftProducts(body, ['BTQMHK78ZPF9'], NOW)).toThrow(
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
    expect(microsoftProductTitle(listing(inLanguage('pl-pl', 'Wiedźmin 3')))).toBe('Wiedźmin 3')
    expect(microsoftProductTitle(listing({ ProductTitle: 'LIMBO' }))).toBe('LIMBO')
  })

  it('prefers the Ukrainian listing, then an English one, should an answer carry several', () => {
    const english = inLanguage('en-US', 'The Witcher 3: Wild Hunt')
    const ukrainian = inLanguage('uk-UA', 'Відьмак 3: Дикий Гін')
    const polish = inLanguage('pl-PL', 'Wiedźmin 3: Dziki Gon')

    // The order the job asks for the languages in, and the page its offer links to.
    expect(microsoftProductTitle(listing(polish, english, ukrainian))).toBe('Відьмак 3: Дикий Гін')
    expect(microsoftProductTitle(listing(polish, english))).toBe('The Witcher 3: Wild Hunt')
    expect(microsoftProductTitle(listing(polish))).toBe('Wiedźmin 3: Dziki Gon')
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
