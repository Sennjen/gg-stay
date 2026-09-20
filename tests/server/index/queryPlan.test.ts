import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from '../../../shared/catalog'
import { daysSinceEpoch } from '../../../server/index/document'
import { planQuery } from '../../../server/index/queryPlan'
import {
  ageRatingFacetKey,
  freeFacetKey,
  genreFacetKey,
  localisationFacetKey,
  madeInUkraineFacetKey,
  orderKey,
  platformFacetKey,
  playtimeFacetKey,
  rangeKey,
} from '../../../server/index/keys'

const TODAY = '2026-09-20'

describe('planQuery', () => {
  it('defaults to the popularity order and the first page', () => {
    const plan = planQuery(1, {})
    expect(plan).toMatchObject({
      order: orderKey(1, 'POPULARITY_DESC'),
      facetGroups: [],
      ranges: [],
      search: null,
      offset: 0,
      limit: DEFAULT_PAGE_SIZE,
    })
  })

  it('reads the order set of the requested sort', () => {
    expect(planQuery(1, { sort: 'PRICE_DESC' }).order).toBe(orderKey(1, 'PRICE_DESC'))
    expect(planQuery(1, { sort: 'RELEASED_ASC' }).order).toBe(orderKey(1, 'RELEASED_ASC'))
  })

  it('unions the values inside a facet and keeps the facets apart', () => {
    const plan = planQuery(1, {
      genres: ['indie', 'strategy'],
      platforms: [4, 7],
      ageRating: ['PEGI3'],
      playtime: 'SHORT',
      madeInUkraine: true,
    })
    expect(plan.facetGroups).toEqual([
      [genreFacetKey(1, 'indie'), genreFacetKey(1, 'strategy')],
      [platformFacetKey(1, 4), platformFacetKey(1, 7)],
      [ageRatingFacetKey(1, 'PEGI3')],
      [playtimeFacetKey(1, 'SHORT')],
      [madeInUkraineFacetKey(1)],
    ])
  })

  it('maps the localisation levels onto their sets', () => {
    expect(planQuery(1, { ukrainianLocalisation: 'ANY' }).facetGroups).toEqual([
      [localisationFacetKey(1, 'text'), localisationFacetKey(1, 'audio')],
    ])
    expect(planQuery(1, { ukrainianLocalisation: 'TEXT' }).facetGroups).toEqual([
      [localisationFacetKey(1, 'text')],
    ])
    expect(planQuery(1, { ukrainianLocalisation: 'AUDIO' }).facetGroups).toEqual([
      [localisationFacetKey(1, 'audio')],
    ])
  })

  it('reads free games from their facet and ignores free: false', () => {
    expect(planQuery(1, { free: true }).facetGroups).toEqual([[freeFacetKey(1)]])
    expect(planQuery(1, { free: false }).facetGroups).toEqual([])
  })

  it('asks for no facet of its own when a price or discount filter is set', () => {
    // The range sets hold exactly the games whose price is known, so a "has a price" facet would
    // narrow nothing a range has not narrowed already.
    expect(planQuery(1, { priceMaxUah: 300 }).facetGroups).toEqual([])
    expect(planQuery(1, { onSaleMinPercent: 50 }).facetGroups).toEqual([])
    expect(planQuery(1, { sort: 'PRICE_ASC' }).facetGroups).toEqual([])
  })

  it('trims the numeric ranges with inclusive bounds', () => {
    expect(planQuery(1, { metacriticMin: 80 }).ranges).toEqual([
      { key: rangeKey(1, 'metacritic'), min: 80, max: Number.POSITIVE_INFINITY },
    ])
    expect(planQuery(1, { ratingMin: 4 }).ranges).toEqual([
      { key: rangeKey(1, 'rating'), min: 400, max: Number.POSITIVE_INFINITY },
    ])
    expect(planQuery(1, { priceMaxUah: 300 }).ranges).toEqual([
      { key: rangeKey(1, 'price'), min: Number.NEGATIVE_INFINITY, max: 300 },
    ])
    expect(planQuery(1, { onSaleMinPercent: 50 }).ranges).toEqual([
      { key: rangeKey(1, 'discount'), min: 50, max: Number.POSITIVE_INFINITY },
    ])
  })

  it('starts the upcoming range on the day after today', () => {
    expect(planQuery(1, { upcoming: true, today: TODAY }).ranges).toEqual([
      {
        key: rangeKey(1, 'released'),
        min: daysSinceEpoch('2026-09-21'),
        max: Number.POSITIVE_INFINITY,
      },
    ])
  })

  it('refuses to plan an upcoming query without a date to measure it against', () => {
    expect(() => planQuery(1, { upcoming: true })).toThrow(/today/i)
  })

  it('ends a year range on 31 December', () => {
    expect(planQuery(1, { yearFrom: 2015, yearTo: 2018 }).ranges).toEqual([
      {
        key: rangeKey(1, 'released'),
        min: daysSinceEpoch('2015-01-01'),
        max: daysSinceEpoch('2018-12-31'),
      },
    ])
    expect(planQuery(1, { yearTo: 2018 }).ranges[0]).toMatchObject({
      min: Number.NEGATIVE_INFINITY,
      max: daysSinceEpoch('2018-12-31'),
    })
    expect(planQuery(1, { yearFrom: 2015 }).ranges[0]).toMatchObject({
      min: daysSinceEpoch('2015-01-01'),
      max: Number.POSITIVE_INFINITY,
    })
  })

  it('prefers upcoming over a year range, as the RAWG path does', () => {
    const plan = planQuery(1, { upcoming: true, today: TODAY, yearFrom: 2000, yearTo: 2010 })
    expect(plan.ranges).toEqual([
      {
        key: rangeKey(1, 'released'),
        min: daysSinceEpoch('2026-09-21'),
        max: Number.POSITIVE_INFINITY,
      },
    ])
  })

  it('folds the search term and drops a blank one', () => {
    expect(planQuery(1, { search: '  KiTe  ' }).search).toBe('kite')
    expect(planQuery(1, { search: '   ' }).search).toBeNull()
    expect(planQuery(1, { search: '' }).search).toBeNull()
  })

  it('clamps the page and the page size', () => {
    expect(planQuery(1, { page: 3, pageSize: 10 })).toMatchObject({ offset: 20, limit: 10 })
    expect(planQuery(1, { pageSize: 500 }).limit).toBe(MAX_PAGE_SIZE)
    expect(planQuery(1, { pageSize: 0 }).limit).toBe(DEFAULT_PAGE_SIZE)
    expect(planQuery(1, { page: 0 }).offset).toBe(0)
    expect(planQuery(1, { page: -3 }).offset).toBe(0)
    expect(planQuery(1, { page: 9_999, pageSize: 20 }).offset).toBe((MAX_PAGE - 1) * 20)
  })
})
