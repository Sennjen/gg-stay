import { describe, expect, it } from 'vitest'
import {
  ON_SALE_MIN_PERCENT,
  SHELF_IDS,
  SHELVES,
  shelfCatalogQuery,
  shelfDefinition,
  shelfQuery,
} from '../../shared/shelves'

/**
 * `shared/shelves.ts` is the one place that says which games a landing shelf holds: the resolver
 * asks for exactly `shelfQuery`, and the shelf's "Усі ігри" link opens exactly
 * `shelfCatalogQuery`. The round trip through the catalog's own URL parser is pinned in
 * `tests/app/filterUrl.test.ts`.
 */

describe('the landing shelves', () => {
  it('come in the order of the design', () => {
    expect(SHELF_IDS).toEqual([
      'MADE_IN_UKRAINE',
      'UKRAINIAN',
      'ON_SALE',
      'BEST_THIS_YEAR',
      'UPCOMING',
    ])
    expect(SHELVES.map((shelf) => shelf.id)).toEqual([...SHELF_IDS])
  })

  it('take the first three from the index and the last two from RAWG', () => {
    expect(SHELVES.map((shelf) => [shelf.id, shelf.source])).toEqual([
      ['MADE_IN_UKRAINE', 'index'],
      ['UKRAINIAN', 'index'],
      ['ON_SALE', 'index'],
      ['BEST_THIS_YEAR', 'rawg'],
      ['UPCOMING', 'rawg'],
    ])
  })

  it('let only the sale shelf depend on the prices', () => {
    expect(SHELVES.filter((shelf) => shelf.dependsOnPrices).map((shelf) => shelf.id)).toEqual([
      'ON_SALE',
    ])
  })

  it('each have a title key of their own', () => {
    const keys = SHELVES.map((shelf) => shelf.titleKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^home\.shelves\.[a-zA-Z]+$/)
  })

  it('ask for the games each shelf promises', () => {
    expect(shelfQuery('MADE_IN_UKRAINE', 2026)).toEqual({
      filter: { madeInUkraine: true },
      sort: 'POPULARITY_DESC',
    })
    expect(shelfQuery('UKRAINIAN', 2026)).toEqual({
      filter: { ukrainianLocalisation: 'ANY' },
      sort: 'POPULARITY_DESC',
    })
    expect(shelfQuery('ON_SALE', 2026)).toEqual({
      filter: { onSaleMinPercent: ON_SALE_MIN_PERCENT },
      sort: 'POPULARITY_DESC',
    })
    expect(ON_SALE_MIN_PERCENT).toBe(30)
    expect(shelfQuery('BEST_THIS_YEAR', 2026)).toEqual({
      filter: { yearFrom: 2026, yearTo: 2026 },
      sort: 'RATING_DESC',
    })
    expect(shelfQuery('UPCOMING', 2026)).toEqual({
      filter: { upcoming: true },
      sort: 'POPULARITY_DESC',
    })
  })

  it('build the catalog URL of each shelf from the same query', () => {
    expect(shelfCatalogQuery('MADE_IN_UKRAINE', 2026)).toEqual({ madeInUkraine: '1' })
    expect(shelfCatalogQuery('UKRAINIAN', 2026)).toEqual({ ukrainianLocalisation: 'ANY' })
    expect(shelfCatalogQuery('ON_SALE', 2026)).toEqual({ onSaleMinPercent: '30' })
    expect(shelfCatalogQuery('BEST_THIS_YEAR', 2026)).toEqual({
      yearFrom: '2026',
      yearTo: '2026',
      sort: 'RATING_DESC',
    })
    expect(shelfCatalogQuery('BEST_THIS_YEAR', 2027)).toMatchObject({ yearFrom: '2027' })
    expect(shelfCatalogQuery('UPCOMING', 2026)).toEqual({ upcoming: '1' })
  })

  it('look a shelf up by its id', () => {
    expect(shelfDefinition('ON_SALE').titleKey).toBe('home.shelves.onSale')
  })
})
