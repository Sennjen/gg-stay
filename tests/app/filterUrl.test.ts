import { describe, expect, it } from 'vitest'
import { countActiveFilters, parseFilterQuery, serializeFilterState } from '~/utils/filterUrl'
import { MAX_PRICE_UAH } from '#shared/catalog'

describe('parseFilterQuery', () => {
  it('returns defaults for an empty query', () => {
    expect(parseFilterQuery({})).toEqual({ filter: {}, sort: 'POPULARITY_DESC', page: 1 })
  })

  it('parses every supported key', () => {
    const state = parseFilterQuery({
      search: ' witcher ',
      genres: 'rpg,action',
      platforms: '4,7',
      yearFrom: '2015',
      yearTo: '2020',
      metacriticMin: '80',
      ratingMin: '4',
      playtime: 'LONG',
      gameModes: 'LOCAL_COOP,SINGLE',
      ageRating: 'PEGI7',
      stores: 'steam,gog',
      developers: 'cd-projekt-red',
      priceMaxUah: '300',
      onSaleMinPercent: '50',
      ukrainianLocalisation: 'AUDIO',
      sort: 'RELEASED_DESC',
      page: '3',
    })
    expect(state).toEqual({
      filter: {
        search: 'witcher',
        genres: ['rpg', 'action'],
        platforms: [4, 7],
        yearFrom: 2015,
        yearTo: 2020,
        metacriticMin: 80,
        ratingMin: 4,
        playtime: 'LONG',
        gameModes: ['LOCAL_COOP', 'SINGLE'],
        ageRating: ['PEGI7'],
        stores: ['steam', 'gog'],
        developers: ['cd-projekt-red'],
        priceMaxUah: 300,
        onSaleMinPercent: 50,
        ukrainianLocalisation: 'AUDIO',
      },
      sort: 'RELEASED_DESC',
      page: 3,
    })
  })

  it('drops an inverted year pair instead of sending a range that matches nothing', () => {
    const state = parseFilterQuery({ yearFrom: '2020', yearTo: '1990' })
    expect(state.filter.yearFrom).toBeUndefined()
    expect(state.filter.yearTo).toBeUndefined()
    // A pair in the right order is untouched, and so is a single open-ended bound.
    expect(parseFilterQuery({ yearFrom: '1990', yearTo: '2020' }).filter).toEqual({
      yearFrom: 1990,
      yearTo: 2020,
    })
    expect(parseFilterQuery({ yearFrom: '2020' }).filter).toEqual({ yearFrom: 2020 })
  })

  it('drops the year range when upcoming is set, so one filter cannot become invisible', () => {
    // `filterToParams` already prefers `upcoming`, but leaving the years in the state made
    // `countActiveFilters` count two while `ActiveFilterChips` rendered one.
    const state = parseFilterQuery({ upcoming: '1', yearFrom: '2000', yearTo: '2010' })
    expect(state.filter).toEqual({ upcoming: true })
    expect(countActiveFilters(state.filter)).toBe(1)
  })

  it('drops invalid values silently', () => {
    const state = parseFilterQuery({
      platforms: '4,abc,-1',
      yearFrom: '12',
      metacriticMin: '75',
      ratingMin: '9',
      playtime: 'HUGE',
      gameModes: 'SINGLE,BOGUS',
      ageRating: 'PEGI99',
      stores: 'steam,warez',
      sort: 'CHEAPEST',
      page: '0',
      genres: ['rpg', 'x'],
      upcoming: 'yes',
      search: '',
    })
    expect(state).toEqual({
      filter: { platforms: [4], gameModes: ['SINGLE'], stores: ['steam'], genres: ['rpg'] },
      sort: 'POPULARITY_DESC',
      page: 1,
    })
  })

  it('caps page at 500', () => {
    expect(parseFilterQuery({ page: '9999' }).page).toBe(500)
  })
})

describe('parseFilterQuery: the index filters', () => {
  it('accepts a positive price up to the cap and drops anything outside it', () => {
    expect(parseFilterQuery({ priceMaxUah: '1' }).filter.priceMaxUah).toBe(1)
    expect(parseFilterQuery({ priceMaxUah: String(MAX_PRICE_UAH) }).filter.priceMaxUah).toBe(
      MAX_PRICE_UAH,
    )
    // Zero is not "up to nothing", it is the free filter, which has its own key.
    expect(parseFilterQuery({ priceMaxUah: '0' }).filter.priceMaxUah).toBeUndefined()
    expect(parseFilterQuery({ priceMaxUah: String(MAX_PRICE_UAH + 1) }).filter.priceMaxUah).toBe(
      undefined,
    )
    expect(parseFilterQuery({ priceMaxUah: '-5' }).filter.priceMaxUah).toBeUndefined()
    expect(parseFilterQuery({ priceMaxUah: '300.5' }).filter.priceMaxUah).toBeUndefined()
    expect(parseFilterQuery({ priceMaxUah: 'free' }).filter.priceMaxUah).toBeUndefined()
  })

  it('accepts free only as "1"', () => {
    expect(parseFilterQuery({ free: '1' }).filter.free).toBe(true)
    expect(parseFilterQuery({ free: '0' }).filter.free).toBeUndefined()
    expect(parseFilterQuery({ free: 'true' }).filter.free).toBeUndefined()
  })

  it('accepts any discount from 1 to 99, not only the three offered steps', () => {
    for (const step of [25, 50, 75]) {
      expect(parseFilterQuery({ onSaleMinPercent: String(step) }).filter.onSaleMinPercent).toBe(
        step,
      )
    }
    expect(parseFilterQuery({ onSaleMinPercent: '1' }).filter.onSaleMinPercent).toBe(1)
    expect(parseFilterQuery({ onSaleMinPercent: '33' }).filter.onSaleMinPercent).toBe(33)
    expect(parseFilterQuery({ onSaleMinPercent: '99' }).filter.onSaleMinPercent).toBe(99)
    expect(parseFilterQuery({ onSaleMinPercent: '0' }).filter.onSaleMinPercent).toBeUndefined()
    expect(parseFilterQuery({ onSaleMinPercent: '100' }).filter.onSaleMinPercent).toBeUndefined()
  })

  it('accepts the three localisation levels and drops anything else', () => {
    expect(parseFilterQuery({ ukrainianLocalisation: 'ANY' }).filter.ukrainianLocalisation).toBe(
      'ANY',
    )
    expect(parseFilterQuery({ ukrainianLocalisation: 'TEXT' }).filter.ukrainianLocalisation).toBe(
      'TEXT',
    )
    expect(parseFilterQuery({ ukrainianLocalisation: 'AUDIO' }).filter.ukrainianLocalisation).toBe(
      'AUDIO',
    )
    expect(
      parseFilterQuery({ ukrainianLocalisation: 'SUBTITLES' }).filter.ukrainianLocalisation,
    ).toBeUndefined()
    expect(
      parseFilterQuery({ ukrainianLocalisation: 'audio' }).filter.ukrainianLocalisation,
    ).toBeUndefined()
  })

  it('accepts the three index sorts', () => {
    for (const sort of ['PRICE_ASC', 'PRICE_DESC', 'DISCOUNT_DESC'] as const) {
      expect(parseFilterQuery({ sort }).sort).toBe(sort)
    }
  })

  it('parses free and priceMaxUah together, even though the UI never sets both', () => {
    // The two are mutually exclusive in the drawer (choosing one clears the other), but a
    // hand-written URL carrying both is two real filters: each gets its chip and each is counted,
    // so neither can be active without being visible and removable.
    const state = parseFilterQuery({ free: '1', priceMaxUah: '300' })
    expect(state.filter).toEqual({ free: true, priceMaxUah: 300 })
    expect(countActiveFilters(state.filter)).toBe(2)
  })
})

describe('serializeFilterState', () => {
  it('omits defaults and empty values', () => {
    expect(
      serializeFilterState({
        filter: { genres: [], search: '' },
        sort: 'POPULARITY_DESC',
        page: 1,
      }),
    ).toEqual({})
  })

  it('writes keys in canonical order', () => {
    const query = serializeFilterState({
      filter: {
        stores: ['steam'],
        genres: ['rpg'],
        upcoming: true,
        platforms: [7, 4],
        ukrainianLocalisation: 'TEXT',
        priceMaxUah: 300,
        free: true,
        onSaleMinPercent: 50,
      },
      sort: 'NAME_ASC',
      page: 2,
    })
    expect(Object.keys(query)).toEqual([
      'genres',
      'platforms',
      'upcoming',
      'stores',
      'free',
      'priceMaxUah',
      'onSaleMinPercent',
      'ukrainianLocalisation',
      'sort',
      'page',
    ])
    expect(query).toEqual({
      genres: 'rpg',
      platforms: '7,4',
      upcoming: '1',
      stores: 'steam',
      free: '1',
      priceMaxUah: '300',
      onSaleMinPercent: '50',
      ukrainianLocalisation: 'TEXT',
      sort: 'NAME_ASC',
      page: '2',
    })
  })

  it('omits a localisation level that is not set, and free when it is false', () => {
    expect(
      serializeFilterState({ filter: { free: false }, sort: 'POPULARITY_DESC', page: 1 }),
    ).toEqual({})
  })

  it('round-trips', () => {
    const query = {
      genres: 'rpg',
      platforms: '4',
      gameModes: 'LOCAL_COOP',
      ageRating: 'PEGI7',
      sort: 'RELEASED_DESC',
      page: '2',
    }
    expect(serializeFilterState(parseFilterQuery(query))).toEqual(query)
  })

  it('round-trips the index filters and every index sort', () => {
    for (const sort of ['PRICE_ASC', 'PRICE_DESC', 'DISCOUNT_DESC']) {
      const query = {
        free: '1',
        priceMaxUah: '1000',
        onSaleMinPercent: '75',
        ukrainianLocalisation: 'AUDIO',
        sort,
      }
      expect(serializeFilterState(parseFilterQuery(query))).toEqual(query)
    }
  })

  it('does not echo back an index value the parser dropped', () => {
    expect(
      serializeFilterState(
        parseFilterQuery({
          priceMaxUah: '999999',
          onSaleMinPercent: '0',
          ukrainianLocalisation: 'VOICE',
          free: 'yes',
          genres: 'rpg',
        }),
      ),
    ).toEqual({ genres: 'rpg' })
  })
})

describe('countActiveFilters', () => {
  it('counts set fields', () => {
    expect(countActiveFilters({})).toBe(0)
    expect(countActiveFilters({ genres: ['rpg', 'action'], upcoming: true, search: 'x' })).toBe(3)
  })

  it('leaves out a filter the answer could not apply', () => {
    // The badge says how many filters are shaping the list on screen. A filter the server
    // declined is still in the URL, still has its chip and is still removable — but it is not
    // shaping anything, and counting it would make the badge disagree with the results.
    const filter = { genres: ['rpg'], priceMaxUah: 300, ukrainianLocalisation: 'TEXT' } as const
    expect(countActiveFilters(filter)).toBe(3)
    expect(countActiveFilters(filter, ['priceMaxUah'])).toBe(2)
    expect(countActiveFilters(filter, ['priceMaxUah', 'ukrainianLocalisation'])).toBe(1)
  })

  it('counts a multi-value filter once, and drops it once when it is ignored', () => {
    const filter = { developers: ['cd-projekt-red', 'valve'], free: true }
    expect(countActiveFilters(filter)).toBe(2)
    expect(countActiveFilters(filter, ['developers'])).toBe(1)
  })

  it('ignores names that are not filters, and names of filters that are not set', () => {
    // `sort` is in `ignoredFilters` too, and it is not a filter; a name for a field the URL does
    // not carry must not push the count below what is actually there.
    expect(countActiveFilters({ free: true }, ['sort', 'onSaleMinPercent', 'publishers'])).toBe(1)
  })
})
