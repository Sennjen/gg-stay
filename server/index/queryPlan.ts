import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from '../../shared/catalog'
import type { IndexQuery, LocalisationFilter } from './GameIndex'
import { DEFAULT_SORT } from './GameIndex'
import { dayAfter, firstDayOfYear, foldName, lastDayOfYear } from './document'
import {
  ageRatingFacetKey,
  freeFacetKey,
  gameModeFacetKey,
  genreFacetKey,
  localisationFacetKey,
  madeInUkraineFacetKey,
  orderKey,
  platformFacetKey,
  playtimeFacetKey,
  rangeKey,
  storeFacetKey,
} from './keys'

/**
 * One `IndexQuery` translated into the keys and bounds a store executes. Every rule that is easy
 * to get subtly wrong — the `upcoming` boundary, the December end of a year range, the
 * ANY/TEXT/AUDIO mapping, the page clamps — lives here rather than in an adapter, so the Upstash
 * adapter and the in-memory one cannot answer the same question differently.
 */
export interface PlannedRange {
  key: string
  /** Inclusive; `-Infinity` for an open end, which Upstash sends as `-inf`. */
  min: number
  /** Inclusive; `+Infinity` for an open end. */
  max: number
}

export interface QueryPlan {
  /** The order set to read after the intersection, always ascending. */
  order: string
  /** Facet keys: OR inside a group, AND across groups. */
  facetGroups: string[][]
  ranges: PlannedRange[]
  /** Intersect with the priced facet as well: a price or discount filter is set. */
  requirePriced: boolean
  /** The folded needle, or `null` when the query does not search. */
  search: string | null
  offset: number
  limit: number
}

const OPEN_LOW = Number.NEGATIVE_INFINITY
const OPEN_HIGH = Number.POSITIVE_INFINITY

function localisationGroup(version: number, filter: LocalisationFilter): string[] {
  if (filter === 'TEXT') return [localisationFacetKey(version, 'text')]
  if (filter === 'AUDIO') return [localisationFacetKey(version, 'audio')]
  return [localisationFacetKey(version, 'text'), localisationFacetKey(version, 'audio')]
}

export function planQuery(version: number, query: IndexQuery): QueryPlan {
  const facetGroups: string[][] = []
  if (query.genres?.length)
    facetGroups.push(query.genres.map((genre) => genreFacetKey(version, genre)))
  if (query.platforms?.length)
    facetGroups.push(query.platforms.map((platform) => platformFacetKey(version, platform)))
  if (query.stores?.length)
    facetGroups.push(query.stores.map((store) => storeFacetKey(version, store)))
  if (query.gameModes?.length)
    facetGroups.push(query.gameModes.map((mode) => gameModeFacetKey(version, mode)))
  if (query.ageRating?.length)
    facetGroups.push(query.ageRating.map((rating) => ageRatingFacetKey(version, rating)))
  if (query.playtime) facetGroups.push([playtimeFacetKey(version, query.playtime)])
  if (query.madeInUkraine) facetGroups.push([madeInUkraineFacetKey(version)])
  // `free: false` is not "paid only": it is the absence of the filter, as everywhere else in the
  // catalog, where an unchecked box narrows nothing.
  if (query.free) facetGroups.push([freeFacetKey(version)])
  if (query.ukrainianLocalisation)
    facetGroups.push(localisationGroup(version, query.ukrainianLocalisation))

  const ranges: PlannedRange[] = []
  if (query.metacriticMin !== undefined)
    ranges.push({ key: rangeKey(version, 'metacritic'), min: query.metacriticMin, max: OPEN_HIGH })
  if (query.ratingMin !== undefined)
    ranges.push({
      key: rangeKey(version, 'rating'),
      min: Math.round(query.ratingMin * 100),
      max: OPEN_HIGH,
    })
  if (query.priceMaxUah !== undefined)
    ranges.push({ key: rangeKey(version, 'price'), min: OPEN_LOW, max: query.priceMaxUah })
  if (query.onSaleMinPercent !== undefined)
    ranges.push({
      key: rangeKey(version, 'discount'),
      min: query.onSaleMinPercent,
      max: OPEN_HIGH,
    })

  // `upcoming` wins over a year range, as it does on the RAWG path (`filterToParams`), and it is
  // measured against the caller's `today` because no adapter may read a clock.
  if (query.upcoming) {
    if (!query.today) {
      throw new TypeError('An upcoming index query needs `today` to be measured against')
    }
    ranges.push({ key: rangeKey(version, 'released'), min: dayAfter(query.today), max: OPEN_HIGH })
  } else if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    ranges.push({
      key: rangeKey(version, 'released'),
      min: query.yearFrom === undefined ? OPEN_LOW : firstDayOfYear(query.yearFrom),
      max: query.yearTo === undefined ? OPEN_HIGH : lastDayOfYear(query.yearTo),
    })
  }

  // The price orders hold priced games only and a price trim reads the price range, which holds
  // the same games — this intersection is what keeps a *discount* floor from matching a game
  // whose price the last run could not read.
  const requirePriced = query.priceMaxUah !== undefined || query.onSaleMinPercent !== undefined

  const pageSize = Math.min(Math.max(query.pageSize || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const page = Math.min(Math.max(query.page || 1, 1), MAX_PAGE)
  const needle = query.search ? foldName(query.search) : ''

  return {
    order: orderKey(version, query.sort ?? DEFAULT_SORT),
    facetGroups,
    ranges,
    requirePriced,
    search: needle || null,
    offset: (page - 1) * pageSize,
    limit: pageSize,
  }
}
