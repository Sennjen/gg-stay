import { describe, expect, it, vi } from 'vitest'
import { MAX_PAGE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH } from '../../shared/catalog'
import { UpstreamError } from '../../server/upstream/errors'
import type { RawgFetch } from '../../server/rawg/rawgFetch'
import type { SteamFetch } from '../../server/steam/steamFetch'
import { fixtureRawg, fixtureSteam, runQuery, type QueryResult } from './support/yoga'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json'
import stardewDetail from '../fixtures/rawg/game-stardew-valley.json'

/**
 * The BFF's contract, for everything the price and localisation index does not decide. The index
 * this suite runs against is one that was never published, which is the shape a deployment starts
 * in: every card comes back without a price and without a language list, exactly as it did before
 * the index existed. The paths the index does decide are in `indexResolvers.test.ts`.
 */

async function run(
  rawg: RawgFetch,
  query: string,
  variables: Record<string, unknown> = {},
  steam: SteamFetch = fixtureSteam,
): Promise<QueryResult> {
  return runQuery({ rawg, steam }, query, variables)
}

const GAMES = /* GraphQL */ `
  query Games($filter: GameFilter, $sort: GameSort, $page: Int, $pageSize: Int) {
    games(filter: $filter, sort: $sort, page: $page, pageSize: $pageSize) {
      total
      page
      pageSize
      hasNext
      indexedOnly
      indexStale
      indexUpdatedAt
      items {
        id
        slug
        name
        price {
          bestUah
        }
        localisation {
          text
          audio
          source
        }
        madeInUkraine
      }
    }
  }
`

describe('Query.games', () => {
  it('returns mapped cards with index-backed fields empty', async () => {
    const { data, errors } = await run(fixtureRawg, GAMES)
    expect(errors).toBeUndefined()
    expect(data!.games).toMatchObject({
      total: 4,
      page: 1,
      pageSize: 20,
      hasNext: false,
      indexedOnly: false,
      indexStale: false,
      indexUpdatedAt: null,
    })
    expect(data!.games.items).toHaveLength(4)
    expect(data!.games.items[0]).toEqual({
      id: '3328',
      slug: 'the-witcher-3-wild-hunt',
      name: 'The Witcher 3: Wild Hunt',
      price: null,
      localisation: null,
      madeInUkraine: false,
    })
  })

  it.each(['ANY', 'TEXT', 'AUDIO'])(
    'accepts %s as the Ukrainian localisation level',
    async (level) => {
      const { errors } = await run(fixtureRawg, GAMES, {
        filter: { ukrainianLocalisation: level },
      })
      expect(errors).toBeUndefined()
    },
  )

  // Steam reports "supported" and "full audio" only, so the schema has two levels; the interface
  // and subtitles levels it used to name were never served and cannot be told apart.
  it.each(['INTERFACE', 'SUBTITLES'])('rejects %s as a localisation level', async (level) => {
    const { errors } = await run(fixtureRawg, GAMES, { filter: { ukrainianLocalisation: level } })
    expect(errors?.[0]?.message).toContain(level)
  })

  it('passes filter, sort and pagination to RAWG', async () => {
    const rawg = vi.fn(fixtureRawg)
    await run(rawg, GAMES, {
      filter: { genres: ['indie'], platforms: [7] },
      sort: 'RELEASED_DESC',
      page: 2,
    })
    expect(rawg).toHaveBeenCalledWith('games', {
      ordering: '-released',
      page: 2,
      page_size: 20,
      genres: 'indie',
      platforms: '7',
    })
  })

  it('applies post-filters to the fetched page', async () => {
    const { data } = await run(fixtureRawg, GAMES, { filter: { playtime: 'LONG' } })
    expect(data!.games.items.map((item: { slug: string }) => item.slug)).toEqual([
      'the-witcher-3-wild-hunt',
    ])
  })

  it('clamps pageSize to 40', async () => {
    const rawg = vi.fn(fixtureRawg)
    const { data } = await run(rawg, GAMES, { pageSize: 500 })
    expect(rawg.mock.calls[0]![1]).toMatchObject({ page_size: MAX_PAGE_SIZE })
    expect(data!.games.pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('caps every attacker-controlled part of the upstream cache key', async () => {
    const rawg = vi.fn(fixtureRawg)
    await run(rawg, GAMES, {
      filter: { search: 'w'.repeat(5_000) },
      pageSize: 10_000,
      page: 2,
    })
    // Unbounded key material would mint one permanent cache entry per distinct request.
    expect(rawg.mock.calls[0]![1]).toMatchObject({
      search: 'w'.repeat(MAX_SEARCH_LENGTH),
      page_size: MAX_PAGE_SIZE,
      page: 2,
    })
  })

  it('refuses a page past the maximum without calling upstream', async () => {
    const rawg = vi.fn(fixtureRawg)
    const { data } = await run(rawg, GAMES, { page: MAX_PAGE + 1 })
    expect(rawg).not.toHaveBeenCalled()
    expect(data!.games).toMatchObject({ items: [], total: 0 })
  })

  it.each([0, -3, 501])('returns an empty page for page=%i without calling RAWG', async (page) => {
    const rawg = vi.fn(fixtureRawg)
    const { data, errors } = await run(rawg, GAMES, { page })
    expect(errors).toBeUndefined()
    expect(data!.games).toMatchObject({ items: [], total: 0, hasNext: false })
    expect(rawg).not.toHaveBeenCalled()
  })
})

describe('Query.game', () => {
  const GAME = /* GraphQL */ `
    query Game($slug: String!) {
      game(slug: $slug) {
        slug
        name
        ageRating
        gameModes
        stores {
          store
          url
          priceUah
        }
        similar {
          id
        }
        screenshots {
          url
        }
      }
    }
  `

  it('returns detail with store links and screenshots', async () => {
    const { data, errors } = await run(fixtureRawg, GAME, { slug: 'the-witcher-3-wild-hunt' })
    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({
      slug: 'the-witcher-3-wild-hunt',
      ageRating: 'PEGI18',
      gameModes: ['SINGLE'],
      similar: [],
    })
    expect(data!.game.stores.map((offer: { store: string }) => offer.store)).toEqual([
      'steam',
      'gog',
    ])
    expect(data!.game.screenshots).toEqual([
      { url: 'https://media.rawg.io/media/screenshots/201001/full1.jpg' },
      { url: 'https://media.rawg.io/media/screenshots/201002/full2.jpg' },
      { url: 'https://media.rawg.io/media/screenshots/201003/full3.jpg' },
    ])
  })

  it('still returns the game when the store-links call fails', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path.endsWith('/stores')) throw new UpstreamError('RAWG', 'ERROR', 500)
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, GAME, { slug: 'the-witcher-3-wild-hunt' })
    expect(errors).toBeUndefined()
    expect(data!.game.stores).toEqual([])
  })

  it('still returns the game, with empty screenshots, when the screenshots call fails', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path.endsWith('/screenshots')) throw new UpstreamError('RAWG', 'ERROR', 500)
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, GAME, { slug: 'the-witcher-3-wild-hunt' })
    expect(errors).toBeUndefined()
    expect(data!.game.screenshots).toEqual([])
  })

  it('reports NOT_FOUND for an unknown slug', async () => {
    const { data, errors } = await run(fixtureRawg, GAME, { slug: 'nope' })
    expect(data!.game).toBeNull()
    expect(errors![0]!.extensions!.code).toBe('NOT_FOUND')
  })
})

describe('Game.localizedDescription', () => {
  const LOCALIZED_GAME = /* GraphQL */ `
    query LocalizedGame($slug: String!, $locale: String!) {
      game(slug: $slug) {
        slug
        localizedDescription(locale: $locale) {
          text
          language
          source
        }
      }
    }
  `

  it('returns the Ukrainian Steam text for locale "uk" when the publisher localised the page', async () => {
    const { data, errors } = await run(fixtureRawg, LOCALIZED_GAME, {
      slug: 'the-witcher-3-wild-hunt',
      locale: 'uk',
    })
    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription.language).toBe('uk')
    expect(data!.game.localizedDescription.source).toBe('STEAM')
    expect(data!.game.localizedDescription.text).toContain('Ґеральт із Рівії')
    expect(data!.game.localizedDescription.text).toContain('• Ґанок рідної домівки')
  })

  it('returns the RAWG English text for locale "en"', async () => {
    const { data, errors } = await run(fixtureRawg, LOCALIZED_GAME, {
      slug: 'the-witcher-3-wild-hunt',
      locale: 'en',
    })
    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual({
      text: detail.description_raw,
      language: 'en',
      source: 'RAWG',
    })
  })

  it('does not call Steam for locale "en"', async () => {
    const steam = vi.fn(fixtureSteam)
    const { errors } = await run(
      fixtureRawg,
      LOCALIZED_GAME,
      {
        slug: 'the-witcher-3-wild-hunt',
        locale: 'en',
      },
      steam,
    )
    expect(errors).toBeUndefined()
    expect(steam).not.toHaveBeenCalled()
  })

  it('does not call Steam when the field is not selected', async () => {
    const steam = vi.fn(fixtureSteam)
    const { errors } = await run(
      fixtureRawg,
      /* GraphQL */ `
        query Game($slug: String!) {
          game(slug: $slug) {
            slug
            description
          }
        }
      `,
      { slug: 'the-witcher-3-wild-hunt' },
      steam,
    )
    expect(errors).toBeUndefined()
    expect(steam).not.toHaveBeenCalled()
  })

  it('falls back to RAWG English when Steam silently served English text (Stardew Valley)', async () => {
    const { data, errors } = await run(fixtureRawg, LOCALIZED_GAME, {
      slug: 'stardew-valley',
      locale: 'uk',
    })
    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual({
      text: stardewDetail.description_raw,
      language: 'en',
      source: 'RAWG',
    })
  })

  it('falls back to RAWG English, without failing the query, when Steam fails', async () => {
    const steam: SteamFetch = async () => {
      throw new UpstreamError('RAWG', 'ERROR', 500)
    }
    const { data, errors } = await run(
      fixtureRawg,
      LOCALIZED_GAME,
      {
        slug: 'the-witcher-3-wild-hunt',
        locale: 'uk',
      },
      steam,
    )
    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual({
      text: detail.description_raw,
      language: 'en',
      source: 'RAWG',
    })
  })

  it('falls back to RAWG English when the game has no Steam store link', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path === 'games/the-witcher-3-wild-hunt/stores') return { count: 0, results: [] }
      return fixtureRawg(path, params)
    }
    const steam = vi.fn(fixtureSteam)
    const { data, errors } = await run(
      rawg,
      LOCALIZED_GAME,
      {
        slug: 'the-witcher-3-wild-hunt',
        locale: 'uk',
      },
      steam,
    )
    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual({
      text: detail.description_raw,
      language: 'en',
      source: 'RAWG',
    })
    expect(steam).not.toHaveBeenCalled()
  })
})

describe('GameCard.screenshots / platformFamilies', () => {
  const CARD_FIELDS = /* GraphQL */ `
    query Games {
      games {
        items {
          slug
          screenshots {
            url
          }
          platformFamilies
        }
      }
    }
  `

  it('excludes the id -1 entry, caps at 4, and orders platform families', async () => {
    const { data, errors } = await run(fixtureRawg, CARD_FIELDS)
    expect(errors).toBeUndefined()
    const witcher = data!.games.items.find(
      (item: { slug: string }) => item.slug === 'the-witcher-3-wild-hunt',
    )
    expect(witcher.screenshots).toHaveLength(4)
    expect(witcher.platformFamilies).toEqual(['PC', 'PLAYSTATION', 'NINTENDO'])

    const unreleased = data!.games.items.find(
      (item: { slug: string }) => item.slug === 'unreleased-sample',
    )
    expect(unreleased.screenshots).toEqual([])
    expect(unreleased.platformFamilies).toEqual([])
  })
})

describe('Query.landing', () => {
  const LANDING = /* GraphQL */ `
    query Landing {
      landing {
        totalGames
        featured {
          game {
            slug
          }
          clipUrl
          clipSource
        }
        carousel {
          slug
        }
        newReleases {
          slug
        }
        topRated {
          slug
        }
      }
    }
  `

  // RAWG has no clip for the featured game in these fixtures (game-3328-movies.json is empty on
  // purpose, so the fixture-mode e2e app exercises the Steam fallback path end to end — see the
  // comment above `fixtureSteam`). Its Steam store link (in
  // game-the-witcher-3-wild-hunt-stores.json) resolves to app id 292030.
  it('falls back to the Steam clip when RAWG has none, a cover-only carousel and capped lists', async () => {
    const { data, errors } = await run(fixtureRawg, LANDING)
    expect(errors).toBeUndefined()
    expect(data!.landing.totalGames).toBe(4)
    expect(data!.landing.featured).toEqual({
      game: { slug: 'the-witcher-3-wild-hunt' },
      clipUrl:
        'https://video.akamai.steamstatic.com/store_trailers/256813023/movie_hls/hls_264_master.m3u8?t=1234567891',
      clipSource: 'STEAM',
    })
    expect(data!.landing.carousel).toEqual([{ slug: 'the-witcher-3-wild-hunt' }])
    expect(data!.landing.topRated.map((item: { slug: string }) => item.slug)).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'stardew-valley',
    ])
    expect(data!.landing.newReleases).toHaveLength(4)
  })

  it('prefers the RAWG clip when present, without calling Steam', async () => {
    const rawgMovies = {
      count: 1,
      results: [{ id: 1, data: { '480': 'https://media.rawg.io/media/movies/1/movie480.mp4' } }],
    }
    const rawg: RawgFetch = async (path, params) => {
      if (path === 'games/3328/movies') return rawgMovies
      return fixtureRawg(path, params)
    }
    const steam = vi.fn(fixtureSteam)
    const { data, errors } = await run(rawg, LANDING, {}, steam)
    expect(errors).toBeUndefined()
    expect(data!.landing.featured).toMatchObject({
      clipUrl: 'https://media.rawg.io/media/movies/1/movie480.mp4',
      clipSource: 'RAWG',
    })
    expect(steam).not.toHaveBeenCalled()
  })

  it('returns clipUrl: null, clipSource: null when there is no Steam store link', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path === 'games/the-witcher-3-wild-hunt/stores') {
        return { count: 0, results: [] }
      }
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, LANDING)
    expect(errors).toBeUndefined()
    expect(data!.landing.featured).toMatchObject({ clipUrl: null, clipSource: null })
  })

  it('returns clipUrl: null and the query still succeeds when Steam fails', async () => {
    const steam: SteamFetch = async () => {
      throw new UpstreamError('RAWG', 'ERROR', 500)
    }
    const { data, errors } = await run(fixtureRawg, LANDING, {}, steam)
    expect(errors).toBeUndefined()
    expect(data!.landing.featured).toMatchObject({ clipUrl: null, clipSource: null })
  })

  it('calls Steam exactly once for an uncached landing query', async () => {
    const steam = vi.fn(fixtureSteam)
    const { errors } = await run(fixtureRawg, LANDING, {}, steam)
    expect(errors).toBeUndefined()
    expect(steam).toHaveBeenCalledTimes(1)
  })

  it('returns clipUrl: null without failing the query when the RAWG movies call fails, then falls back to Steam', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path.endsWith('/movies')) throw new UpstreamError('RAWG', 'ERROR', 500)
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, LANDING)
    expect(errors).toBeUndefined()
    expect(data!.landing.featured.clipSource).toBe('STEAM')
  })

  it.each([
    ['RATE_LIMITED', 'UPSTREAM_RATE_LIMITED'],
    ['TIMEOUT', 'UPSTREAM_TIMEOUT'],
    ['ERROR', 'UPSTREAM_ERROR'],
  ] as const)(
    'fails the whole query with %s when the games list call fails',
    async (kind, code) => {
      const rawg: RawgFetch = async () => {
        throw new UpstreamError('RAWG', kind)
      }
      const { errors } = await run(rawg, LANDING)
      expect(errors![0]!.extensions!.code).toBe(code)
    },
  )
})

describe('taxonomies', () => {
  it('returns genres, platforms and developer search results', async () => {
    const rawg = vi.fn(fixtureRawg)
    const { data } = await run(
      rawg,
      /* GraphQL */ `
        {
          genres {
            id
            slug
            name
          }
          platforms {
            slug
          }
          developers(search: "  cd ") {
            slug
          }
        }
      `,
    )
    expect(data!.genres[0]).toEqual({ id: '4', slug: 'action', name: 'Action' })
    expect(data!.platforms).toHaveLength(8)
    expect(data!.developers[0].slug).toBe('cd-projekt-red')
    expect(rawg).toHaveBeenCalledWith('developers', { search: 'cd', page_size: 10 })
  })

  it('caps the developer search term before it reaches the upstream cache key', async () => {
    const rawg = vi.fn(fixtureRawg)
    await run(
      rawg,
      /* GraphQL */ `
        query Developers($search: String!) {
          developers(search: $search) {
            slug
          }
        }
      `,
      { search: 'c'.repeat(5_000) },
    )
    expect(rawg).toHaveBeenCalledWith('developers', {
      search: 'c'.repeat(MAX_SEARCH_LENGTH),
      page_size: 10,
    })
  })

  it('returns no developers for a search shorter than 2 characters', async () => {
    const rawg = vi.fn(fixtureRawg)
    const { data } = await run(
      rawg,
      /* GraphQL */ `
        {
          developers(search: "a") {
            slug
          }
        }
      `,
    )
    expect(data!.developers).toEqual([])
    expect(rawg).not.toHaveBeenCalled()
  })
})

describe('error mapping', () => {
  const RESOLVER_QUERIES = {
    games: { query: GAMES, variables: {} },
    game: {
      query: /* GraphQL */ `
        query Game($slug: String!) {
          game(slug: $slug) {
            slug
          }
        }
      `,
      variables: { slug: 'the-witcher-3-wild-hunt' },
    },
    genres: {
      query: /* GraphQL */ `
        {
          genres {
            slug
          }
        }
      `,
      variables: {},
    },
    platforms: {
      query: /* GraphQL */ `
        {
          platforms {
            slug
          }
        }
      `,
      variables: {},
    },
    developers: {
      query: /* GraphQL */ `
        {
          developers(search: "abc") {
            slug
          }
        }
      `,
      variables: {},
    },
  } as const

  const KINDS = [
    ['RATE_LIMITED', 'UPSTREAM_RATE_LIMITED'],
    ['TIMEOUT', 'UPSTREAM_TIMEOUT'],
    ['ERROR', 'UPSTREAM_ERROR'],
  ] as const

  const CASES = Object.keys(RESOLVER_QUERIES).flatMap((resolver) =>
    KINDS.map(([kind, code]) => [resolver, kind, code] as const),
  )

  it.each(CASES)('maps %s resolver upstream %s to %s', async (resolver, kind, code) => {
    // Fails for every path (the "games"/"genres"/"platforms"/"developers" list call, and, for
    // `game`, the detail call at "games/<slug>") so each resolver's own error handling is
    // exercised directly, not just its store-links enhancement call.
    const rawg: RawgFetch = async () => {
      throw new UpstreamError('RAWG', kind)
    }
    const { query, variables } = RESOLVER_QUERIES[resolver]
    const { errors } = await run(rawg, query, variables)
    expect(errors![0]!.extensions!.code).toBe(code)
  })

  it('masks unexpected errors as UPSTREAM_ERROR without leaking the message', async () => {
    const rawg: RawgFetch = async () => {
      throw new Error('secret internals')
    }
    const { errors } = await run(rawg, GAMES)
    expect(errors![0]!.extensions!.code).toBe('UPSTREAM_ERROR')
    expect(errors![0]!.message).not.toContain('secret')
  })
})
