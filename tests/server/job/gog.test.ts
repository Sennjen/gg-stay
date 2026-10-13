import { describe, expect, it, vi } from 'vitest'
import {
  createGogCatalogFetch,
  GOG_MAX_PAGES,
  GOG_PAGE_SIZE,
  parseGogCatalogPage,
  parseGogPrice,
  walkGogCatalog,
  type GogCatalogFetch,
} from '../../../scripts/index/gog'
import recorded from '../../fixtures/gog/catalog.json' with { type: 'json' }
import { gogCatalogPage, gogPrice, gogProduct } from '../../fixtures/index/jobStores'

/**
 * GOG's catalog as the job reads it. `tests/fixtures/gog/catalog.json` is an answer recorded on
 * 2026-10-12 — the catalog for Ukraine, in dollars, searched for "the witcher 3" — cut to the
 * fields the job reads: a free product, a discounted one and one that is not out yet.
 */

const usd = (amount: unknown) => ({ amount, currency: 'USD' })

describe('parseGogPrice', () => {
  it('reads a discounted price in cents, and counts the discount from the two amounts', () => {
    expect(parseGogPrice(gogPrice('17.49', '34.99'))).toEqual({
      amount: 1749,
      regularAmount: 3499,
      discountPercent: 50,
    })
    // GOG labels these -40 %, -80 % and -77 %; the amounts say the same.
    expect(parseGogPrice(gogPrice('5.99', '9.99'))?.discountPercent).toBe(40)
    expect(parseGogPrice(gogPrice('2.89', '14.49'))?.discountPercent).toBe(80)
    expect(parseGogPrice(gogPrice('0.25', '1.07'))?.discountPercent).toBe(77)
  })

  it('reads a price that is not discounted', () => {
    expect(parseGogPrice(gogPrice('6.69', '6.69'))).toEqual({
      amount: 669,
      regularAmount: 669,
      discountPercent: 0,
    })
  })

  it('reads a free game as a price of zero, because GOG said zero', () => {
    expect(parseGogPrice(gogPrice('0.00', '0.00'))).toEqual({
      amount: 0,
      regularAmount: 0,
      discountPercent: 0,
    })
  })

  it('reads a game given away for a while as zero against its regular price', () => {
    expect(parseGogPrice(gogPrice('0.00', '9.99'))).toEqual({
      amount: 0,
      regularAmount: 999,
      discountPercent: 100,
    })
  })

  it('never states a regular price below what is charged', () => {
    expect(parseGogPrice(gogPrice('9.99', '4.99'))).toEqual({
      amount: 999,
      regularAmount: 999,
      discountPercent: 0,
    })
  })

  it('reads the cents from the digits, not through a float', () => {
    // 17.49 * 100 is 1748.9999999999998 and 1.15 * 100 is 114.99999999999999.
    expect(parseGogPrice(gogPrice('1.15', '1.15'))?.amount).toBe(115)
    expect(parseGogPrice(gogPrice('185.99', '185.99'))?.amount).toBe(18599)
  })

  it.each([
    ['no price at all, as for a game that is not out', null],
    ['a price that is a string', '$17.49'],
    ['a price that is a list', [gogPrice('17.49', '34.99')]],
    ['a price without its money', { final: '$17.49', base: '$34.99', discount: '-50%' }],
    ['no base price', { finalMoney: usd('17.49') }],
    ['no final price', { baseMoney: usd('34.99') }],
  ])('reads no price from %s', (_what, value) => {
    expect(parseGogPrice(value)).toBeNull()
  })

  it.each([
    ['dollars in lower case', gogPrice('17.49', '34.99', 'usd')],
    [
      'one amount in another currency',
      { finalMoney: usd('17.49'), baseMoney: { amount: '34.99', currency: 'EUR' } },
    ],
    ['no currency', { finalMoney: { amount: '17.49' }, baseMoney: { amount: '34.99' } }],
  ])('reads no price in %s: it asked for dollars', (_what, value) => {
    expect(parseGogPrice(value)).toBeNull()
  })

  it.each([
    17.49,
    0,
    '17.5',
    '17',
    '17,49',
    '-1.00',
    '',
    ' 17.49',
    '17.490',
    '1e2',
    '12345678.00',
    'NaN',
    null,
  ])('reads no price from the amount %j — and never zero', (amount) => {
    expect(parseGogPrice({ finalMoney: usd(amount), baseMoney: usd('34.99') })).toBeNull()
    expect(parseGogPrice({ finalMoney: usd('17.49'), baseMoney: usd(amount) })).toBeNull()
  })
})

describe('parseGogCatalogPage', () => {
  it('reads the recorded answer: a free product, a discounted one and one not out yet', () => {
    expect(parseGogCatalogPage(recorded)).toEqual({
      pages: 1,
      productCount: 3,
      products: [
        {
          id: '1441199941',
          slug: 'the_witcher_3_redkit',
          title: 'The Witcher 3 REDkit',
          price: { amount: 0, regularAmount: 0, discountPercent: 0 },
          url: 'https://www.gog.com/en/game/the_witcher_3_redkit',
        },
        {
          id: '1640424747',
          slug: 'the_witcher_3_wild_hunt_game_of_the_year_edition',
          // The slug still says "game of the year edition"; the title is what GOG calls it now.
          title: 'The Witcher 3: Wild Hunt — Remastered',
          price: { amount: 1749, regularAmount: 3499, discountPercent: 50 },
          url: 'https://www.gog.com/en/game/the_witcher_3_wild_hunt_game_of_the_year_edition',
        },
        {
          id: '1179418179',
          slug: 'the_witcher_3_wild_hunt_songs_of_the_past',
          title: 'The Witcher 3: Wild Hunt — Songs of the Past',
          price: null,
          url: 'https://www.gog.com/en/game/the_witcher_3_wild_hunt_songs_of_the_past',
        },
      ],
      // Every slug of the recording is a slug.
      unnamed: [],
    })
  })

  it.each([
    ['in capitals', 'Limbo'],
    ['with a hyphen', 'limbo-2'],
    ['with a space', 'limbo 2'],
    ['with a slash', 'limbo/extras'],
    ['with a line break and a runner command after it', 'limbo\n::add-mask::secret'],
    ['of two hundred and one characters', 'x'.repeat(201)],
    ['in another script', '\u043B\u0456\u043C\u0431\u043E'],
  ])('counts a product whose slug is %s, and keeps nothing of it', (_what, slug) => {
    const page = parseGogCatalogPage(
      gogCatalogPage(
        [
          gogProduct('amber_archive', gogPrice('4.99', '4.99')),
          gogProduct(slug, gogPrice('9.99', '9.99'), { id: 'odd-one' }),
        ],
        1,
        100,
      ),
    )

    // No reference can name it, so it is no product to the walk — but it is on the page, and the
    // walk's proof counts it: its id is all that is kept.
    expect(page.products.map((product) => product.slug)).toEqual(['amber_archive'])
    expect(page.unnamed).toEqual(['odd-one'])
    expect(JSON.stringify(page)).not.toContain('add-mask')
  })

  it('keeps a product whose price cannot be read, without a price', () => {
    const page = gogCatalogPage([gogProduct('limbo', gogPrice('9.99', '9.99', 'EUR'))], 1, 100)

    expect(parseGogCatalogPage(page).products).toEqual([
      {
        id: 'gog-limbo',
        slug: 'limbo',
        title: 'Limbo',
        price: null,
        url: 'https://www.gog.com/en/game/limbo',
      },
    ])
  })

  it('reads the title GOG gives the product, as plain text, and none when it gives none', () => {
    const titled = (title: unknown) =>
      parseGogCatalogPage(
        gogCatalogPage([gogProduct('limbo', gogPrice('9.99', '9.99'), { title })], 1, 100),
      ).products[0]!.title

    expect(titled('LIMBO')).toBe('LIMBO')
    expect(titled('  The Witcher 3:\n Wild Hunt \u2014 Game of the Year Edition ')).toBe(
      'The Witcher 3: Wild Hunt \u2014 Game of the Year Edition',
    )
    expect(titled('x'.repeat(500))).toHaveLength(200)
    // A product without a usable title is still a product, with its price.
    for (const missing of [undefined, null, '', '   ', 42, ['LIMBO'], { name: 'LIMBO' }]) {
      expect(titled(missing)).toBeNull()
    }
  })

  it.each([
    ['another product of GOG', 'https://www.gog.com/en/game/limbo_special_edition'],
    ['another site', 'https://example.org/en/game/limbo'],
    ['a script', 'javascript:alert(1)'],
    ['a path on no site', '/en/game/limbo'],
    ['nothing', null],
  ])('keeps no link that is %s', (_what, storeLink) => {
    const page = gogCatalogPage(
      [gogProduct('limbo', gogPrice('9.99', '9.99'), { storeLink })],
      1,
      100,
    )

    expect(parseGogCatalogPage(page).products[0]).toMatchObject({ slug: 'limbo', url: null })
  })

  it.each([
    ['nothing', null],
    ['a list', []],
    ['an error', ['Invalid request parameters. Error Id is 6acce70113d58']],
    ['no page count', { productCount: 1, products: [gogProduct('limbo', null)] }],
    ['no product count', { pages: 1, products: [gogProduct('limbo', null)] }],
    ['a page count that is text', { pages: '1', productCount: 1, products: [] }],
    ['a negative count', { pages: 1, productCount: -1, products: [] }],
    ['products that are not a list', { pages: 1, productCount: 1, products: {} }],
    ['a product without a slug', { pages: 1, productCount: 1, products: [{ id: '1' }] }],
    ['a product without an id', { pages: 1, productCount: 1, products: [{ slug: 'limbo' }] }],
    ['a product that is not one', { pages: 1, productCount: 1, products: ['limbo'] }],
  ])('refuses a page that is %s', (_what, body) => {
    expect(() => parseGogCatalogPage(body)).toThrow(/^GOG answered a catalog page/)
  })

  it('refuses a catalog that has outgrown what one query pages through', () => {
    // What the whole catalog answered on 2026-10-12, add-ons and extras included.
    const page = {
      pages: 100,
      productCount: 12_878,
      currentlyShownProductCount: 10_000,
      products: [],
    }

    expect(() => parseGogCatalogPage(page)).toThrow(
      'GOG lists 12878 products and pages through 10000 of them',
    )
  })
})

/** A catalog of `count` products served `pageSize` at a time, recording the pages asked for. */
function catalogOf(count: number, pageSize: number) {
  const products = Array.from({ length: count }, (_, index) =>
    gogProduct(`game_${String(index + 1).padStart(3, '0')}`, gogPrice('9.99', '9.99')),
  )
  const asked: number[] = []
  const answers = new Map<number, unknown>()
  const fetchPage: GogCatalogFetch = async (page) => {
    asked.push(page)
    return answers.has(page) ? answers.get(page) : gogCatalogPage(products, page, pageSize)
  }
  return { products, asked, answers, fetchPage }
}

describe('walkGogCatalog', () => {
  it('walks every page in order and returns every product by its slug', async () => {
    const catalog = catalogOf(5, 2)
    const onPage = vi.fn(async () => {})

    const walk = await walkGogCatalog(catalog.fetchPage, onPage)

    expect(catalog.asked).toEqual([1, 2, 3])
    expect(walk.pages).toBe(3)
    expect([...walk.products.keys()]).toEqual([
      'game_001',
      'game_002',
      'game_003',
      'game_004',
      'game_005',
    ])
    expect(walk.products.get('game_004')?.price).toEqual({
      amount: 999,
      regularAmount: 999,
      discountPercent: 0,
    })
    // Once a page, for a caller with a lock to keep alive.
    expect(onPage).toHaveBeenCalledTimes(3)
  })

  it('walks the recorded answer, which is one page', async () => {
    const walk = await walkGogCatalog(async () => recorded)

    expect(walk.pages).toBe(1)
    expect(walk.products.size).toBe(3)
  })

  it('fails whole when a page cannot be fetched', async () => {
    const catalog = catalogOf(5, 2)
    const fetchPage: GogCatalogFetch = async (page) => {
      if (page === 2) throw new Error('GOG upstream failure: TIMEOUT')
      return catalog.fetchPage(page)
    }

    await expect(walkGogCatalog(fetchPage)).rejects.toThrow('GOG upstream failure: TIMEOUT')
    // It stopped there: nothing is asked for once the walk cannot be whole.
    expect(catalog.asked).toEqual([1])
  })

  it('fails when a page is not a page', async () => {
    const catalog = catalogOf(5, 2)
    catalog.answers.set(3, null)

    await expect(walkGogCatalog(catalog.fetchPage)).rejects.toThrow(/not an object/)
  })

  it('fails when the catalog changes size under it', async () => {
    const catalog = catalogOf(5, 2)
    // A product was added while the walk was on page 1: every page after it has shifted.
    catalog.answers.set(2, {
      ...gogCatalogPage(catalog.products, 2, 2),
      productCount: 6,
      currentlyShownProductCount: 6,
    })

    await expect(walkGogCatalog(catalog.fetchPage)).rejects.toThrow(
      'the GOG catalog changed size during the walk, at page 2',
    )
  })

  it('fails when a product comes twice', async () => {
    const catalog = catalogOf(5, 2)
    catalog.answers.set(2, {
      ...gogCatalogPage(catalog.products, 2, 2),
      products: catalog.products.slice(1, 3),
    })

    await expect(walkGogCatalog(catalog.fetchPage)).rejects.toThrow(
      'the GOG catalog repeated game_002 at page 2',
    )
  })

  it('fails when one product comes under two slugs', async () => {
    // The id half of the check: the same product, renamed between two pages of the walk.
    const renamed = [
      gogProduct('limbo', gogPrice('9.99', '9.99'), { id: '1207664643' }),
      gogProduct('limbo_special_edition', gogPrice('9.99', '9.99'), { id: '1207664643' }),
    ]

    await expect(walkGogCatalog(async () => gogCatalogPage(renamed, 1, 100))).rejects.toThrow(
      'the GOG catalog repeated limbo_special_edition at page 1',
    )
  })

  it('fails when the number of pages changes though the number of products does not', async () => {
    const catalog = catalogOf(5, 2)
    // Three pages of two became two pages of three under the walk: the same five products, and
    // every page boundary somewhere else.
    catalog.answers.set(2, { ...gogCatalogPage(catalog.products, 2, 2), pages: 2 })

    await expect(walkGogCatalog(catalog.fetchPage)).rejects.toThrow(
      'the GOG catalog changed size during the walk, at page 2',
    )
  })

  it('walks past a product under a slug that is none, counting it and printing nothing of it', async () => {
    const hostile = 'limbo\n::add-mask::secret'
    const products = [
      gogProduct('amber_archive', gogPrice('4.99', '4.99')),
      gogProduct(hostile, gogPrice('9.99', '9.99'), { id: 'odd-one' }),
      gogProduct('zenith_run', gogPrice('1.99', '1.99')),
    ]

    const walk = await walkGogCatalog(async (page) => gogCatalogPage(products, page, 2))

    // Three products promised, three received: the walk is whole, and holds the two it can name.
    expect(walk.pages).toBe(2)
    expect([...walk.products.keys()]).toEqual(['amber_archive', 'zenith_run'])
  })

  it('names no slug when a product it could not name comes twice', async () => {
    const hostile = 'limbo\n::add-mask::secret'
    const twice = [
      gogProduct(hostile, gogPrice('9.99', '9.99'), { id: 'odd-one' }),
      gogProduct('amber_archive', gogPrice('4.99', '4.99')),
      gogProduct(`${hostile}!`, gogPrice('9.99', '9.99'), { id: 'odd-one' }),
    ]

    const failure = await walkGogCatalog(async (page) => gogCatalogPage(twice, page, 2)).catch(
      (error: Error) => error,
    )

    // Still a walk that cannot be whole; and the reason is one this job wrote every word of.
    expect((failure as Error).message).toBe('the GOG catalog repeated a product at page 2')
  })

  it('never puts a line break in the reason a walk failed for', async () => {
    // Every message a walk can end with, from a catalog that answers the worst it can.
    const hostile = 'x\n::error::y'
    const pages: unknown[] = [
      null,
      { pages: 1, productCount: 1, products: [{ id: hostile }] },
      { pages: 1, productCount: 2, products: [gogProduct(hostile, null)] },
      gogCatalogPage([gogProduct('limbo', null), gogProduct('limbo', null, { id: hostile })], 1, 9),
      { pages: 1, productCount: 12_878, currentlyShownProductCount: 10_000, products: [] },
      gogCatalogPage([], 1, 100),
    ]

    for (const page of pages) {
      const failure = await walkGogCatalog(async () => page).catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).not.toMatch(/[\r\n]/)
      expect((failure as Error).message).not.toContain('::error::')
    }
  })

  it('fails when two products claim one slug', async () => {
    const twins = [
      gogProduct('limbo', gogPrice('9.99', '9.99'), { id: '1' }),
      gogProduct('limbo', gogPrice('4.99', '4.99'), { id: '2' }),
    ]

    await expect(walkGogCatalog(async () => gogCatalogPage(twins, 1, 100))).rejects.toThrow(
      'the GOG catalog repeated limbo at page 1',
    )
  })

  it('fails when it received fewer products than it was promised', async () => {
    const catalog = catalogOf(5, 2)
    catalog.answers.set(3, { ...gogCatalogPage(catalog.products, 3, 2), products: [] })

    await expect(walkGogCatalog(catalog.fetchPage)).rejects.toThrow(
      'the GOG catalog promised 5 products and the walk received 4',
    )
  })

  it('fails on a catalog with nothing in it, rather than report that GOG sells nothing', async () => {
    await expect(walkGogCatalog(async () => gogCatalogPage([], 1, 100))).rejects.toThrow(
      'GOG answered a catalog with no products in it',
    )
    await expect(
      walkGogCatalog(async () => ({ pages: 0, productCount: 0, products: [] })),
    ).rejects.toThrow('GOG answered a catalog with no products in it')
  })

  it('fails after one request on a catalog longer than a walk covers', async () => {
    const fetchPage = vi.fn(async () => ({
      pages: GOG_MAX_PAGES + 1,
      productCount: (GOG_MAX_PAGES + 1) * GOG_PAGE_SIZE,
      products: [],
    }))

    await expect(walkGogCatalog(fetchPage)).rejects.toThrow(/more than one walk covers/)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})

describe('createGogCatalogFetch', () => {
  function transport(fixtures = false) {
    const urls: string[] = []
    const waits: number[] = []
    const fetchPage = createGogCatalogFetch({
      fixtures,
      fetchJson: async (url) => {
        urls.push(url)
        return { status: 200, body: gogCatalogPage([], 1, 100) }
      },
      readFixture: async (name) => (name === 'catalog' ? recorded : null),
      // A clock that stands still, so each wait is how far behind the first request a slot is.
      now: () => 0,
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
    })
    return { fetchPage, urls, waits }
  }

  it('asks for games and packs, for Ukraine, in dollars, by title, a hundred a page', async () => {
    const { fetchPage, urls } = transport()

    await fetchPage(7)

    expect(urls).toEqual([
      'https://catalog.gog.com/v1/catalog?countryCode=UA&currencyCode=USD&locale=en-US&productType=in:game,pack&order=asc:title&limit=100&page=7',
    ])
  })

  it('sends a request a second, with no burst', async () => {
    const { fetchPage, waits } = transport()

    await Promise.all([1, 2, 3, 4].map((page) => fetchPage(page)))

    expect(waits).toEqual([1_000, 2_000, 3_000])
  })

  it('serves the recorded answer as page 1 in fixture mode, and asks the network nothing', async () => {
    const { fetchPage, urls } = transport(true)

    expect(await fetchPage(1)).toBe(recorded)
    await expect(fetchPage(2)).rejects.toMatchObject({ source: 'GOG', kind: 'NOT_FOUND' })
    expect(urls).toHaveLength(0)
  })

  it('retries a page once and then fails as GOG, not as anybody else', async () => {
    let requests = 0
    const fetchPage = createGogCatalogFetch({
      fixtures: false,
      fetchJson: async () => {
        requests += 1
        return { status: 503, body: null }
      },
      readFixture: async () => null,
      now: () => 0,
      sleep: async () => {},
      log: () => {},
    })

    await expect(fetchPage(1)).rejects.toMatchObject({ source: 'GOG', kind: 'ERROR', status: 503 })
    expect(requests).toBe(2)
  })
})
