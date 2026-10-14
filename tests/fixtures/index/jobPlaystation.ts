import type { RawgStoreLink } from '../../../server/rawg/types'

/**
 * The PlayStation Store as the refresh job's tests serve it: hand-written answers in the shapes
 * the recorded ones beside this directory have (`tests/fixtures/playstation`), and small enough
 * to read — and the four games of the job catalog (`jobCatalog.ts`) that RAWG lists on that
 * store when a test asks for them (`createJobHarness({ playstation: true })`). The catalog itself
 * lists none there, so every test that is not about this store runs as it always did.
 *
 * | game | RAWG's link                                  | what it proves                          |
 * | ---- | -------------------------------------------- | --------------------------------------- |
 * | 101  | a PlayStation 5 product (`PPSA10100_00`)     | a game with a GOG offer already; free   |
 * |      |                                              | for everybody at Sony's                 |
 * | 103  | a PlayStation 3 product (`NPUB…`)            | listed there, asked, and no reference:  |
 * |      |                                              | found by the sweep, the game not being  |
 * |      |                                              | on Steam                                |
 * | 106  | a PlayStation 4 product (`CUSA10600_00`)     | a Steam game whose title comes with its |
 * |      |                                              | app id; on sale at Sony's, under the    |
 * |      |                                              | game's own name                         |
 * | 108  | a PlayStation 5 product (`PPSA10800_00`)     | at its regular price, and under another |
 * |      |                                              | product's name                          |
 *
 * Three games with a title, so that a Sony that fails every request fails three in a row.
 */

/** RAWG's own row for the store: its id there, and the slug the site knows it by. */
export const PLAYSTATION_STORE = {
  store: { id: 3, slug: 'playstation-store', name: 'PlayStation Store' },
}

export const JOB_PLAYSTATION_TITLES = {
  101: 'PPSA10100_00',
  106: 'CUSA10600_00',
  108: 'PPSA10800_00',
} as const
export const JOB_PLAYSTATION_CONCEPTS = { 101: 10_101, 106: 10_106, 108: 10_108 } as const

/** The games RAWG lists on the PlayStation Store in these tests, and the links it gives them. */
export const JOB_PLAYSTATION_LINKS: Record<number, RawgStoreLink[]> = {
  101: [
    {
      id: 30,
      store_id: 3,
      url: 'https://store.playstation.com/en-us/product/UP0001-PPSA10100_00-HOLLOWCRADLE0001',
    },
  ],
  103: [
    {
      id: 31,
      store_id: 3,
      url: 'https://store.playstation.com/en-us/product/UP0001-NPUB10300_00-PAPERHARBOUR0001',
    },
  ],
  106: [
    {
      id: 32,
      store_id: 3,
      // With the stray query one of RAWG's links was seen to carry.
      url: 'https://store.playstation.com/en-us/product/UP0001-CUSA10600_00-AMBERTRAIL000001?aaaa',
    },
  ],
  108: [
    {
      id: 33,
      store_id: 3,
      url: 'https://store.playstation.com/en-us/product/UP0001-PPSA10800_00-SILENTMERIDIAN01',
    },
  ],
}

/** Sony's code, in both endpoints, for a thing the store asked about does not have. */
export const SONY_NOT_IN_THE_STORE = 3166081

/** The catalog's answer about a title that belongs to a concept, cut to what the job reads. */
export function sonyConcept(conceptId: number, titleIds: readonly string[]) {
  return [{ id: conceptId, titleIds: [...titleIds] }]
}

/** Its answer about a title it has no concept for: every PlayStation 3 title, and any unknown id. */
export function sonyNoConcept(titleId: string, errorCode: number = SONY_NOT_IN_THE_STORE) {
  return [{ titleIds: [titleId], errorCode }]
}

export interface SonyPriceOptions {
  currency?: string
  /** Epoch milliseconds as Sony writes them, in a string; `null` for an entry with no end. */
  endTime?: string | null
  qualifications?: { type: string; value: string }[]
  /** Fields of `price` to put in place of the usual ones, for the shapes that are not a price. */
  price?: Record<string, unknown>
  upSellService?: string
}

/** One way of getting a product, as `webctas` lists it: its type, and the price that goes with it. */
export function sonyCta(
  type: string,
  basePriceValue: number,
  discountedValue: number,
  options: SonyPriceOptions = {},
) {
  return {
    type,
    meta: { upSellService: options.upSellService ?? 'NONE' },
    price: {
      applicability: 'APPLICABLE',
      basePriceValue,
      discountedValue,
      currencyCode: options.currency ?? 'UAH',
      endTime: options.endTime ?? null,
      isExclusive: false,
      isFree: discountedValue === 0,
      isTiedToSubscription: false,
      qualifications: options.qualifications ?? [],
      serviceBranding: ['NONE'],
      ...options.price,
    },
  }
}

/** The purchase anyone can make: `ADD_TO_CART`, at `discounted` kopecks against `base`. */
export function sonyPurchase(base: number, discounted: number = base, options?: SonyPriceOptions) {
  return sonyCta('ADD_TO_CART', base, discounted, options)
}

/** What stands beside the purchase of a game in the PlayStation Plus catalogue: a subscriber's zero. */
export function sonyPlusCatalogue(base: number) {
  return sonyCta('UPSELL_PS_PLUS_GAME_CATALOG', base, 0, {
    upSellService: 'PS_PLUS',
    qualifications: [{ type: 'ENTITLEMENT_IN_CART', value: 'SUB001-SUBC00002_00-TJ4KZ94GWFC3NYB0' }],
    price: { applicability: 'UPSELL', isTiedToSubscription: true, serviceBranding: ['PS_PLUS'] },
  })
}

/** A free trial of a paid game: free, for everybody, and not the game. */
export function sonyTrial() {
  return sonyCta('DOWNLOAD_TRIAL', 0, 0)
}

/** A game that is free for everybody. */
export function sonyFreeDownload() {
  return sonyCta('DOWNLOAD', 0, 0)
}

/** A concept's default product. */
export function sonyProduct(conceptId: number, id: string, name: string, webctas: unknown[]) {
  return { id, name, concept: { id: String(conceptId) }, webctas }
}

/** The storefront's answer about a concept: its default product, or `null` for a concept with none. */
export function sonyPrice(conceptId: number, defaultProduct: unknown) {
  return {
    data: { conceptRetrieve: { id: String(conceptId), defaultProduct, products: [] } },
  }
}

/** Its answer about a concept the Ukrainian store does not have. */
export function sonyNotInTheStore(conceptId: number, errorCode: number = SONY_NOT_IN_THE_STORE) {
  return {
    errors: [
      {
        message: `Concept not available for [${conceptId}, UA, uk]`,
        path: ['conceptRetrieve'],
        extensions: { statusCode: 404, errorCode },
      },
    ],
    data: { conceptRetrieve: null },
  }
}

/** When the sale on game 106 ends at Sony's: 2026-10-21T22:59:00Z, as one recorded sale did. */
export const JOB_PLAYSTATION_SALE_ENDS = '1792623540000'
export const JOB_PLAYSTATION_SALE_ENDS_AT = '2026-10-21T22:59:00.000Z'

export const JOB_PLAYSTATION_PRODUCTS = {
  101: 'EP0001-PPSA10101_00-HOLLOWCRADLE0001',
  106: 'EP0001-CUSA10601_00-AMBERTRAIL000001',
  108: 'EP0001-PPSA10801_00-SILENTMERIDIANDX',
} as const

/** What the job's fake Sony knows of titles, by title id; any other title has no concept. */
export const JOB_SONY_CONCEPTS: Record<string, unknown> = {
  PPSA10100_00: sonyConcept(10_101, ['PPSA10101_00', 'PPSA10100_00']),
  // The American title asked about comes back in a concept that lists it beside the European one.
  CUSA10600_00: sonyConcept(10_106, ['CUSA10601_00', 'CUSA10600_00']),
  PPSA10800_00: sonyConcept(10_108, ['PPSA10801_00', 'PPSA10800_00']),
}

/** What it knows of concepts, by concept id; any other concept is not in the store. */
export const JOB_SONY_PRICES: Record<string, unknown> = {
  // Free for everybody.
  10101: sonyPrice(
    10_101,
    sonyProduct(10_101, JOB_PLAYSTATION_PRODUCTS[101], 'Hollow Cradle', [sonyFreeDownload()]),
  ),
  // 799,00 ₴ at half price until the sale ends, with a trial and a subscriber's zero beside it.
  10106: sonyPrice(
    10_106,
    sonyProduct(10_106, JOB_PLAYSTATION_PRODUCTS[106], 'Amber Trail', [
      sonyTrial(),
      sonyPurchase(79_900, 39_950, { endTime: JOB_PLAYSTATION_SALE_ENDS }),
      sonyPlusCatalogue(79_900),
    ]),
  ),
  // 1 299,00 ₴, and the product Sony puts first is not the game by name.
  10108: sonyPrice(
    10_108,
    sonyProduct(10_108, JOB_PLAYSTATION_PRODUCTS[108], 'Silent Meridian: Deluxe Edition', [
      sonyPurchase(129_900),
    ]),
  ),
}
