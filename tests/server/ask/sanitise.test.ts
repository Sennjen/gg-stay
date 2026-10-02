import { describe, expect, it } from 'vitest'
import { readParse, readRerank, type AskParse } from '../../../server/ask/schemas'
import { catalogUrl, plainReason, sanitiseParse } from '../../../server/ask/sanitise'
import recorded from '../../fixtures/ask/recorded.json' with { type: 'json' }

/**
 * What the server does with whatever a model returned: the lenient reader drops values it does
 * not know instead of failing the request, and the sanitiser re-validates every enum and slug
 * against the live taxonomy, clamps every number to what the catalog URL accepts, and leaves the
 * filter in the exact shape `/games` parses back.
 */

const GENRES = ['action', 'indie', 'puzzle', 'role-playing-games-rpg', 'shooter', 'strategy']

const EMPTY: AskParse = {
  platforms: [],
  genres: [],
  tags: [],
  gameModes: [],
  ageRating: [],
  playtime: null,
  yearFrom: null,
  yearTo: null,
  metacriticMin: null,
  ratingMin: null,
  priceMaxUah: null,
  free: null,
  onSaleMinPercent: null,
  ukrainianLocalisation: null,
  madeInUkraine: null,
  sort: null,
  searchText: null,
  similarTo: null,
  interpretation: 'Ігри',
}

const parse = (patch: Partial<AskParse>): AskParse => ({ ...EMPTY, ...patch })

describe('readParse', () => {
  it('accepts a well-formed answer unchanged', () => {
    const answer = parse({ gameModes: ['LOCAL_COOP'], platforms: ['NINTENDO'], priceMaxUah: 500 })
    expect(readParse(answer)).toEqual(answer)
  })

  it('drops unknown enum values instead of failing the request', () => {
    const read = readParse({
      ...EMPTY,
      platforms: ['NINTENDO', 'DREAMCAST', 7],
      gameModes: ['LOCAL_COOP', 'COUCH'],
      ageRating: ['PEGI3', 'ESRB_E'],
      tags: ['horror', 'scary', 'Horror'],
      playtime: 'FOREVER',
      ukrainianLocalisation: 'SUBTITLES',
      sort: 'RANDOM',
    })
    expect(read).toMatchObject({
      platforms: ['NINTENDO'],
      gameModes: ['LOCAL_COOP'],
      ageRating: ['PEGI3'],
      tags: ['horror'],
      playtime: null,
      ukrainianLocalisation: null,
      sort: null,
    })
  })

  it('turns wrongly typed scalars into "not set" and fills missing fields', () => {
    const read = readParse({
      interpretation: 'x',
      priceMaxUah: '500',
      free: 'yes',
      yearFrom: Number.NaN,
      genres: 'action',
    })
    expect(read).toMatchObject({
      priceMaxUah: null,
      free: null,
      yearFrom: null,
      genres: [],
      platforms: [],
      similarTo: null,
    })
  })

  it.each([null, undefined, 'a string', 42, []])('refuses %j as a whole', (value) => {
    expect(readParse(value)).toBeNull()
  })
})

describe('readRerank', () => {
  it('keeps well-formed items and skips the rest', () => {
    expect(
      readRerank({
        items: [
          { id: '1', reason: 'fits' },
          { id: 2, reason: 'number id' },
          { reason: 'no id' },
          { id: '3' },
          'junk',
        ],
      }),
    ).toEqual({
      items: [
        { id: '1', reason: 'fits' },
        { id: '2', reason: 'number id' },
        { id: '3', reason: '' },
      ],
    })
  })

  it('refuses an answer without an item list', () => {
    expect(readRerank({ ids: [] })).toBeNull()
    expect(readRerank(null)).toBeNull()
  })
})

describe('sanitiseParse', () => {
  const sanitise = (patch: Partial<AskParse>) => sanitiseParse(parse(patch), { genres: GENRES })

  it('maps the acceptance query to the catalog filter', () => {
    const understood = sanitise({
      gameModes: ['LOCAL_COOP'],
      platforms: ['NINTENDO'],
      priceMaxUah: 500,
      interpretation: 'Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
    })
    expect(understood.filter).toEqual({
      gameModes: ['LOCAL_COOP'],
      platforms: [7],
      priceMaxUah: 500,
    })
    expect(understood.sort).toBe('POPULARITY_DESC')
    expect(understood.interpretation).toBe('Кооперативні ігри для двох на Nintendo Switch до 500 ₴')
  })

  it('maps every platform family to the platform ids the catalog offers', () => {
    expect(sanitise({ platforms: ['PLAYSTATION'] }).filter.platforms).toEqual([187, 18])
    expect(sanitise({ platforms: ['XBOX'] }).filter.platforms).toEqual([186, 1])
    expect(sanitise({ platforms: ['MOBILE', 'PC'] }).filter.platforms).toEqual([4, 3, 21])
  })

  it.each([
    ['an unknown slug', ['horror'], undefined],
    ['a slug in another case', ['Action'], ['action']],
    ['an injected string', ["action'); DROP TABLE games;--"], undefined],
    ['a duplicate', ['indie', 'indie'], ['indie']],
    ['a mix', ['shooter', 'nope', 'puzzle'], ['shooter', 'puzzle']],
  ])('re-validates genres against the taxonomy: %s', (_label, genres, expected) => {
    expect(sanitise({ genres }).filter.genres).toEqual(expected)
  })

  it('drops every genre when the taxonomy could not be read', () => {
    expect(sanitiseParse(parse({ genres: ['action'] }), { genres: [] }).filter.genres).toBe(
      undefined,
    )
  })

  it.each([
    ['priceMaxUah', { priceMaxUah: 499.6 }, { priceMaxUah: 500 }],
    ['priceMaxUah', { priceMaxUah: 0 }, {}],
    ['priceMaxUah', { priceMaxUah: -20 }, {}],
    ['priceMaxUah', { priceMaxUah: 10_000_000 }, { priceMaxUah: 100_000 }],
    ['onSaleMinPercent', { onSaleMinPercent: 150 }, { onSaleMinPercent: 99 }],
    ['onSaleMinPercent', { onSaleMinPercent: 0 }, {}],
    ['onSaleMinPercent', { onSaleMinPercent: 33.4 }, { onSaleMinPercent: 33 }],
    ['metacriticMin', { metacriticMin: 85 }, { metacriticMin: 80 }],
    ['metacriticMin', { metacriticMin: 140 }, { metacriticMin: 90 }],
    ['metacriticMin', { metacriticMin: 50 }, {}],
    ['ratingMin', { ratingMin: 4.5 }, { ratingMin: 4 }],
    ['ratingMin', { ratingMin: 3 }, {}],
    ['ratingMin', { ratingMin: 9 }, {}],
    ['years', { yearFrom: 2010, yearTo: 2015 }, { yearFrom: 2010, yearTo: 2015 }],
    ['years', { yearFrom: 2015, yearTo: 2010 }, { yearFrom: 2010, yearTo: 2015 }],
    ['years', { yearFrom: 1200 }, {}],
    ['years', { yearTo: 3000 }, {}],
  ] as [string, Partial<AskParse>, object][])('clamps %s: %j', (_field, patch, expected) => {
    expect(sanitise(patch).filter).toEqual(expected)
  })

  it('prefers the free box over a price ceiling, as the drawer does', () => {
    expect(sanitise({ free: true, priceMaxUah: 300 }).filter).toEqual({ free: true })
  })

  it('treats false booleans as unset', () => {
    expect(sanitise({ free: false, madeInUkraine: false }).filter).toEqual({})
  })

  it('caps and trims the free-text fields', () => {
    const understood = sanitise({
      searchText: `  ${'a'.repeat(300)}  `,
      similarTo: ` ${'b'.repeat(300)} `,
      interpretation: `  ${'в'.repeat(500)}\n\n  `,
    })
    expect(understood.filter.search).toHaveLength(100)
    expect(understood.similarTo).toHaveLength(100)
    expect(understood.interpretation).toHaveLength(200)
  })

  it('does not search for the game a "like X" query names', () => {
    const understood = sanitise({ searchText: 'Hades', similarTo: 'hades' })
    expect(understood.filter.search).toBeUndefined()
    expect(understood.similarTo).toBe('hades')
  })

  it('keeps up to three known mood tags, outside the filter and its link', () => {
    const understood = sanitise({
      tags: ['horror', 'atmospheric', 'horror', 'roguelike', 'cozy' as never, 'zombies'],
      ukrainianLocalisation: 'ANY',
    })
    expect(understood.tags).toEqual(['horror', 'atmospheric', 'roguelike'])
    expect(understood.filter).toEqual({ ukrainianLocalisation: 'ANY' })
    expect(catalogUrl(understood.filter, understood.sort, 'uk')).toBe(
      '/games?ukrainianLocalisation=ANY',
    )
  })

  it('reports an empty interpretation as none', () => {
    expect(sanitise({ interpretation: '   ' }).interpretation).toBeNull()
  })

  it('keeps an index sort', () => {
    expect(sanitise({ sort: 'PRICE_ASC' }).sort).toBe('PRICE_ASC')
  })

  it('produces a filter the catalog URL parses back unchanged', () => {
    const understood = sanitise({
      platforms: ['PC', 'NINTENDO'],
      genres: ['indie', 'action'],
      gameModes: ['SINGLE'],
      ageRating: ['PEGI12'],
      playtime: 'SHORT',
      ukrainianLocalisation: 'AUDIO',
      madeInUkraine: true,
      onSaleMinPercent: 50,
      searchText: 'metro',
      sort: 'RATING_DESC',
    })
    expect(understood.filter).toEqual({
      search: 'metro',
      genres: ['indie', 'action'],
      platforms: [4, 7],
      gameModes: ['SINGLE'],
      ageRating: ['PEGI12'],
      playtime: 'SHORT',
      onSaleMinPercent: 50,
      ukrainianLocalisation: 'AUDIO',
      madeInUkraine: true,
    })
  })
})

describe('catalogUrl', () => {
  it('builds the Ukrainian catalog URL of a filter', () => {
    expect(
      catalogUrl(
        { gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500 },
        'POPULARITY_DESC',
        'uk',
      ),
    ).toBe('/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500')
  })

  it('prefixes the English locale and carries a non-default sort', () => {
    expect(catalogUrl({ genres: ['indie', 'puzzle'] }, 'PRICE_ASC', 'en')).toBe(
      '/en/games?genres=indie,puzzle&sort=PRICE_ASC',
    )
  })

  it('encodes a search term', () => {
    expect(catalogUrl({ search: 'метро & co' }, 'POPULARITY_DESC', 'uk')).toBe(
      '/games?search=%D0%BC%D0%B5%D1%82%D1%80%D0%BE+%26+co',
    )
  })

  it('is the bare catalog for an empty filter', () => {
    expect(catalogUrl({}, 'POPULARITY_DESC', 'en')).toBe('/en/games')
  })
})

describe('plainReason', () => {
  it.each([
    'Кооператив для двох, LOCAL_COOP, 25 грн, Switch',
    'Only 499 ₴ right now',
    'Коштує 120 гривень',
    'Costs UAH 300 on sale',
    'Rated PEGI18 for its gore',
    'Fits the ONLINE_COOP filter',
    'A SOME_CODE slipped in',
    'Runs great on PC',
    'One of the best games on Nintendo Switch',
    'Повна українська озвучка на PlayStation',
  ])('rejects a reason that echoes the filter: %s', (reason) => {
    expect(plainReason(reason)).toBeNull()
  })

  it.each([
    'Хаос на кухні, де без злагодженої команди все горить',
    'A lighthouse, a storm and a keeper slowly losing his mind',
    'A steampunk city of 100 floors to climb',
    'Неквапливі головоломки з порталами під дотепні коментарі GLaDOS',
  ])('keeps a reason about the game itself: %s', (reason) => {
    expect(plainReason(reason)).toBe(reason)
  })

  it('passes every reason the recorded answers give, each within 100 characters', () => {
    const reasons = (
      recorded as { answers: { rerank?: { items: { reason: string }[] } }[] }
    ).answers
      .flatMap((answer) => answer.rerank?.items ?? [])
      .map((item) => item.reason)
    expect(reasons.length).toBeGreaterThanOrEqual(15)
    for (const reason of reasons) {
      expect(plainReason(reason)).toBe(reason)
      expect(reason.length).toBeLessThanOrEqual(100)
    }
  })
})
