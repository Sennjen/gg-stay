import {
  AGE_RATINGS,
  GAME_MODES,
  LOCALISATIONS,
  MAX_PAGE,
  MAX_PRICE_UAH,
  METACRITIC_STEPS,
  PLAYTIMES,
  STORE_OPTIONS,
  UI_SORTS,
  USER_RATING_MIN,
  type AgeRatingValue,
  type GameModeValue,
  type GameSortValue,
  type LocalisationValue,
  type PlaytimeValue,
} from '#shared/catalog'

export interface CatalogFilter {
  search?: string
  genres?: string[]
  platforms?: number[]
  yearFrom?: number
  yearTo?: number
  upcoming?: boolean
  metacriticMin?: number
  ratingMin?: number
  playtime?: PlaytimeValue
  gameModes?: GameModeValue[]
  ageRating?: AgeRatingValue[]
  stores?: string[]
  developers?: string[]
  /** Highest price a game may cost, in whole hryvnia. Index-backed. */
  priceMaxUah?: number
  /** Free games only. Index-backed. Mutually exclusive with `priceMaxUah` in the drawer. */
  free?: boolean
  /** Smallest discount a game must carry, in whole percent. Index-backed. */
  onSaleMinPercent?: number
  /** Which level of Ukrainian localisation a game must have. Index-backed. */
  ukrainianLocalisation?: LocalisationValue
}

/**
 * The filter fields the price index answers, under the names the BFF reports in
 * `GamePage.ignoredFilters` — which is exactly the schema's own field names.
 *
 * `ActiveFilterChips` reads it to decide why a filter the answer declined was declined: one of
 * these means the index could not serve it, anything else means a RAWG-only filter lost the page
 * to the index. Kept beside `CatalogFilter` so a field added to the URL layer is added here in
 * the same edit rather than drifting into the wrong explanation.
 */
export const INDEX_FILTER_FIELDS = [
  'priceMaxUah',
  'free',
  'onSaleMinPercent',
  'ukrainianLocalisation',
] as const

export interface CatalogState {
  filter: CatalogFilter
  sort: GameSortValue
  page: number
}

export const DEFAULT_SORT: GameSortValue = 'POPULARITY_DESC'
const SLUG = /^[a-z0-9-]{1,80}$/
const STORE_SLUGS: readonly string[] = STORE_OPTIONS.map((store) => store.slug)

function first(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : undefined
}

function list(value: unknown): string[] {
  return (first(value) ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function int(value: unknown, min: number, max: number): number | undefined {
  const raw = first(value)
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const parsed = Number(raw)
  return parsed >= min && parsed <= max ? parsed : undefined
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined
}

export function parseFilterQuery(query: Record<string, unknown>): CatalogState {
  const candidate: Record<string, unknown> = {
    search: first(query.search)?.trim().slice(0, 100) || undefined,
    genres: nonEmpty(list(query.genres).filter((slug) => SLUG.test(slug))),
    platforms: nonEmpty(
      list(query.platforms)
        .filter((id) => /^\d{1,4}$/.test(id))
        .map(Number)
        .filter((id) => id > 0),
    ),
    yearFrom: int(query.yearFrom, 1970, 2100),
    yearTo: int(query.yearTo, 1970, 2100),
    upcoming: first(query.upcoming) === '1' ? true : undefined,
    metacriticMin: METACRITIC_STEPS.find((step) => step === int(query.metacriticMin, 0, 100)),
    ratingMin: int(query.ratingMin, 0, 5) === USER_RATING_MIN ? USER_RATING_MIN : undefined,
    playtime: oneOf(first(query.playtime), PLAYTIMES),
    gameModes: nonEmpty(list(query.gameModes).flatMap((mode) => oneOf(mode, GAME_MODES) ?? [])),
    ageRating: nonEmpty(
      list(query.ageRating).flatMap((rating) => oneOf(rating, AGE_RATINGS) ?? []),
    ),
    stores: nonEmpty(list(query.stores).filter((slug) => STORE_SLUGS.includes(slug))),
    developers: nonEmpty(list(query.developers).filter((slug) => SLUG.test(slug))),
    // "Up to 0 ₴" is not a price ceiling, it is the free filter, which has its own key — so the
    // range starts at 1. The cap keeps a hand-written URL from becoming an unbounded cache key.
    priceMaxUah: int(query.priceMaxUah, 1, MAX_PRICE_UAH),
    free: first(query.free) === '1' ? true : undefined,
    // Any whole percent, not only the three steps the drawer offers: a shared link with
    // `onSaleMinPercent=33` is a legitimate filter, and the index answers it.
    onSaleMinPercent: int(query.onSaleMinPercent, 1, 99),
    ukrainianLocalisation: oneOf(first(query.ukrainianLocalisation), LOCALISATIONS),
  }
  // Each bound is range-checked on its own above, but the pair is not: a hand-edited
  // `?yearFrom=2020&yearTo=1990` would reach `filterToParams` as `dates=2020-01-01,1990-12-31`,
  // which RAWG answers with nothing. An inverted pair is a typo, not an intent, so it is dropped.
  if (
    typeof candidate.yearFrom === 'number' &&
    typeof candidate.yearTo === 'number' &&
    candidate.yearFrom > candidate.yearTo
  ) {
    candidate.yearFrom = undefined
    candidate.yearTo = undefined
  }

  // `upcoming` and a year range are mutually exclusive: `filterToParams` already prefers
  // `upcoming`, and the UI clears the years when it is toggled on, but a crafted URL could carry
  // both — and then `countActiveFilters` counted two while `ActiveFilterChips` rendered one, so
  // one filter was neither visible nor removable. Normalising here keeps the URL the one source
  // of truth it is meant to be.
  if (candidate.upcoming) {
    candidate.yearFrom = undefined
    candidate.yearTo = undefined
  }

  const filter = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  ) as CatalogFilter

  const rawPage = first(query.page)
  const page =
    rawPage && /^\d+$/.test(rawPage) ? Math.min(Math.max(Number(rawPage), 1), MAX_PAGE) : 1

  return { filter, sort: oneOf(first(query.sort), UI_SORTS) ?? DEFAULT_SORT, page }
}

export function serializeFilterState({ filter, sort, page }: CatalogState): Record<string, string> {
  const entries: [string, string | undefined][] = [
    ['search', filter.search?.trim() || undefined],
    ['genres', filter.genres?.join(',') || undefined],
    ['platforms', filter.platforms?.join(',') || undefined],
    ['yearFrom', filter.yearFrom?.toString()],
    ['yearTo', filter.yearTo?.toString()],
    ['upcoming', filter.upcoming ? '1' : undefined],
    ['metacriticMin', filter.metacriticMin?.toString()],
    ['ratingMin', filter.ratingMin?.toString()],
    ['playtime', filter.playtime],
    ['gameModes', filter.gameModes?.join(',') || undefined],
    ['ageRating', filter.ageRating?.join(',') || undefined],
    ['stores', filter.stores?.join(',') || undefined],
    ['developers', filter.developers?.join(',') || undefined],
    ['free', filter.free ? '1' : undefined],
    ['priceMaxUah', filter.priceMaxUah?.toString()],
    ['onSaleMinPercent', filter.onSaleMinPercent?.toString()],
    ['ukrainianLocalisation', filter.ukrainianLocalisation],
    ['sort', sort === DEFAULT_SORT ? undefined : sort],
    ['page', page > 1 ? String(page) : undefined],
  ]
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])))
}

/**
 * How many filters are shaping the list on screen.
 *
 * `ignored` is `GamePage.ignoredFilters` — the schema field names the answer could not apply. A
 * filter named there is still in the URL, still has its chip and is still removable, but it is not
 * shaping anything, so it does not belong in the "Фільтри (N)" badge: a visitor comparing the
 * badge with the results would otherwise be counting a filter that is visibly struck through two
 * lines below. Names that are not filter fields (`sort`) and names of fields the URL does not
 * carry are simply not found, so they cannot push the count below what is really set.
 */
export function countActiveFilters(filter: CatalogFilter, ignored: readonly string[] = []): number {
  return Object.entries(filter).filter(([key, value]) => {
    if (ignored.includes(key)) return false
    return Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== '' && value !== false
  }).length
}
