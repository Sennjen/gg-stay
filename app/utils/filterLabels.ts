import {
  PLATFORM_OPTIONS,
  STORE_OPTIONS,
  USER_RATING_MIN,
  type AgeRatingValue,
  type GameModeValue,
} from '#shared/catalog'
import type { CatalogFilter } from '~/utils/filterUrl'

/**
 * The words for every active filter, in one place: the chip row renders them as removable chips,
 * and the catalog's meta description and title read them as prose. One vocabulary, so the page a
 * search result promises is described in the words the page itself shows.
 */
export interface FilterLabel {
  key: string
  /** The schema field this label stands for, so `ignoredFilters` can be matched against it. */
  field: keyof CatalogFilter
  /** Plain text, as the chip shows it (and the remove button's accessible name uses it). */
  label: string
  /**
   * The label as it reads in a sentence. A chip sits under its drawer section and beside its
   * neighbours, so "75+" on its own is clear there; in a description it is not, and gets the name
   * of what it measures. Every other label reads the same in both places.
   */
  prose: string
  /** Numbers displayed with no surrounding words get the mono numeral treatment. */
  numeric?: boolean
  /** One-sided year ("від 2010" / "from 2010"): only the year is a bare number, so it renders
   * through `<i18n-t>` with a slot, keeping the surrounding word out of the mono face. */
  yearPart?: { keypath: string; year: number }
  /** The same treatment for any other string that interpolates one bare number or amount. */
  numberPart?: { keypath: string; slot: string; value: string | number }
  /** The change that takes this one value off the filter. */
  patch: Partial<CatalogFilter>
}

export interface FilterLabelContext {
  t: (key: string, named?: Record<string, unknown>) => string
  formatUah: (value: number) => string
  genres: readonly { slug: string; name: string }[]
}

function without<T>(values: T[] | undefined, value: T): T[] | undefined {
  const next = (values ?? []).filter((entry) => entry !== value)
  return next.length ? next : undefined
}

type Draft = Omit<FilterLabel, 'prose'> & { prose?: string }

export function filterLabels(filter: CatalogFilter, context: FilterLabelContext): FilterLabel[] {
  const { t, formatUah } = context
  const list: Draft[] = []

  if (filter.search) {
    list.push({
      key: 'search',
      field: 'search',
      label: t('chips.search', { term: filter.search }),
      patch: { search: undefined },
    })
  }

  for (const slug of filter.genres ?? []) {
    const name = context.genres.find((genre) => genre.slug === slug)?.name ?? slug
    list.push({
      key: `genre:${slug}`,
      field: 'genres',
      label: name,
      patch: { genres: without(filter.genres, slug) },
    })
  }

  for (const id of filter.platforms ?? []) {
    const name = PLATFORM_OPTIONS.find((option) => option.id === id)?.name ?? String(id)
    list.push({
      key: `platform:${id}`,
      field: 'platforms',
      label: name,
      patch: { platforms: without(filter.platforms, id) },
    })
  }

  const clearYears: Partial<CatalogFilter> = { yearFrom: undefined, yearTo: undefined }
  if (filter.upcoming) {
    list.push({
      key: 'upcoming',
      field: 'upcoming',
      label: t('filters.upcoming'),
      patch: { upcoming: undefined },
    })
  } else if (filter.yearFrom !== undefined && filter.yearTo !== undefined) {
    const label = `${filter.yearFrom}–${filter.yearTo}`
    list.push({
      key: 'year',
      field: 'yearFrom',
      label,
      prose: `${t('filters.year')}: ${label}`,
      numeric: true,
      patch: clearYears,
    })
  } else if (filter.yearFrom !== undefined) {
    const label = t('chips.yearFrom', { year: filter.yearFrom })
    list.push({
      key: 'year',
      field: 'yearFrom',
      label,
      prose: `${t('filters.year')}: ${label}`,
      yearPart: { keypath: 'chips.yearFrom', year: filter.yearFrom },
      patch: clearYears,
    })
  } else if (filter.yearTo !== undefined) {
    const label = t('chips.yearTo', { year: filter.yearTo })
    list.push({
      key: 'year',
      field: 'yearFrom',
      label,
      prose: `${t('filters.year')}: ${label}`,
      yearPart: { keypath: 'chips.yearTo', year: filter.yearTo },
      patch: clearYears,
    })
  }

  if (filter.metacriticMin !== undefined) {
    const label = t('filters.metacriticMin', { value: filter.metacriticMin })
    list.push({
      key: 'metacritic',
      field: 'metacriticMin',
      label,
      prose: `${t('filters.metacritic')} ${label}`,
      numeric: true,
      patch: { metacriticMin: undefined },
    })
  }

  if (filter.ratingMin === USER_RATING_MIN) {
    list.push({
      key: 'rating',
      field: 'ratingMin',
      label: t('filters.userRating'),
      patch: { ratingMin: undefined },
    })
  }

  if (filter.playtime) {
    list.push({
      key: 'playtime',
      field: 'playtime',
      label: t(`playtimes.${filter.playtime}`),
      patch: { playtime: undefined },
    })
  }

  for (const mode of filter.gameModes ?? []) {
    list.push({
      key: `mode:${mode}`,
      field: 'gameModes',
      label: t(`gameModes.${mode}` as `gameModes.${GameModeValue}`),
      patch: { gameModes: without(filter.gameModes, mode) },
    })
  }

  for (const rating of filter.ageRating ?? []) {
    list.push({
      key: `age:${rating}`,
      field: 'ageRating',
      label: t(`ageRatings.${rating}` as `ageRatings.${AgeRatingValue}`),
      patch: { ageRating: without(filter.ageRating, rating) },
    })
  }

  for (const slug of filter.stores ?? []) {
    const name = STORE_OPTIONS.find((store) => store.slug === slug)?.name ?? slug
    list.push({
      key: `store:${slug}`,
      field: 'stores',
      label: name,
      patch: { stores: without(filter.stores, slug) },
    })
  }

  for (const slug of filter.developers ?? []) {
    list.push({
      key: `developer:${slug}`,
      field: 'developers',
      label: slug,
      patch: { developers: without(filter.developers, slug) },
    })
  }

  if (filter.free) {
    list.push({ key: 'free', field: 'free', label: t('price.free'), patch: { free: undefined } })
  }

  if (filter.priceMaxUah !== undefined) {
    const price = formatUah(filter.priceMaxUah)
    list.push({
      key: 'priceMaxUah',
      field: 'priceMaxUah',
      label: t('filters.priceUpTo', { price }),
      numberPart: { keypath: 'filters.priceUpTo', slot: 'price', value: price },
      patch: { priceMaxUah: undefined },
    })
  }

  if (filter.onSaleMinPercent !== undefined) {
    list.push({
      key: 'onSaleMinPercent',
      field: 'onSaleMinPercent',
      label: t('filters.discountFrom', { value: filter.onSaleMinPercent }),
      numberPart: {
        keypath: 'filters.discountFrom',
        slot: 'value',
        value: filter.onSaleMinPercent,
      },
      patch: { onSaleMinPercent: undefined },
    })
  }

  if (filter.ukrainianLocalisation) {
    list.push({
      key: 'ukrainianLocalisation',
      field: 'ukrainianLocalisation',
      label: t(`chips.localisation${filter.ukrainianLocalisation}`),
      patch: { ukrainianLocalisation: undefined },
    })
  }

  if (filter.madeInUkraine) {
    list.push({
      key: 'madeInUkraine',
      field: 'madeInUkraine',
      label: t('filters.madeInUkraine'),
      patch: { madeInUkraine: undefined },
    })
  }

  return list.map((entry) => ({ ...entry, prose: entry.prose ?? entry.label }))
}
