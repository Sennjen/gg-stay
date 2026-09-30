import type { GameSortValue, LocalisationValue } from './catalog'

/**
 * The landing page's shelves, and the one place that says which games each of them holds.
 *
 * The landing resolver asks for exactly `shelfQuery(id, year)` — through the index for the first
 * three, through RAWG for the last two — and the shelf's "Усі ігри" link opens exactly
 * `shelfCatalogQuery(id, year)`, which the catalog page parses back into the same filter and sort.
 * A shelf therefore always shows the first games of the catalog page it links to.
 *
 * `year` is the current calendar year, read once per request from the resolver's single clock
 * read (`context.today`) and once per render on the page (`useState`), never in a render path.
 */

export const SHELF_IDS = [
  'MADE_IN_UKRAINE',
  'UKRAINIAN',
  'ON_SALE',
  'BEST_THIS_YEAR',
  'UPCOMING',
] as const
export type ShelfIdValue = (typeof SHELF_IDS)[number]

/** How many games a shelf shows. */
export const SHELF_SIZE = 12

/** A shelf with fewer games than this is not shown at all, rather than shown half empty. */
export const SHELF_MIN_GAMES = 4

/** The smallest discount the "Зі знижкою" shelf counts as a sale. */
export const ON_SALE_MIN_PERCENT = 30

/** The subset of the catalog filter a shelf can set, under the catalog's own field names. */
export interface ShelfFilter {
  madeInUkraine?: true
  ukrainianLocalisation?: LocalisationValue
  onSaleMinPercent?: number
  yearFrom?: number
  yearTo?: number
  upcoming?: true
}

export interface ShelfQuery {
  filter: ShelfFilter
  sort: GameSortValue
}

export interface ShelfDefinition {
  id: ShelfIdValue
  /** The i18n key of the shelf's visible title. */
  titleKey: string
  /** Who answers the shelf: the nightly index (its facets) or RAWG (the whole catalog). */
  source: 'index' | 'rawg'
  /** A shelf that reads a price or a discount is withheld while the index's prices are stale. */
  dependsOnPrices: boolean
  query: (year: number) => ShelfQuery
}

export const SHELVES: readonly ShelfDefinition[] = [
  {
    id: 'MADE_IN_UKRAINE',
    titleKey: 'home.shelves.madeInUkraine',
    source: 'index',
    dependsOnPrices: false,
    query: () => ({ filter: { madeInUkraine: true }, sort: 'POPULARITY_DESC' }),
  },
  {
    id: 'UKRAINIAN',
    titleKey: 'home.shelves.ukrainian',
    source: 'index',
    dependsOnPrices: false,
    query: () => ({ filter: { ukrainianLocalisation: 'ANY' }, sort: 'POPULARITY_DESC' }),
  },
  {
    id: 'ON_SALE',
    titleKey: 'home.shelves.onSale',
    source: 'index',
    dependsOnPrices: true,
    query: () => ({ filter: { onSaleMinPercent: ON_SALE_MIN_PERCENT }, sort: 'POPULARITY_DESC' }),
  },
  {
    id: 'BEST_THIS_YEAR',
    titleKey: 'home.shelves.bestThisYear',
    source: 'rawg',
    dependsOnPrices: false,
    query: (year) => ({ filter: { yearFrom: year, yearTo: year }, sort: 'RATING_DESC' }),
  },
  {
    id: 'UPCOMING',
    titleKey: 'home.shelves.upcoming',
    source: 'rawg',
    dependsOnPrices: false,
    query: () => ({ filter: { upcoming: true }, sort: 'POPULARITY_DESC' }),
  },
]

export function shelfDefinition(id: ShelfIdValue): ShelfDefinition {
  const shelf = SHELVES.find((entry) => entry.id === id)
  if (!shelf) throw new Error(`Unknown shelf: ${id}`)
  return shelf
}

export function shelfQuery(id: ShelfIdValue, year: number): ShelfQuery {
  return shelfDefinition(id).query(year)
}

/** The catalog's default order, which its URL leaves out. */
const DEFAULT_CATALOG_SORT: GameSortValue = 'POPULARITY_DESC'

/**
 * The catalog URL query of a shelf, written with the catalog's own keys and value shapes
 * (`app/utils/filterUrl.ts`): flags as `1`, numbers as digits, the default sort left out.
 */
export function shelfCatalogQuery(id: ShelfIdValue, year: number): Record<string, string> {
  const { filter, sort } = shelfQuery(id, year)
  const entries: [string, string | undefined][] = [
    ['yearFrom', filter.yearFrom?.toString()],
    ['yearTo', filter.yearTo?.toString()],
    ['upcoming', filter.upcoming ? '1' : undefined],
    ['onSaleMinPercent', filter.onSaleMinPercent?.toString()],
    ['ukrainianLocalisation', filter.ukrainianLocalisation],
    ['madeInUkraine', filter.madeInUkraine ? '1' : undefined],
    ['sort', sort === DEFAULT_CATALOG_SORT ? undefined : sort],
  ]
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])))
}
