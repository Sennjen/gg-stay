import { describe, expect, it } from 'vitest'
import { filterToParams } from '../../server/rawg/filterToParams'

const base = { sort: 'POPULARITY_DESC', page: 1, pageSize: 20, today: '2026-09-18' } as const

describe('filterToParams', () => {
  it('sets ordering and pagination with no filter', () => {
    expect(filterToParams({ ...base, filter: null })).toEqual({
      ordering: '-added',
      page: 1,
      page_size: 20,
    })
  })

  it.each([
    ['POPULARITY_DESC', '-added'],
    ['RATING_DESC', '-rating'],
    ['METACRITIC_DESC', '-metacritic'],
    ['RELEASED_DESC', '-released'],
    ['RELEASED_ASC', 'released'],
    ['NAME_ASC', 'name'],
    ['PRICE_ASC', '-added'],
    ['DISCOUNT_DESC', '-added'],
  ] as const)('maps sort %s to ordering %s', (sort, ordering) => {
    expect(filterToParams({ ...base, sort, filter: null }).ordering).toBe(ordering)
  })

  it.each([
    [{ search: '  witcher ' }, { search: 'witcher' }],
    [{ genres: ['action', 'indie'] }, { genres: 'action,indie' }],
    [{ platforms: [4, 7] }, { platforms: '4,7' }],
    [{ yearFrom: 2015, yearTo: 2017 }, { dates: '2015-01-01,2017-12-31' }],
    [{ yearFrom: 2020 }, { dates: '2020-01-01,2099-12-31' }],
    [{ yearTo: 1999 }, { dates: '1970-01-01,1999-12-31' }],
    [{ upcoming: true, yearFrom: 2001 }, { dates: '2026-09-19,2099-12-31' }],
    [{ metacriticMin: 80 }, { metacritic: '80,100' }],
    [{ stores: ['steam', 'gog', 'unknown'] }, { stores: '1,5' }],
    [{ developers: ['cd-projekt-red'] }, { developers: 'cd-projekt-red' }],
    [{ publishers: ['valve'] }, { publishers: 'valve' }],
    [{ gameModes: ['LOCAL_COOP'], tags: ['open-world'] }, { tags: 'local-co-op,open-world' }],
  ])('maps %j', (filter, expected) => {
    expect(filterToParams({ ...base, filter })).toMatchObject(expected)
  })

  it('ignores post-filter and index-backed fields', () => {
    const params = filterToParams({
      ...base,
      filter: {
        ratingMin: 4,
        playtime: 'LONG',
        ageRating: ['PEGI7'],
        priceMaxUah: 300,
        free: true,
      },
    })
    expect(params).toEqual({ ordering: '-added', page: 1, page_size: 20 })
  })
})
