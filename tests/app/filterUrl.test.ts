import { describe, expect, it } from 'vitest'
import { countActiveFilters, parseFilterQuery, serializeFilterState } from '~/utils/filterUrl'

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
      // The interface and subtitles levels the schema used to offer are gone.
      ukrainianLocalisation: 'SUBTITLES',
      sort: 'PRICE_ASC',
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
      filter: { stores: ['steam'], genres: ['rpg'], upcoming: true, platforms: [7, 4] },
      sort: 'NAME_ASC',
      page: 2,
    })
    expect(Object.keys(query)).toEqual([
      'genres',
      'platforms',
      'upcoming',
      'stores',
      'sort',
      'page',
    ])
    expect(query).toEqual({
      genres: 'rpg',
      platforms: '7,4',
      upcoming: '1',
      stores: 'steam',
      sort: 'NAME_ASC',
      page: '2',
    })
  })

  it('round-trips', () => {
    const query = {
      genres: 'rpg',
      platforms: '4',
      gameModes: 'LOCAL_COOP',
      ageRating: 'PEGI7',
      ukrainianLocalisation: 'TEXT',
      sort: 'RELEASED_DESC',
      page: '2',
    }
    expect(serializeFilterState(parseFilterQuery(query))).toEqual(query)
  })
})

describe('countActiveFilters', () => {
  it('counts set fields', () => {
    expect(countActiveFilters({})).toBe(0)
    expect(countActiveFilters({ genres: ['rpg', 'action'], upcoming: true, search: 'x' })).toBe(3)
  })
})
