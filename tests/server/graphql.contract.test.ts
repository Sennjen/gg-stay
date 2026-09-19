import { describe, expect, it, vi } from 'vitest'
import { createYogaApp } from '../../server/graphql/yoga'
import { UpstreamError, type RawgFetch } from '../../server/rawg/rawgFetch'
import games from '../fixtures/rawg/games.json'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json'
import stores from '../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json'
import screenshots from '../fixtures/rawg/game-the-witcher-3-wild-hunt-screenshots.json'
import movies from '../fixtures/rawg/game-3328-movies.json'
import genres from '../fixtures/rawg/genres.json'
import platforms from '../fixtures/rawg/platforms.json'
import developers from '../fixtures/rawg/developers.json'

const fixtureRawg: RawgFetch = async (path) => {
  if (path === 'games') return games
  if (path === 'games/the-witcher-3-wild-hunt') return detail
  if (path === 'games/the-witcher-3-wild-hunt/stores') return stores
  if (path === 'games/the-witcher-3-wild-hunt/screenshots') return screenshots
  if (path === 'games/3328/movies') return movies
  if (path === 'genres') return genres
  if (path === 'platforms') return platforms
  if (path === 'developers') return developers
  throw new UpstreamError('NOT_FOUND', 404)
}

async function run(rawg: RawgFetch, query: string, variables: Record<string, unknown> = {}) {
  const yoga = createYogaApp(() => ({ rawg, today: '2026-09-18' }))
  const response = await yoga.fetch('http://test/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads ad-hoc query shapes
    data?: Record<string, any>
    errors?: { message: string; extensions?: { code?: string } }[]
  }
}

const GAMES = /* GraphQL */ `
  query Games($filter: GameFilter, $sort: GameSort, $page: Int, $pageSize: Int) {
    games(filter: $filter, sort: $sort, page: $page, pageSize: $pageSize) {
      total
      page
      pageSize
      hasNext
      indexedOnly
      items {
        id
        slug
        name
        price {
          bestUah
        }
        localisation {
          audio
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
    expect(rawg.mock.calls[0]![1]).toMatchObject({ page_size: 40 })
    expect(data!.games.pageSize).toBe(40)
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
      if (path.endsWith('/stores')) throw new UpstreamError('ERROR', 500)
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, GAME, { slug: 'the-witcher-3-wild-hunt' })
    expect(errors).toBeUndefined()
    expect(data!.game.stores).toEqual([])
  })

  it('still returns the game, with empty screenshots, when the screenshots call fails', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path.endsWith('/screenshots')) throw new UpstreamError('ERROR', 500)
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

  it('returns the featured game with clipUrl, a cover-only carousel and capped lists', async () => {
    const { data, errors } = await run(fixtureRawg, LANDING)
    expect(errors).toBeUndefined()
    expect(data!.landing.totalGames).toBe(4)
    expect(data!.landing.featured).toEqual({
      game: { slug: 'the-witcher-3-wild-hunt' },
      clipUrl: 'https://media.rawg.io/media/movies/1/movie480.mp4',
    })
    expect(data!.landing.carousel).toEqual([{ slug: 'the-witcher-3-wild-hunt' }])
    expect(data!.landing.topRated.map((item: { slug: string }) => item.slug)).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'stardew-valley',
    ])
    expect(data!.landing.newReleases).toHaveLength(4)
  })

  it('returns clipUrl: null without failing the query when the movies call fails', async () => {
    const rawg: RawgFetch = async (path, params) => {
      if (path.endsWith('/movies')) throw new UpstreamError('ERROR', 500)
      return fixtureRawg(path, params)
    }
    const { data, errors } = await run(rawg, LANDING)
    expect(errors).toBeUndefined()
    expect(data!.landing.featured.clipUrl).toBeNull()
  })

  it.each([
    ['RATE_LIMITED', 'UPSTREAM_RATE_LIMITED'],
    ['TIMEOUT', 'UPSTREAM_TIMEOUT'],
    ['ERROR', 'UPSTREAM_ERROR'],
  ] as const)(
    'fails the whole query with %s when the games list call fails',
    async (kind, code) => {
      const rawg: RawgFetch = async () => {
        throw new UpstreamError(kind)
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
      throw new UpstreamError(kind)
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
