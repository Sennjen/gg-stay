import { describe, expect, it } from 'vitest'
import { MAX_SEARCH_LENGTH } from '../../shared/catalog'
import { pageCacheKey, toIndexQuery } from '../../server/graphql/indexPath'
import { planQuery } from '../../server/index/queryPlan'
import type { GameFilter, GameSort } from '../../server/graphql/__generated__/resolvers-types'

/**
 * The translation from a `GameFilter` the client sent to the `IndexQuery` an adapter executes.
 * Two fields are easy to get wrong later and are pinned twice, here and against `planQuery`:
 * `ratingMin`, which must stay on the schema's 0–5 scale because the plan is what multiplies it
 * by a hundred, and `stores`, which is slugs on the index and ids on the RAWG path.
 */

const TODAY = '2026-09-18'

const query = (filter: GameFilter | null, sort: GameSort = 'POPULARITY_DESC', page = 1) =>
  toIndexQuery({ filter, sort, page, pageSize: 20, today: TODAY })

describe('toIndexQuery, field by field', () => {
  const cases: [name: string, filter: GameFilter, expected: Record<string, unknown>][] = [
    ['genres as slugs', { genres: ['indie', 'action'] }, { genres: ['action', 'indie'] }],
    ['platforms as RAWG ids', { platforms: [187, 4] }, { platforms: [4, 187] }],
    ['stores as slugs, never ids', { stores: ['steam', 'gog'] }, { stores: ['gog', 'steam'] }],
    [
      'game modes as the schema spells them',
      { gameModes: ['ONLINE_COOP', 'SINGLE'] },
      { gameModes: ['ONLINE_COOP', 'SINGLE'] },
    ],
    ['age ratings', { ageRating: ['PEGI18', 'PEGI3'] }, { ageRating: ['PEGI18', 'PEGI3'] }],
    ['a playtime bucket', { playtime: 'MEDIUM' }, { playtime: 'MEDIUM' }],
    ['a year range', { yearFrom: 2015, yearTo: 2018 }, { yearFrom: 2015, yearTo: 2018 }],
    ['a Metacritic floor', { metacriticMin: 80 }, { metacriticMin: 80 }],
    // Unscaled on purpose: `planQuery` is what turns 4 into the 400 the range set is scored in.
    ['a rating floor, unscaled', { ratingMin: 4 }, { ratingMin: 4 }],
    ['a price ceiling', { priceMaxUah: 600 }, { priceMaxUah: 600 }],
    ['a discount floor', { onSaleMinPercent: 50 }, { onSaleMinPercent: 50 }],
    [
      'the localisation level',
      { ukrainianLocalisation: 'AUDIO' },
      { ukrainianLocalisation: 'AUDIO' },
    ],
    ['the free box, when checked', { free: true }, { free: true }],
    // An unchecked box narrows nothing, in the query exactly as in the path selection.
    ['the free box, when not', { free: false }, { free: false }],
    ['the made-in-Ukraine box', { madeInUkraine: true }, { madeInUkraine: true }],
  ]

  it.each(cases)('carries %s', (_name, filter, expected) => {
    expect(query(filter)).toMatchObject(expected)
  })

  it('carries the whole filter at once, and nothing else', () => {
    const full: GameFilter = {
      search: '  Witcher  ',
      genres: ['rpg'],
      platforms: [4],
      stores: ['steam'],
      gameModes: ['SINGLE'],
      ageRating: ['PEGI18'],
      yearFrom: 2010,
      yearTo: 2020,
      upcoming: false,
      playtime: 'LONG',
      metacriticMin: 80,
      ratingMin: 4,
      priceMaxUah: 600,
      free: true,
      onSaleMinPercent: 25,
      ukrainianLocalisation: 'TEXT',
      madeInUkraine: true,
      developers: ['cd-projekt-red'],
      publishers: ['valve'],
      tags: ['singleplayer'],
    }
    expect(query(full, 'PRICE_ASC', 3)).toEqual({
      search: 'Witcher',
      genres: ['rpg'],
      platforms: [4],
      stores: ['steam'],
      gameModes: ['SINGLE'],
      ageRating: ['PEGI18'],
      yearFrom: 2010,
      yearTo: 2020,
      upcoming: false,
      today: TODAY,
      playtime: 'LONG',
      metacriticMin: 80,
      ratingMin: 4,
      priceMaxUah: 600,
      free: true,
      onSaleMinPercent: 25,
      ukrainianLocalisation: 'TEXT',
      madeInUkraine: true,
      sort: 'PRICE_ASC',
      page: 3,
      pageSize: 20,
    })
  })

  it('leaves the filters the index has no facet for out of the query entirely', () => {
    const built = query({ developers: ['valve'], publishers: ['valve'], tags: ['co-op'] })
    expect(built).not.toHaveProperty('developers')
    expect(built).not.toHaveProperty('publishers')
    expect(built).not.toHaveProperty('tags')
  })

  it('always hands the index the request own date, so no adapter reads a clock', () => {
    expect(query({ upcoming: true }).today).toBe(TODAY)
    expect(query(null).today).toBe(TODAY)
    // `planQuery` refuses an upcoming query without one, which is what makes this load-bearing.
    expect(() => planQuery(1, { ...query({ upcoming: true }), today: undefined })).toThrow(
      TypeError,
    )
    expect(() => planQuery(1, query({ upcoming: true }))).not.toThrow()
  })

  it('trims a search term and caps it at the length the RAWG path caps it at', () => {
    expect(query({ search: '  the witcher \n' }).search).toBe('the witcher')
    expect(query({ search: 'x'.repeat(MAX_SEARCH_LENGTH + 40) }).search).toHaveLength(
      MAX_SEARCH_LENGTH,
    )
    expect(query({ search: '   ' }).search).toBeUndefined()
    expect(query({}).search).toBeUndefined()
  })

  it('drops an empty multi-select rather than sending an empty facet group', () => {
    const built = query({ genres: [], platforms: [], stores: [] })
    expect(built.genres).toBeUndefined()
    expect(built.platforms).toBeUndefined()
    expect(built.stores).toBeUndefined()
    expect(planQuery(1, built).facetGroups).toEqual([])
  })

  it('reads a null field as an absent one, because the client may send either', () => {
    const built = query({ yearFrom: null, metacriticMin: null, ratingMin: null, playtime: null })
    expect(built.yearFrom).toBeUndefined()
    expect(built.metacriticMin).toBeUndefined()
    expect(built.ratingMin).toBeUndefined()
    expect(built.playtime).toBeUndefined()
  })

  it('scales the rating floor exactly once, in the plan', () => {
    const range = planQuery(1, query({ ratingMin: 4 })).ranges.find((entry) =>
      entry.key.endsWith(':r:rating'),
    )
    expect(range?.min).toBe(400)
  })
})

describe('pageCacheKey', () => {
  it('is one key for two orderings of the same multi-select', () => {
    const first = pageCacheKey(query({ genres: ['indie', 'action'], platforms: [7, 4] }), 3)
    const second = pageCacheKey(query({ genres: ['action', 'indie'], platforms: [4, 7] }), 3)
    expect(first).toBe(second)
  })

  it('carries the published version, so a publication invalidates it', () => {
    const built = query({ free: true })
    expect(pageCacheKey(built, 3)).toContain('"version":3')
    expect(pageCacheKey(built, 3)).not.toBe(pageCacheKey(built, 4))
  })

  it('separates pages, sorts and filters from each other', () => {
    const base = query({ free: true })
    expect(pageCacheKey(base, 1)).not.toBe(pageCacheKey(query({ free: true }, 'PRICE_ASC'), 1))
    expect(pageCacheKey(base, 1)).not.toBe(
      pageCacheKey(query({ free: true }, 'POPULARITY_DESC', 2), 1),
    )
    expect(pageCacheKey(base, 1)).not.toBe(pageCacheKey(query({ priceMaxUah: 600 }), 1))
  })
})
