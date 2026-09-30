import type { GameSortValue, LocalisationValue } from './catalog'

/**
 * The landing page's shelves, and the one place that says which games each of them holds.
 *
 * The landing resolver asks for `shelfQuery(id, year)` — through the index for the first three,
 * through RAWG for the last two — and the shelf's "Усі ігри" link opens exactly
 * `shelfCatalogQuery(id, year)`, which the catalog page parses back into the same filter and sort.
 * A shelf therefore shows the first games of the catalog page it links to — except "Найкращі
 * цього року", whose `ratingPick` ranks the year's popular games by rating with a floor on votes,
 * because RAWG's plain rating order over a year is led by games almost nobody rated; its link
 * opens that year by popularity, the pool it was ranked from, under its own label.
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

/**
 * How a RAWG shelf is picked when its catalog order is not good enough on its own: the `pool`
 * first games of the shelf's query (its filter, by popularity) are fetched, those with fewer than
 * `minRatings` votes are dropped, and the rest are ranked by rating. RAWG's own rating order over
 * a whole year puts games with a handful of votes first.
 */
export interface ShelfRatingPick {
  pool: number
  minRatings: number
}

export interface ShelfDefinition {
  id: ShelfIdValue
  /** The i18n key of the shelf's visible title. */
  titleKey: string
  /** Who answers the shelf: the nightly index (its facets) or RAWG (the whole catalog). */
  source: 'index' | 'rawg'
  /** A shelf that reads a price or a discount is withheld while the index's prices are stale. */
  dependsOnPrices: boolean
  /**
   * What the resolver fetches and what "Усі ігри" opens — the same query, so the link always leads
   * to the games the shelf came from. Without `ratingPick` the shelf IS the first games of it.
   */
  query: (year: number) => ShelfQuery
  /** RAWG shelves only: rank the query's first games by rating instead of taking them in order. */
  ratingPick?: ShelfRatingPick
  /**
   * The i18n key of the link's label when "Усі ігри" would promise more than the link gives —
   * a shelf ranked out of its query links to the whole pool, and the label has to say which.
   */
  moreLabelKey?: string
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
    // The shelf is this year's forty most added games with at least twenty votes, by rating, so a
    // 5.0 from three players cannot lead it. Its link opens that pool — this year by popularity —
    // and not the catalog's rating order: the catalog has no vote floor, so "this year by rating"
    // there is exactly the list the shelf exists to avoid, and not one of its games would be on
    // it. Every shelf game is among the first forty of the linked page, and the label says the
    // link is the whole year rather than more of the same ranking.
    query: (year) => ({ filter: { yearFrom: year, yearTo: year }, sort: 'POPULARITY_DESC' }),
    ratingPick: { pool: 40, minRatings: 20 },
    moreLabelKey: 'home.shelves.bestThisYearAll',
  },
  {
    id: 'UPCOMING',
    titleKey: 'home.shelves.upcoming',
    source: 'rawg',
    dependsOnPrices: false,
    query: () => ({ filter: { upcoming: true }, sort: 'POPULARITY_DESC' }),
  },
]

/**
 * The definition of a shelf, or `undefined` for an id this build does not know — a newer API can
 * answer an older page with a shelf it has no title or link for, and that shelf is skipped.
 */
export function shelfDefinition(id: string): ShelfDefinition | undefined {
  return SHELVES.find((entry) => entry.id === id)
}

export function shelfQuery(id: ShelfIdValue, year: number): ShelfQuery {
  const shelf = shelfDefinition(id)
  if (!shelf) throw new Error(`Unknown shelf: ${id}`)
  return shelf.query(year)
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
