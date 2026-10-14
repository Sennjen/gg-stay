import { describe, expect, it } from 'vitest'
import { parseGogCatalogPage } from '../../../scripts/index/gog'
import { MICROSOFT_DETAIL_IDS_PER_REQUEST } from '../../../scripts/index/microsoft'
import {
  findGogProduct,
  findMicrosoftProducts,
  gogSellables,
  isMicrosoftSearchDue,
  MICROSOFT_BUNDLES_PER_PRODUCT,
  MICROSOFT_FALLBACK_BUDGET_MS,
  MICROSOFT_FALLBACK_MAX_FAILURES,
  MICROSOFT_PARENTS_PER_PRODUCT,
  MICROSOFT_SEARCH_AGAIN_MS,
  MICROSOFT_SEARCHES_PER_RUN,
  usableFallbacks,
  withGogFound,
  withMicrosoftFallback,
  type MicrosoftTarget,
} from '../../../scripts/index/storeFallbacks'
import type { IndexedStoreRefs } from '../../../server/index/document'
import { UpstreamError } from '../../../server/upstream/errors'
import {
  gogCatalogPage,
  gogPrice,
  gogProduct,
  microsoftDetail,
  microsoftProduct,
  microsoftSearchAnswer,
} from '../../fixtures/index/jobStores'
import recordedCatalog from '../../fixtures/gog/catalog.json' with { type: 'json' }
import recordedDetails from '../../fixtures/microsoft/details.json' with { type: 'json' }
import recordedFound from '../../fixtures/microsoft/products-found.json' with { type: 'json' }
import searchDoomEternal from '../../fixtures/microsoft/search-doom-eternal.json' with { type: 'json' }
import searchDoom from '../../fixtures/microsoft/search-doom.json' with { type: 'json' }
import searchGta from '../../fixtures/microsoft/search-grand-theft-auto-v.json' with { type: 'json' }
import searchNothing from '../../fixtures/microsoft/search-nothing.json' with { type: 'json' }
import searchPrey from '../../fixtures/microsoft/search-prey.json' with { type: 'json' }
import searchVillage from '../../fixtures/microsoft/search-resident-evil-village.json' with { type: 'json' }
import { createJobHarness, type JobHarness } from './harness'

/**
 * The ways to a game's product that are not RAWG's link: GOG's catalog looked through by the
 * game's name, and the Microsoft Store's relations and search. The worlds here are the recorded
 * answers of 2026-10-13 where a rule can be shown on them, and hand-written ones in the same
 * shapes where it takes a case the stores did not happen to have that day.
 */

const DAY = 86_400_000

/** A moment inside every window the recorded answers state. */
const RECORDED_AT = '2026-10-13T10:40:00.000Z'

describe('what a record remembers of the stores’ own ways', () => {
  const FOUND_AT = '2026-10-13T03:00:00.000Z'
  const gog = { slug: 'hollow_cradle_gold', via: 'edition' as const, foundAt: FOUND_AT }
  const product = {
    id: '9N2S04LGXXH4',
    name: 'resident-evil-village',
    via: 'relation' as const,
    foundAt: FOUND_AT,
  }
  const microsoft = { searchedAt: FOUND_AT, found: product }
  const stored = (fallbacks: unknown) => ({ fallbacks }) as IndexedStoreRefs

  it('reads what this job wrote', () => {
    expect(usableFallbacks(stored({ gog, microsoft }))).toEqual({
      gog,
      microsoft: { found: product, searchedAt: FOUND_AT },
    })
  })

  it('reads a game that was searched for and not found: the date, and no product', () => {
    expect(usableFallbacks(stored({ microsoft: { searchedAt: FOUND_AT } }))).toEqual({
      gog: null,
      microsoft: { found: null, searchedAt: FOUND_AT },
    })
  })

  it('reads nothing from a record without any: every record written before this', () => {
    const nothing = { gog: null, microsoft: { found: null, searchedAt: null } }

    expect(usableFallbacks(undefined)).toEqual(nothing)
    expect(usableFallbacks({})).toEqual(nothing)
    expect(usableFallbacks({ gog: 'limbo', microsoft: null })).toEqual(nothing)
    for (const junk of [null, 'gog', 7, [gog]]) {
      expect(usableFallbacks(stored(junk))).toEqual(nothing)
    }
  })

  it.each([
    ['a slug that is not a slug', { ...gog, slug: 'hollow_cradle&countryCode=US' }],
    ['a slug in capitals', { ...gog, slug: 'Hollow_Cradle' }],
    ['no slug', { via: 'edition', foundAt: FOUND_AT }],
    ['a way that is not a way of GOG’s', { ...gog, via: 'relation' }],
    ['RAWG’s link for a way', { ...gog, via: 'link' }],
    ['a date that is not one', { ...gog, foundAt: 'yesterday' }],
    ['no date', { slug: gog.slug, via: gog.via }],
    ['text', 'hollow_cradle_gold'],
  ])('takes nothing of GOG’s on trust: %s is no product', (_what, value) => {
    expect(usableFallbacks(stored({ gog: value, microsoft })).gog).toBeNull()
    // What is wrong with one store's part says nothing of the other's.
    expect(usableFallbacks(stored({ gog: value, microsoft })).microsoft.found).toEqual(product)
  })

  it.each([
    ['an id that would change the request', { ...product, id: '9N2S04LGXXH4&market=US' }],
    ['an id in lower case', { ...product, id: '9n2s04lgxxh4' }],
    ['an id of eleven characters', { ...product, id: '9N2S04LGXXH' }],
    ['a name that is a path', { ...product, name: 'village/../x' }],
    ['no name', { id: product.id, via: product.via, foundAt: FOUND_AT }],
    ['a way that is not one', { ...product, via: 'guess' }],
    ['RAWG’s link for a way', { ...product, via: 'link' }],
    ['a date that is not one', { ...product, foundAt: 7 }],
    ['text', '9N2S04LGXXH4'],
  ])('takes nothing of Microsoft’s on trust: %s is no product', (_what, found) => {
    const usable = usableFallbacks(stored({ gog, microsoft: { searchedAt: FOUND_AT, found } }))

    expect(usable.microsoft.found).toBeNull()
    // The game was searched for all the same: a product that cannot be read is not found again
    // every run for it.
    expect(usable.microsoft.searchedAt).toBe(FOUND_AT)
    expect(usable.gog).toEqual(gog)
  })

  it('reads a date of a search it cannot read as never searched, and keeps the product', () => {
    for (const searchedAt of [undefined, null, 'last week', 20261013, {}]) {
      expect(
        usableFallbacks(stored({ microsoft: { searchedAt, found: product } })).microsoft,
      ).toEqual({ found: product, searchedAt: null })
    }
  })

  it('puts what was found beside RAWG’s link, and never in its place', () => {
    const rawg: IndexedStoreRefs = {
      gog: 'hollow_cradle',
      microsoft: { id: '9MTNPF414F65', name: 'resident-evil-village' },
    }

    const withGog = withGogFound(rawg, gog)
    const withBoth = withMicrosoftFallback(withGog, microsoft)

    expect(withGog).toEqual({ ...rawg, fallbacks: { gog } })
    expect(withBoth).toEqual({ ...rawg, fallbacks: { gog, microsoft } })
    // The record it was made from is not the one that is changed.
    expect(rawg).toEqual({
      gog: 'hollow_cradle',
      microsoft: { id: '9MTNPF414F65', name: 'resident-evil-village' },
    })
    expect(withGog.fallbacks).not.toHaveProperty('microsoft')
  })

  it('keeps a store RAWG gave no link for as RAWG’s answer: `null` stays `null`', () => {
    const record = withMicrosoftFallback({ gog: null, microsoft: null }, microsoft)

    expect(record).toEqual({ gog: null, microsoft: null, fallbacks: { microsoft } })
  })

  it('keeps whatever else a record holds: another build’s fields are not this one’s to drop', () => {
    const record = {
      gog: null,
      links: ['https://www.gog.com/game/hollow_cradle'],
      playstation: { id: 'UP0001' },
      fallbacks: { playstation: { searchedAt: FOUND_AT } },
    } as IndexedStoreRefs

    expect(withGogFound(record, gog)).toEqual({
      ...record,
      fallbacks: { playstation: { searchedAt: FOUND_AT }, gog },
    })
  })

  it('replaces what a store’s way found before, and leaves the other store’s', () => {
    const before = withMicrosoftFallback(withGogFound({ gog: 'hollow_cradle' }, gog), microsoft)
    const cheaper = { slug: 'hollow_cradle_goty', via: 'edition' as const, foundAt: RECORDED_AT }

    expect(withGogFound(before, cheaper)).toEqual({
      gog: 'hollow_cradle',
      fallbacks: { gog: cheaper, microsoft },
    })
    expect(withMicrosoftFallback(before, { searchedAt: RECORDED_AT })).toEqual({
      gog: 'hollow_cradle',
      fallbacks: { gog, microsoft: { searchedAt: RECORDED_AT } },
    })
  })

  it('writes nothing where nothing was found: no empty field is left behind', () => {
    const found = withGogFound({ gog: 'hollow_cradle' }, gog)

    expect(withGogFound(found, null)).toEqual({ gog: 'hollow_cradle' })
    expect(withGogFound({ gog: 'hollow_cradle' }, null)).toEqual({ gog: 'hollow_cradle' })
    expect(withGogFound(withMicrosoftFallback(found, microsoft), null)).toEqual({
      gog: 'hollow_cradle',
      fallbacks: { microsoft },
    })
  })
})

describe('the thirty days a game is left alone for', () => {
  const now = Date.parse(RECORDED_AT)
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('is thirty days, and "more than"', () => {
    expect(MICROSOFT_SEARCH_AGAIN_MS).toBe(30 * DAY)
    expect(isMicrosoftSearchDue(ago(30 * DAY), now)).toBe(false)
    expect(isMicrosoftSearchDue(ago(30 * DAY + 1), now)).toBe(true)
    expect(isMicrosoftSearchDue(ago(12 * 3_600_000), now)).toBe(false)
    expect(isMicrosoftSearchDue(ago(29 * DAY), now)).toBe(false)
  })

  it('is due for a game that was never searched for, or whose date cannot be read', () => {
    expect(isMicrosoftSearchDue(null, now)).toBe(true)
    expect(isMicrosoftSearchDue('last month', now)).toBe(true)
    // A date ahead of the clock would otherwise keep the game waiting for ever.
    expect(isMicrosoftSearchDue(new Date(now + 1).toISOString(), now)).toBe(true)
  })
})

describe('findGogProduct', () => {
  /** A catalog of `products` as a walk hands it over. */
  const catalogOf = (...products: unknown[]) =>
    gogSellables(parseGogCatalogPage(gogCatalogPage(products, 1, 100)).products)

  const WITCHER = { name: 'The Witcher 3: Wild Hunt', released: '2015-05-18' }
  const CRADLE = { name: 'Hollow Cradle', released: '2021-03-11' }

  /** A product under `title`; a game released with Hollow Cradle unless told otherwise. */
  const titled = (
    slug: string,
    title: string,
    final: string,
    overrides: Record<string, unknown> = {},
  ) => gogProduct(slug, gogPrice(final, final), { title, releaseDate: '2021.03.11', ...overrides })

  it('finds The Witcher 3 in the recorded catalog, under the edition GOG sells it as', () => {
    // RAWG's slug, `the_witcher_3_wild_hunt`, is not in GOG's catalog for Ukraine any more.
    const recorded = gogSellables(parseGogCatalogPage(recordedCatalog).products)

    expect(findGogProduct(recorded, WITCHER)).toMatchObject({
      via: 'edition',
      product: {
        slug: 'the_witcher_3_wild_hunt_game_of_the_year_edition',
        type: 'pack',
        title: 'The Witcher 3: Wild Hunt — Remastered',
        price: { amount: 1749, regularAmount: 3499, discountPercent: 50 },
        url: 'https://www.gog.com/en/game/the_witcher_3_wild_hunt_game_of_the_year_edition',
      },
    })
    // Not the REDkit, which only begins like the name, and not a pack GOG has no price for yet.
    expect(recorded.map(({ product }) => product.slug)).toEqual([
      'the_witcher_3_redkit',
      'the_witcher_3_wild_hunt_game_of_the_year_edition',
    ])
  })

  it('finds a game under its own name', () => {
    const catalog = catalogOf(
      titled('amber_archive', 'Amber Archive', '4.99'),
      titled('hollow_cradle_2021', 'HOLLOW CRADLE™', '9.99'),
    )

    expect(findGogProduct(catalog, CRADLE)).toMatchObject({
      via: 'name',
      product: { slug: 'hollow_cradle_2021', price: { amount: 999 } },
    })
  })

  it('takes the product under the name before an edition, though the edition is cheaper', () => {
    const catalog = catalogOf(
      titled('hollow_cradle_gold', 'Hollow Cradle - Gold Edition', '4.99', { productType: 'pack' }),
      titled('hollow_cradle_2021', 'Hollow Cradle', '19.99'),
    )

    expect(findGogProduct(catalog, CRADLE)).toMatchObject({
      via: 'name',
      product: { slug: 'hollow_cradle_2021' },
    })
  })

  it('takes a pack for an edition, and never for the game’s bare name', () => {
    const pack = { productType: 'pack' }

    // A pack under the bare name is the game with something else: no product, and no edition.
    expect(
      findGogProduct(
        catalogOf(titled('hollow_cradle_pack', 'Hollow Cradle', '9.99', pack)),
        CRADLE,
      ),
    ).toBeNull()
    expect(
      findGogProduct(
        catalogOf(
          titled('hollow_cradle_complete', 'Hollow Cradle: Complete Edition', '9.99', pack),
        ),
        CRADLE,
      ),
    ).toMatchObject({ via: 'edition', product: { slug: 'hollow_cradle_complete', type: 'pack' } })
    // A game is as good an edition as a pack.
    expect(
      findGogProduct(
        catalogOf(titled('hollow_cradle_enhanced', 'Hollow Cradle Enhanced Edition', '9.99')),
        CRADLE,
      ),
    ).toMatchObject({ via: 'edition', product: { type: 'game' } })
  })

  it('takes the cheapest of several that qualify, and the same one when two cost the same', () => {
    const editions = [
      titled('hollow_cradle_ultimate', 'Hollow Cradle - Ultimate Edition', '29.99'),
      titled('hollow_cradle_gold', 'Hollow Cradle - Gold Edition', '14.99'),
      titled('hollow_cradle_definitive', 'Hollow Cradle: Definitive Edition', '14.99'),
    ]

    expect(findGogProduct(catalogOf(...editions), CRADLE)?.product.slug).toBe(
      'hollow_cradle_definitive',
    )
    expect(findGogProduct(catalogOf(...editions.reverse()), CRADLE)?.product.slug).toBe(
      'hollow_cradle_definitive',
    )
    // Two games under the name itself: the cheaper, where the first rule said "neither".
    const twins = catalogOf(
      titled('hollow_cradle_a', 'Hollow Cradle', '19.99'),
      titled('hollow_cradle_b', 'Hollow Cradle', '9.99'),
    )
    expect(findGogProduct(twins, CRADLE)).toMatchObject({
      via: 'name',
      product: { slug: 'hollow_cradle_b' },
    })
  })

  it('takes the price a sale has made the lowest, not the lowest regular price', () => {
    const catalog = catalogOf(
      gogProduct('hollow_cradle_gold', gogPrice('9.99', '39.99'), {
        title: 'Hollow Cradle - Gold Edition',
      }),
      titled('hollow_cradle_enhanced', 'Hollow Cradle - Enhanced Edition', '14.99'),
    )

    expect(findGogProduct(catalog, CRADLE)?.product.slug).toBe('hollow_cradle_gold')
  })

  it.each([
    ['another game', 'Hollow Cradle 2'],
    ['a subtitle', 'Hollow Cradle: Aftermath'],
    ['a word the list does not have', 'Hollow Cradle Deluxe Edition'],
    ['a longer name that only begins like it', 'Hollow Cradles'],
    ['the name with something in front', 'The Hollow Cradle'],
  ])('finds nothing under %s', (_what, title) => {
    expect(findGogProduct(catalogOf(titled('other', title, '9.99')), CRADLE)).toBeNull()
  })

  it('finds nothing in a product GOG is not selling, or that is of no kind it knows', () => {
    const named = (overrides: Record<string, unknown>, price = gogPrice('9.99', '9.99')) =>
      catalogOf(gogProduct('hollow_cradle_2021', price, { title: 'Hollow Cradle', ...overrides }))

    expect(findGogProduct(named({}), CRADLE)).not.toBeNull()
    expect(findGogProduct(named({}, null as never), CRADLE)).toBeNull()
    expect(findGogProduct(named({}, gogPrice('9.99', '9.99', 'EUR')), CRADLE)).toBeNull()
    expect(findGogProduct(named({ storeLink: 'https://example.org/' }), CRADLE)).toBeNull()
    expect(findGogProduct(named({ productType: 'dlc' }), CRADLE)).toBeNull()
    expect(findGogProduct(named({ productType: 'extras' }), CRADLE)).toBeNull()
    expect(findGogProduct(named({ productType: undefined }), CRADLE)).toBeNull()
  })

  it('refuses a product released more than a year before the game: another game of the name', () => {
    const released = (releaseDate: unknown) =>
      findGogProduct(
        catalogOf(titled('hollow_cradle_2021', 'Hollow Cradle', '9.99', { releaseDate })),
        CRADLE,
      )

    expect(released('2005.06.01')).toBeNull()
    expect(released('2020.03.10')).toBeNull()
    // A year before the game to the day, the game's own day, and any day after it.
    expect(released('2020.03.11')).not.toBeNull()
    expect(released('2021.03.11')).not.toBeNull()
    expect(released('2026.01.20')).not.toBeNull()
    // The catalog gave no date: the product is not held to one.
    expect(released(null)).not.toBeNull()
  })

  it('finds nothing for a game the index has no release date for, or no name', () => {
    const catalog = catalogOf(titled('hollow_cradle_2021', 'Hollow Cradle', '9.99'))

    expect(findGogProduct(catalog, { name: 'Hollow Cradle', released: null })).toBeNull()
    expect(findGogProduct(catalog, { name: ' ™ ', released: '2021-03-11' })).toBeNull()
    expect(findGogProduct([], CRADLE)).toBeNull()
  })
})

/** A product id as the catalog spells one, for hand-written worlds: `9N0000000007`. */
const pid = (number: number) => `9N${String(number).padStart(10, '0')}`

const target = (
  id: number,
  name: string,
  link: string | null,
  released: string | null = '2021-03-11',
): MicrosoftTarget => ({
  game: { id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, released },
  link: link === null ? null : { id: link, name: 'as-rawg-has-it' },
})

/** The recorded answers as the fake store serves them: by product id, and by the name searched. */
function recordedWorld(): JobHarness {
  const harness = createJobHarness({ start: RECORDED_AT })
  for (const product of recordedDetails.Products)
    harness.microsoftDetails[product.ProductId] = product
  for (const key of Object.keys(harness.microsoftProducts)) {
    Reflect.deleteProperty(harness.microsoftProducts, key)
  }
  for (const product of recordedFound.Products)
    harness.microsoftProducts[product.ProductId] = product
  Object.assign(harness.microsoftSearches, {
    Prey: searchPrey,
    DOOM: searchDoom,
    'DOOM Eternal': searchDoomEternal,
    'Grand Theft Auto V': searchGta,
    'Resident Evil Village': searchVillage,
    'No Such Game': searchNothing,
  })
  return harness
}

describe('findMicrosoftProducts: the store’s own relations', () => {
  const VILLAGE = target(1, 'Resident Evil Village', '9MTNPF414F65', '2021-05-07')

  it('finds Resident Evil Village on the recorded answers: parent, same group, bundle', async () => {
    const harness = recordedWorld()

    const result = await findMicrosoftProducts(harness.deps, [VILLAGE])

    expect(result).toEqual({
      settled: new Map([
        [
          1,
          {
            id: '9N2S04LGXXH4',
            name: 'resident-evil-village',
            via: 'relation',
            product: {
              price: { amount: 119_900, regularAmount: 119_900, discountPercent: 0 },
              title: 'Resident Evil Village',
              group: 'db97de36-8e9e-4a95-a5fd-d88bfbdd220b',
              releasedAt: Date.parse('2026-01-20T00:00:00.000Z'),
            },
            readAt: RECORDED_AT,
          },
        ],
      ]),
      requests: 3,
      stopped: null,
    })
    // The linked product, then what it was made of, with nothing filtered out.
    expect(harness.microsoftDetailBatches).toEqual([
      ['9MTNPF414F65'],
      ['9MW7MFV29CMF', '9N19JBMWKSPT', '9N1HZ1PWLXTV', '9N2TRSW63FM2'],
    ])
    // Then the bundles of the parts that are in the game's own group — never the linked product
    // itself, and nothing of the game that only came with it.
    const [bundles] = harness.microsoftBatches
    expect(harness.microsoftBatches).toHaveLength(1)
    expect(bundles).toHaveLength(15)
    expect(bundles).toContain('9N2S04LGXXH4')
    expect(bundles).not.toContain('9MTNPF414F65')
    expect(bundles).not.toContain('9P5376CHNTMX')
    // The relations found it: the store is not searched for the game as well.
    expect(harness.microsoftSearchNames).toEqual([])
    expect(harness.calls).toHaveLength(0)
  })

  it('takes the product under the linked product’s own title, not a cheaper edition beside it', async () => {
    const harness = recordedWorld()

    const { settled } = await findMicrosoftProducts(harness.deps, [VILLAGE])

    // The Gold Edition is in the same group and on sale for less than half; it is not the game.
    expect(settled.get(1)).toMatchObject({
      id: '9N2S04LGXXH4',
      product: { title: 'Resident Evil Village' },
    })
  })

  /** A linked bundle `link` made of one `part`, whose bundles are `siblings`. */
  function chain(siblings: unknown[], overrides: { link?: unknown; part?: unknown } = {}) {
    const harness = createJobHarness({ start: RECORDED_AT })
    const ids = siblings.map((sibling) => (sibling as { ProductId: string }).ProductId)
    harness.microsoftDetails[pid(1)] =
      overrides.link ??
      microsoftDetail(pid(1), 'Hollow Cradle', { group: 'cradle', parents: [pid(2)] })
    harness.microsoftDetails[pid(2)] =
      overrides.part ?? microsoftDetail(pid(2), 'Hollow Cradle', { group: 'cradle', bundles: ids })
    for (const sibling of siblings) {
      harness.microsoftProducts[(sibling as { ProductId: string }).ProductId] = sibling
    }
    return harness
  }
  const CRADLE = target(101, 'Hollow Cradle', pid(1))
  const sibling = (number: number, list: number, title = 'Hollow Cradle', group = 'cradle') =>
    microsoftProduct(pid(number), list, list, title, { group })

  it('takes the cheapest of several under that title', async () => {
    const harness = chain([sibling(11, 899), sibling(12, 499), sibling(13, 499), sibling(14, 1299)])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toMatchObject({
      id: pid(12),
      via: 'relation',
      product: { price: { amount: 49_900 } },
    })
  })

  it('is judged by the linked product’s title, whatever the game is called at RAWG', async () => {
    const harness = chain([sibling(11, 899, 'Hollow Cradle — Standard Edition')], {
      link: microsoftDetail(pid(1), 'Hollow Cradle - Standard Edition', {
        group: 'cradle',
        parents: [pid(2)],
      }),
    })

    const { settled } = await findMicrosoftProducts(harness.deps, [
      target(101, 'Hollow Cradle (2021)', pid(1)),
    ])

    expect(settled.get(101)).toMatchObject({
      id: pid(11),
      name: 'hollow-cradle--standard-edition',
      via: 'relation',
    })
  })

  it.each([
    ['under another title', [sibling(11, 899, 'Hollow Cradle Gold Edition')]],
    ['in another group', [sibling(11, 899, 'Hollow Cradle', 'another-game')]],
    ['in no group', [microsoftProduct(pid(11), 899, 899, 'Hollow Cradle')]],
    ['that nobody can buy', []],
  ])(
    'finds nothing by relation in a bundle %s, and goes on to the search',
    async (_what, siblings) => {
      const harness = chain(siblings)
      // What the search would find, were it the first way: it is asked second, and only now.
      harness.microsoftDetails[pid(2)] = microsoftDetail(pid(2), 'Hollow Cradle', {
        group: 'cradle',
        bundles: [pid(11)],
      })

      const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

      expect(settled.get(101)).toBeNull()
      expect(harness.microsoftSearchNames).toEqual(['Hollow Cradle'])
    },
  )

  it('follows only the parts that are in the linked product’s own group', async () => {
    const harness = chain([sibling(11, 899)], {
      link: microsoftDetail(pid(1), 'Hollow Cradle', {
        group: 'cradle',
        parents: [pid(2), pid(3)],
      }),
      part: microsoftDetail(pid(2), 'Hollow Cradle', { group: 'cradle', bundles: [pid(11)] }),
    })
    // A second game that came in the same bundle, and the bundles that one is in.
    harness.microsoftDetails[pid(3)] = microsoftDetail(pid(3), 'Amber Archive', {
      group: 'archive',
      bundles: [pid(21), pid(22)],
    })

    await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(harness.microsoftBatches).toEqual([[pid(11)]])
  })

  it.each([
    ['has no parent', microsoftDetail(pid(1), 'Hollow Cradle', { group: 'cradle' })],
    ['is in no group', microsoftDetail(pid(1), 'Hollow Cradle', { parents: [pid(2)] })],
    ['has no title', { ...microsoftDetail(pid(1), '', { group: 'cradle', parents: [pid(2)] }) }],
  ])('follows nothing for a linked product that %s', async (_what, link) => {
    const harness = chain([sibling(11, 899)], { link })

    const { settled, requests } = await findMicrosoftProducts(harness.deps, [CRADLE])

    // One request for the linked product, one search, and no product was asked about.
    expect(harness.microsoftDetailBatches).toEqual([[pid(1)]])
    expect(harness.microsoftBatches).toEqual([])
    expect(harness.microsoftSearchNames).toEqual(['Hollow Cradle'])
    expect(settled.get(101)).toBeNull()
    expect(requests).toBe(2)
  })

  it('follows nothing for a product Microsoft does not know', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(harness.microsoftDetailBatches).toEqual([[pid(1)]])
    expect(settled.get(101)).toBeNull()
  })

  it('follows a product’s first eight parents and first forty bundles, and no further', async () => {
    expect([MICROSOFT_PARENTS_PER_PRODUCT, MICROSOFT_BUNDLES_PER_PRODUCT]).toEqual([8, 40])
    const parents = Array.from({ length: 12 }, (_, index) => pid(100 + index))
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.microsoftDetails[pid(1)] = microsoftDetail(pid(1), 'Hollow Cradle', {
      group: 'cradle',
      parents,
    })
    parents.forEach((parent, index) => {
      // Ten bundles each, none shared: the first four parents fill the forty.
      const bundles = Array.from({ length: 10 }, (_, bundle) => pid(1000 + index * 10 + bundle))
      harness.microsoftDetails[parent] = microsoftDetail(parent, 'A part', {
        group: 'cradle',
        bundles,
      })
    })

    await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(harness.microsoftDetailBatches).toEqual([[pid(1)], parents.slice(0, 8)])
    expect(harness.microsoftBatches).toEqual([
      Array.from({ length: 40 }, (_, bundle) => pid(1000 + bundle)),
    ])
  })

  it('asks about twenty products a request with nothing filtered out, and each once', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    const targets = Array.from({ length: 45 }, (_, index) =>
      // Two games in three name a product of their own; every third shares the one before it.
      target(index + 1, `Game ${index + 1}`, pid(index % 3 === 2 ? index : index + 1)),
    )

    await findMicrosoftProducts(harness.deps, targets)

    expect(MICROSOFT_DETAIL_IDS_PER_REQUEST).toBe(20)
    expect(harness.microsoftDetailBatches.map((batch) => batch.length)).toEqual([20, 10])
    expect(new Set(harness.microsoftDetailBatches.flat()).size).toBe(30)
  })

  it('does not search for a game whose relations could not be read: the order of the ways is the rule', async () => {
    const harness = chain([sibling(11, 899)])
    harness.failMicrosoftDetailsWith(pid(1))
    harness.microsoftSearches['Hollow Cradle'] = microsoftSearchAnswer([
      { id: pid(11), title: 'Hollow Cradle' },
    ])

    const result = await findMicrosoftProducts(harness.deps, [
      CRADLE,
      target(102, 'Amber Archive', null),
    ])

    // Not settled, so nothing is remembered of it and the next run tries again. The game beside
    // it, which has no link to read relations from, is searched for as on any day.
    expect(result.settled.has(101)).toBe(false)
    expect(result.settled.get(102)).toBeNull()
    expect(harness.microsoftSearchNames).toEqual(['Amber Archive'])
    expect(result).toMatchObject({
      requests: 2,
      stopped: null,
      error: 'MICROSOFT upstream failure',
    })
  })

  it('does not settle a game when the read of its parts, or of their bundles, failed', async () => {
    const parts = chain([sibling(11, 899)])
    parts.failMicrosoftDetailsWith(pid(2))
    const bundles = chain([sibling(11, 899)])
    bundles.failMicrosoftBatchWith(pid(11))

    for (const harness of [parts, bundles]) {
      const result = await findMicrosoftProducts(harness.deps, [CRADLE])

      expect(result.settled.size).toBe(0)
      expect(harness.microsoftSearchNames).toEqual([])
    }
  })
})

describe('findMicrosoftProducts: the store’s search', () => {
  const PREY = target(1, 'Prey', null, '2017-05-05')
  const GTA = target(2, 'Grand Theft Auto V', null, '2013-09-17')
  const DOOM_ETERNAL = target(3, 'DOOM Eternal', null, '2020-03-20')
  const DOOM = target(4, 'DOOM', null, '2016-05-13')
  const NOTHING = target(5, 'No Such Game', null)
  const VILLAGE = target(6, 'Resident Evil Village', null, '2021-05-07')

  it('finds the games the recorded searches found, each by the way that found it', async () => {
    const harness = recordedWorld()

    const result = await findMicrosoftProducts(harness.deps, [
      PREY,
      GTA,
      DOOM_ETERNAL,
      DOOM,
      NOTHING,
      VILLAGE,
    ])

    const found = [...result.settled].map(([id, find]) => [
      id,
      find && [find.via, find.id, find.name, find.product.title, find.product.price.amount],
    ])
    expect(found).toEqual([
      // A search that found only other games, and one that found nothing, need no price read.
      [4, null],
      [5, null],
      [1, ['name', '9PBC1QFBW563', 'prey', 'Prey', 61_000]],
      // No product is called "Grand Theft Auto V": the game is sold as an edition of itself.
      [
        2,
        [
          'edition',
          '9NXFX68ZNKK0',
          'grand-theft-auto-v-enhanced-pc',
          'Grand Theft Auto V Enhanced (PC)',
          67_450,
        ],
      ],
      // The Standard Edition at 895 ₴; the Deluxe Edition beside it at 1 490 ₴ is not the game.
      [
        3,
        [
          'edition',
          '9PK09BL31FK1',
          'doom-eternal-standard-edition-pc',
          'DOOM Eternal Standard Edition (PC)',
          89_500,
        ],
      ],
      // Under the name itself at 1 199 ₴, though the Gold Edition is on sale for 494,70 ₴.
      [6, ['name', '9N2S04LGXXH4', 'resident-evil-village', 'Resident Evil Village', 119_900]],
    ])
    expect(harness.microsoftSearchNames).toEqual([
      'Prey',
      'Grand Theft Auto V',
      'DOOM Eternal',
      'DOOM',
      'No Such Game',
      'Resident Evil Village',
    ])
    // Six searches, and one read of the prices of what four of them found. Nothing filtered out
    // was asked for: none of these games has a product to read relations from.
    expect(result).toMatchObject({ requests: 7, stopped: null })
    expect(harness.microsoftDetailBatches).toEqual([])
    expect(harness.calls).toHaveLength(0)
  })

  it('reads the price only of what a title could be the game by', async () => {
    const harness = recordedWorld()

    await findMicrosoftProducts(harness.deps, [PREY, GTA, DOOM_ETERNAL, DOOM, VILLAGE])

    expect(harness.microsoftBatches).toEqual([
      [
        // Not the Digital Deluxe Edition.
        '9PBC1QFBW563',
        // Both products called "Grand Theft Auto V Enhanced (PC)"; not Legacy, not the bundle
        // with a payment card.
        '9NXFX68ZNKK0',
        '9MSRG7MN6SP6',
        // Not the Deluxe Edition, the add-ons or BATTLEMODE.
        '9PK09BL31FK1',
        // All three of them: the game, its Gold Edition, and the game inside the bundles.
        '9N2S04LGXXH4',
        '9N7T25ZJJQ9T',
        '9MW7MFV29CMF',
      ],
    ])
  })

  /** A world where the search for Hollow Cradle answers with `products`, priced as given. */
  function searching(
    products: { id: string; title: string; type?: string; sold?: unknown }[],
  ): JobHarness {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.microsoftSearches['Hollow Cradle'] = microsoftSearchAnswer(products)
    for (const product of products) {
      if (product.sold) harness.microsoftProducts[product.id] = product.sold
    }
    return harness
  }
  const CRADLE = target(101, 'Hollow Cradle', null)
  const LISTED = { group: 'cradle', released: '2021-03-11T00:00:00.0000000Z' }
  const sold = (
    number: number,
    list: number,
    title = 'Hollow Cradle',
    listing: object = LISTED,
  ) => ({
    id: pid(number),
    title,
    sold: microsoftProduct(pid(number), list, list, title, listing),
  })

  it('takes the cheapest of several under the game’s name, and the same one of two as cheap', async () => {
    const products = [sold(11, 899), sold(13, 499), sold(12, 499), sold(14, 1299)]

    for (const order of [products, [...products].reverse()]) {
      const { settled } = await findMicrosoftProducts(searching(order).deps, [CRADLE])

      expect(settled.get(101)).toMatchObject({ id: pid(12), via: 'name' })
    }
  })

  it('takes the cheapest edition when nothing is under the name itself', async () => {
    const harness = searching([
      sold(11, 1499, 'Hollow Cradle Ultimate Edition'),
      sold(12, 899, 'Hollow Cradle - Standard Edition (PC)'),
      // Cheaper than either, and not an edition of the game.
      sold(13, 199, 'Hollow Cradle - Season Pass'),
      sold(14, 99, 'Hollow Cradle 2'),
    ])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toMatchObject({
      id: pid(12),
      name: 'hollow-cradle---standard-edition-pc',
      via: 'edition',
    })
    // What a title rules out is not asked about at all.
    expect(harness.microsoftBatches).toEqual([[pid(11), pid(12)]])
  })

  it('takes the name before an edition, though the edition is cheaper', async () => {
    const harness = searching([sold(11, 199, 'Hollow Cradle Gold Edition'), sold(12, 899)])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toMatchObject({ id: pid(12), via: 'name' })
  })

  it('takes an edition when the product under the name itself cannot be bought', async () => {
    const harness = searching([
      { id: pid(11), title: 'Hollow Cradle' },
      sold(12, 899, 'Hollow Cradle Gold Edition'),
    ])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toMatchObject({ id: pid(12), via: 'edition' })
  })

  it('finds nothing when nothing the search found can be bought', async () => {
    const harness = searching([{ id: pid(11), title: 'Hollow Cradle' }])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toBeNull()
    expect(harness.microsoftBatches).toEqual([[pid(11)]])
  })

  it('takes only what the store calls a game', async () => {
    const harness = searching([{ ...sold(11, 899), type: 'Durable' }])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toBeNull()
    expect(harness.microsoftBatches).toEqual([])
  })

  it('judges the title again on the catalog’s own answer: the one the offer will carry', async () => {
    const harness = searching([
      // The search said "Hollow Cradle"; the product's own listing says otherwise.
      { id: pid(11), title: 'Hollow Cradle', sold: sold(11, 499, 'Hollow Cradle: Aftermath').sold },
      { id: pid(12), title: 'Hollow Cradle', sold: sold(12, 899, 'HOLLOW CRADLE™').sold },
    ])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toMatchObject({ id: pid(12), product: { title: 'HOLLOW CRADLE™' } })
  })

  it.each([
    ['listed fifteen years before the game', '2006-07-11T00:00:00.0000000Z', null],
    ['listed a year and a day before it', '2020-03-10T00:00:00.0000000Z', null],
    ['listed a year before it to the day', '2020-03-11T00:00:00.0000000Z', pid(11)],
    ['listed five years after it', '2026-01-20T00:00:00.0000000Z', pid(11)],
    ['that the catalog has no date for', '9998-12-30T00:00:00.0000000Z', pid(11)],
  ])(
    'holds a product %s to the year a listing may precede its game by',
    async (_what, released, id) => {
      const harness = searching([sold(11, 899, 'Hollow Cradle', { group: 'cradle', released })])

      const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

      expect(settled.get(101)?.id ?? null).toBe(id)
    },
  )

  it('finds nothing in a product whose listing states no date this job can read', async () => {
    const undated = microsoftProduct(pid(11), 899, 899, 'Hollow Cradle')
    const harness = searching([{ id: pid(11), title: 'Hollow Cradle', sold: undated }])

    const { settled } = await findMicrosoftProducts(harness.deps, [CRADLE])

    expect(settled.get(101)).toBeNull()
  })

  it('searches for no game without a release date, or without a name: neither can be found by a title', async () => {
    const harness = searching([sold(11, 899)])

    const result = await findMicrosoftProducts(harness.deps, [
      target(101, 'Hollow Cradle', null, null),
      target(102, ' ™ ', null),
    ])

    expect(result).toEqual({
      settled: new Map([
        [101, null],
        [102, null],
      ]),
      requests: 0,
      stopped: null,
    })
    expect(harness.microsoftSearchNames).toEqual([])
  })

  it('searches for the games in the order they were given, once each', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    const targets = [3, 1, 2].map((id) => target(id, `Game ${id}`, null))

    const result = await findMicrosoftProducts(harness.deps, targets)

    expect(harness.microsoftSearchNames).toEqual(['Game 3', 'Game 1', 'Game 2'])
    expect(result.requests).toBe(3)
    expect([...result.settled.keys()]).toEqual([3, 1, 2])
  })

  it('reads the prices of what the searches found a hundred products a request', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    // Sixty games, each with two products under its name: a hundred and twenty to read.
    const targets = Array.from({ length: 60 }, (_, index) => {
      const name = `Game ${index + 1}`
      const products = [1, 2].map((copy) => ({ id: pid(index * 2 + copy), title: name }))
      harness.microsoftSearches[name] = microsoftSearchAnswer(products)
      harness.microsoftProducts[products[0]!.id] = microsoftProduct(
        products[0]!.id,
        100 + index,
        100 + index,
        name,
        LISTED,
      )
      return target(index + 1, name, null)
    })

    const result = await findMicrosoftProducts(harness.deps, targets)

    expect(harness.microsoftBatches.map((batch) => batch.length)).toEqual([100, 20])
    expect(result.settled.size).toBe(60)
    expect([...result.settled.values()].every((find) => find?.via === 'name')).toBe(true)
    expect(result.requests).toBe(62)
  })
})

describe('findMicrosoftProducts: a store that will not answer', () => {
  const games = (count: number) =>
    Array.from({ length: count }, (_, index) => target(index + 1, `Game ${index + 1}`, null))
  const refusal = (status: number) =>
    new UpstreamError('MICROSOFT', status === 429 ? 'RATE_LIMITED' : 'ERROR', status)

  it('leaves a game whose search failed for a later run, and goes on with the rest', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.failMicrosoftSearchFor('Game 2', new UpstreamError('MICROSOFT', 'TIMEOUT'))

    const result = await findMicrosoftProducts(harness.deps, games(4))

    expect(harness.microsoftSearchNames).toEqual(['Game 1', 'Game 2', 'Game 3', 'Game 4'])
    expect([...result.settled.keys()]).toEqual([1, 3, 4])
    expect(result).toMatchObject({
      requests: 4,
      stopped: null,
      error: 'MICROSOFT upstream failure: TIMEOUT',
    })
    expect(harness.logs).toContain(
      'microsoft: the search for game-2 failed, leaving it for a later run: MICROSOFT upstream failure: TIMEOUT',
    )
  })

  it.each([403, 429])('asks nothing more in the run once the store answers %i', async (status) => {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.failMicrosoftSearchFor('Game 3', refusal(status))

    const result = await findMicrosoftProducts(harness.deps, games(150))

    expect(harness.microsoftSearchNames).toEqual(['Game 1', 'Game 2', 'Game 3'])
    expect([...result.settled.keys()]).toEqual([1, 2])
    expect(result).toMatchObject({ requests: 3, stopped: 'refused' })
    expect(result.error).toContain(String(status))
  })

  it('stops at a refusal of a product’s relations as well, before any search', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.failMicrosoftDetailsWith(pid(1), refusal(429))

    const result = await findMicrosoftProducts(harness.deps, [
      target(1, 'Game 1', pid(1)),
      target(2, 'Game 2', null),
    ])

    expect(result).toMatchObject({ settled: new Map(), requests: 1, stopped: 'refused' })
    expect(harness.microsoftSearchNames).toEqual([])
  })

  it('does not read what the searches before a refusal found: the run asks nothing more', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.microsoftSearches['Game 1'] = microsoftSearchAnswer([{ id: pid(1), title: 'Game 1' }])
    harness.failMicrosoftSearchFor('Game 2', refusal(403))

    const result = await findMicrosoftProducts(harness.deps, games(3))

    // Game 1 was searched for and not settled: its turn comes again with the next run.
    expect(result.settled.size).toBe(0)
    expect(harness.microsoftBatches).toEqual([])
    expect(result.requests).toBe(2)
  })

  it('stops for the run at the fifth request that fails: the store is not answering', async () => {
    expect(MICROSOFT_FALLBACK_MAX_FAILURES).toBe(5)
    const harness = createJobHarness({ start: RECORDED_AT })
    // Every other search fails: the fifth failure is the ninth search.
    for (const number of [1, 3, 5, 7, 9, 11, 13]) harness.failMicrosoftSearchFor(`Game ${number}`)

    const result = await findMicrosoftProducts(harness.deps, games(150))

    expect(harness.microsoftSearchNames).toHaveLength(9)
    expect([...result.settled.keys()]).toEqual([2, 4, 6, 8])
    expect(result).toMatchObject({ requests: 9, stopped: 'failures' })
  })

  it('counts an answer it cannot read as a request that failed, and does not read it as "nothing"', async () => {
    const harness = createJobHarness({ start: RECORDED_AT })
    harness.microsoftSearches['Game 1'] = { code: 'BadRequest' }
    harness.microsoftSearches['Game 2'] = '<html>Service Unavailable</html>'

    const result = await findMicrosoftProducts(harness.deps, games(3))

    // Settled as "nothing found", either would not be searched for again for thirty days.
    expect([...result.settled.keys()]).toEqual([3])
    expect(result).toMatchObject({ requests: 3, stopped: null })
  })

  it('stops once its ten minutes on the job’s clock are used, before the next request', async () => {
    expect(MICROSOFT_FALLBACK_BUDGET_MS).toBe(10 * 60_000)
    const harness = createJobHarness({ start: RECORDED_AT })
    const search = harness.deps.microsoftCatalog.search
    // A store that answers every search, four minutes late.
    harness.deps.microsoftCatalog = {
      ...harness.deps.microsoftCatalog,
      search: async (name) => {
        harness.clock.advance(4 * 60_000)
        return search(name)
      },
    }

    const result = await findMicrosoftProducts(harness.deps, games(150))

    // Three searches started inside the ten minutes; the fourth would have begun at twelve.
    expect(harness.microsoftSearchNames).toEqual(['Game 1', 'Game 2', 'Game 3'])
    expect([...result.settled.keys()]).toEqual([1, 2, 3])
    expect(result).toEqual({ settled: result.settled, requests: 3, stopped: 'time' })
  })

  it('tells its caller after every request, so that a lock can be kept alive', async () => {
    const harness = recordedWorld()
    let told = 0

    const result = await findMicrosoftProducts(
      harness.deps,
      [
        target(1, 'Resident Evil Village', '9MTNPF414F65', '2021-05-07'),
        target(2, 'Prey', null, '2017-05-05'),
      ],
      async () => void (told += 1),
    )

    expect(result.requests).toBe(5)
    expect(told).toBe(5)
  })

  it('is tried for a hundred and fifty games a run', () => {
    expect(MICROSOFT_SEARCHES_PER_RUN).toBe(150)
  })

  it('asks RAWG nothing, whatever it finds', async () => {
    const harness = recordedWorld()

    await findMicrosoftProducts(harness.deps, [
      target(1, 'Resident Evil Village', '9MTNPF414F65', '2021-05-07'),
      target(2, 'Prey', null, '2017-05-05'),
      target(3, 'DOOM', 'BR765873CQJD', '2016-05-13'),
    ])

    expect(harness.calls).toEqual([])
    expect(harness.priceBatches).toEqual([])
    expect(harness.gogPages).toEqual([])
  })
})
