/**
 * GOG's catalog, the Microsoft Store's display catalog and the National Bank's rate as the
 * refresh job's tests serve them: hand-written, in the shapes the recorded answers beside this
 * directory have (`tests/fixtures/gog`, `tests/fixtures/microsoft`, `tests/fixtures/nbu`), and
 * small enough to read.
 *
 * They go with `jobCatalog.ts`. Of its nine games two have a link to one of these stores, and
 * each is there to discriminate a rule:
 *
 * | game | link                                  | what it proves                              |
 * | ---- | ------------------------------------- | ------------------------------------------- |
 * | 101  | GOG, `hollow_cradle`                  | a Steam game with a dollar offer beside it, |
 * |      |                                       | under the game's own name                   |
 * | 109  | the Microsoft Store, `9NLOSTCANT0N`   | a game off Steam, found only by the sweep,  |
 * |      |                                       | with a hryvnia offer — for another edition  |
 * |      |                                       | than the game's name says                   |
 */

/** A GOG money pair as the catalog writes it: decimal strings, in the currency asked for. */
export function gogPrice(final: string, base: string, currency = 'USD') {
  const percent = Math.round((1 - Number(final) / Number(base)) * 100)
  return {
    final: `$${final}`,
    base: `$${base}`,
    discount: percent > 0 ? `-${percent}%` : null,
    finalMoney: { amount: final, currency, discount: '0.00' },
    baseMoney: { amount: base, currency },
  }
}

/** A slug as a title: `hollow_cradle` is "Hollow Cradle". */
function titleOf(slug: string): string {
  return slug
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** One product of GOG's catalog. `price: null` is a game GOG has not released yet. */
export function gogProduct(
  slug: string,
  price: ReturnType<typeof gogPrice> | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `gog-${slug}`,
    slug,
    productType: 'game',
    title: titleOf(slug),
    price,
    productState: price === null ? 'coming-soon' : 'default',
    storeLink: `https://www.gog.com/en/game/${slug}`,
    ...overrides,
  }
}

/** The catalog the job's fake GOG walks by default: three products, one of them game 101's. */
export const JOB_GOG_PRODUCTS = [
  gogProduct('amber_archive', gogPrice('4.99', '4.99')),
  gogProduct('hollow_cradle', gogPrice('9.99', '19.99')),
  gogProduct('zenith_run', null),
]

/** A page of `products`, as `catalog.gog.com/v1/catalog` answers one. */
export function gogCatalogPage(products: readonly unknown[], page: number, pageSize: number) {
  return {
    pages: Math.max(1, Math.ceil(products.length / pageSize)),
    currentlyShownProductCount: products.length,
    productCount: products.length,
    products: products.slice((page - 1) * pageSize, page * pageSize),
  }
}

/** The window every availability of these fixtures is valid in: all of 2026 and well past it. */
const OPEN_WINDOW = {
  StartDate: '2026-01-01T00:00:00.0000000Z',
  EndDate: '9998-12-30T00:00:00.0000000Z',
}

export interface MicrosoftAvailabilityOptions {
  actions?: string[]
  currency?: string
  markets?: string[]
  conditions?: { StartDate?: unknown; EndDate?: unknown }
  extra?: Record<string, unknown>
}

/** One availability: by default the one anyone in Ukraine can buy at. */
export function microsoftAvailability(
  list: number,
  msrp: number,
  options: MicrosoftAvailabilityOptions = {},
) {
  return {
    Actions: options.actions ?? ['Details', 'Fulfill', 'Purchase', 'Browse', 'Curate', 'Redeem'],
    Conditions: options.conditions ?? OPEN_WINDOW,
    Markets: options.markets ?? ['UA'],
    OrderManagementData: {
      Price: { CurrencyCode: options.currency ?? 'UAH', ListPrice: list, MSRP: msrp },
    },
    ...options.extra,
  }
}

/** What stands beside a real price on every game in Game Pass: the subscriber's, at zero. */
export function microsoftSubscriberAvailability() {
  return microsoftAvailability(0, 0, {
    actions: ['Details', 'Purchase', 'Curate'],
    extra: {
      RemediationRequired: true,
      Remediations: [{ RemediationId: '9ZNPVF4DTWVC', Type: 'Upsell', BigId: 'CFQ7TTC0KGQ8' }],
    },
  })
}

/** One SKU of a product: `full` unless told otherwise. */
export function microsoftSku(availabilities: unknown[], type: 'full' | 'trial' = 'full') {
  return {
    Sku: {
      SkuId: type === 'full' ? '0010' : '0011',
      SkuType: type,
      Properties: { IsTrial: type === 'trial', IsPreOrder: false, IsBundle: false },
    },
    Availabilities: availabilities,
  }
}

/**
 * A product sold in Ukraine at `list`, regularly `msrp`, with the subscriber's zero beside it and
 * — when it is given a title — the one listing Microsoft answers with, in English.
 */
export function microsoftProduct(id: string, list: number, msrp: number = list, title?: string) {
  return {
    ProductId: id,
    ...(title === undefined
      ? {}
      : { LocalizedProperties: [{ ProductTitle: title, Language: 'en-us' }] }),
    DisplaySkuAvailabilities: [
      microsoftSku([microsoftAvailability(list, msrp), microsoftSubscriberAvailability()]),
    ],
  }
}

/** The product id game 109's link names, and what the job's fake store answers about it. */
export const JOB_MICROSOFT_ID = '9NLOSTCANT0N'

/** What the store calls it: not the game's name, "Lost Canton", but an edition of it. */
export const JOB_MICROSOFT_TITLE = 'Lost Canton: Definitive Edition'

export const JOB_MICROSOFT_PRODUCTS: Record<string, unknown> = {
  [JOB_MICROSOFT_ID]: microsoftProduct(JOB_MICROSOFT_ID, 385, 385, JOB_MICROSOFT_TITLE),
}

/** The rate the job's fake bank answers, for whatever day it is asked about. */
export const JOB_BANK_RATE = 44.9567

/** The bank's answer for one day (`YYYY-MM-DD`), as `statdirectory/exchange` gives it. */
export function bankAnswer(date: string, rate: number = JOB_BANK_RATE) {
  return [
    {
      r030: 840,
      txt: 'Долар США',
      rate,
      cc: 'USD',
      exchangedate: date.split('-').reverse().join('.'),
      special: 'N',
    },
  ]
}
