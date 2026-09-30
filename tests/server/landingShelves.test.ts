import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../server/index/GameIndex'
import type { IndexedGame } from '../../server/index/document'
import { degradeOnFailure, withDeadline } from '../../server/index/index'
import type { RawgFetch, RawgParams } from '../../server/rawg/rawgFetch'
import type { RawgGameListItem } from '../../server/rawg/types'
import { SHELF_SIZE } from '../../shared/shelves'
import {
  countCalls,
  createTestCache,
  fixtureRawg,
  overriding,
  publishTestIndex,
  runQuery,
  TEST_INDEX_META,
  type CountingIndex,
} from './support/yoga'

/**
 * The landing's five shelves, through a real GraphQL operation: which shelves there are and in
 * what order, how many games each holds, which ones are left out and when, and what the index is
 * asked for to fill them — one concurrent round of searches, never one after another.
 */

const LANDING = /* GraphQL */ `
  query Landing {
    landing {
      carousel {
        slug
      }
      shelves {
        id
        games {
          id
          slug
          madeInUkraine
          price {
            bestUah
            discountPercent
          }
          localisation {
            text
            audio
          }
        }
      }
    }
  }
`

interface ShelfResult {
  id: string
  games: {
    id: string
    slug: string
    madeInUkraine: boolean
    price: { bestUah: number; discountPercent: number } | null
    localisation: { text: boolean; audio: boolean } | null
  }[]
}

function document(id: number, overrides: Partial<IndexedGame> = {}): IndexedGame {
  return {
    id,
    slug: `game-${id}`,
    name: `Game ${id}`,
    cover: null,
    preview: null,
    released: '2020-06-01',
    popularity: 100_000 - id,
    platforms: [4],
    genres: ['action'],
    stores: ['steam'],
    gameModes: ['SINGLE'],
    ageRating: null,
    rating: 4,
    ratingsCount: 100,
    metacritic: 80,
    playtime: 10,
    priceUah: 400,
    regularPriceUah: 400,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: '2026-09-18T06:00:00.000Z',
    ...overrides,
  }
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => from + offset)
}

const onSale = (percent: number): Partial<IndexedGame> => ({
  priceUah: 200,
  regularPriceUah: 800,
  discountPercent: percent,
})

/** Fourteen made in Ukraine, five in Ukrainian, five at −30 % or more and two at −20 %. */
const RICH = [
  ...range(1, 14).map((id) => document(id, { madeInUkraine: true })),
  ...range(101, 5).map((id) =>
    document(id, { localisation: { text: true, audio: id === 101, source: 'steam' } }),
  ),
  ...range(201, 5).map((id) => document(id, onSale(30 + id - 201))),
  ...range(301, 2).map((id) => document(id, onSale(20))),
]

/** One RAWG list item of this year, as the `-added` list returns it. */
function released(id: number, rating: number, ratingsCount: number): RawgGameListItem {
  return {
    id,
    slug: `this-year-${id}`,
    name: `This Year ${id}`,
    released: '2026-03-01',
    rating,
    ratings_count: ratingsCount,
    background_image: null,
  }
}

/**
 * This year's games in RAWG's `-added` order — popularity, not rating. The most added one is a
 * 5.0 with three votes, which a plain rating order would put first; 19 votes is one short of the
 * floor and 20 is exactly on it.
 */
const THIS_YEAR: RawgGameListItem[] = [
  released(5001, 5, 3),
  released(5002, 3.9, 400),
  released(5003, 4.8, 19),
  released(5004, 4.1, 20),
  ...range(5005, 12).map((id) => released(id, 3 + (id - 5005) * 0.08, 100 + id)),
]

/** The fixture RAWG, with a real list of this year's games for the "best of this year" shelf. */
const landingRawg: RawgFetch = async (path, params, options) => {
  if (path === 'games' && params?.dates === '2026-01-01,2026-12-31') {
    return { count: THIS_YEAR.length, next: null, results: THIS_YEAR }
  }
  return fixtureRawg(path, params, options)
}

function recordingRawg(inner: RawgFetch = landingRawg): RawgFetch & { calls: RawgParams[] } {
  const calls: RawgParams[] = []
  const fetch = ((path, params, options) => {
    if (path === 'games') calls.push(params ?? {})
    return inner(path, params, options)
  }) as RawgFetch & { calls: RawgParams[] }
  fetch.calls = calls
  return fetch
}

async function shelvesOf(context: Parameters<typeof runQuery>[0]): Promise<ShelfResult[]> {
  const { data, errors } = await runQuery({ rawg: landingRawg, ...context }, LANDING)
  expect(errors).toBeUndefined()
  return data!.landing.shelves as ShelfResult[]
}

function shelf(shelves: ShelfResult[], id: string): ShelfResult | undefined {
  return shelves.find((entry) => entry.id === id)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the landing shelves', () => {
  it('come in the order of the design, each with at least four games', async () => {
    const index = await publishTestIndex(RICH)
    const shelves = await shelvesOf({ index })
    expect(shelves.map((entry) => entry.id)).toEqual([
      'MADE_IN_UKRAINE',
      'UKRAINIAN',
      'ON_SALE',
      'BEST_THIS_YEAR',
      'UPCOMING',
    ])
    for (const entry of shelves) expect(entry.games.length).toBeGreaterThanOrEqual(4)
  })

  it('say which calendar year they were built for, from the request date alone', async () => {
    const index = await publishTestIndex(RICH)
    const { data, errors } = await runQuery(
      { index, rawg: landingRawg },
      /* GraphQL */ `
        {
          landing {
            year
          }
        }
      `,
    )
    expect(errors).toBeUndefined()
    // TEST_TODAY is 2026-09-18: the same year the "best of this year" request asked RAWG for.
    expect(data!.landing.year).toBe(2026)
  })

  it('hold twelve games at most, most popular first', async () => {
    const index = await publishTestIndex(RICH)
    const madeInUkraine = shelf(await shelvesOf({ index }), 'MADE_IN_UKRAINE')!
    expect(SHELF_SIZE).toBe(12)
    expect(madeInUkraine.games.map((game) => Number(game.id))).toEqual(range(1, 12))
    expect(madeInUkraine.games.every((game) => game.madeInUkraine)).toBe(true)
  })

  it('fill each index shelf with what its name promises', async () => {
    const index = await publishTestIndex(RICH)
    const shelves = await shelvesOf({ index })
    const ukrainian = shelf(shelves, 'UKRAINIAN')!
    expect(ukrainian.games.map((game) => Number(game.id))).toEqual(range(101, 5))
    expect(ukrainian.games.every((game) => game.localisation?.text)).toBe(true)
    const sale = shelf(shelves, 'ON_SALE')!
    // −30 % counts as a sale; −20 % does not.
    expect(sale.games.map((game) => Number(game.id))).toEqual(range(201, 5))
    expect(sale.games.every((game) => game.price!.discountPercent >= 30)).toBe(true)
  })

  it('leave out a shelf with fewer than four games instead of showing it half empty', async () => {
    const index = await publishTestIndex([
      ...RICH.filter((game) => game.id < 100),
      ...range(101, 3).map((id) =>
        document(id, { localisation: { text: true, audio: false, source: 'steam' } }),
      ),
      ...range(201, 4).map((id) => document(id, onSale(50))),
    ])
    const shelves = await shelvesOf({ index })
    expect(shelves.map((entry) => entry.id)).toEqual([
      'MADE_IN_UKRAINE',
      'ON_SALE',
      'BEST_THIS_YEAR',
      'UPCOMING',
    ])
  })

  it('leave out a RAWG shelf with fewer than four games, too', async () => {
    const index = await publishTestIndex(RICH)
    const rawg: RawgFetch = async (path, params, options) => {
      const answer = (await landingRawg(path, params, options)) as { results?: unknown[] }
      // The upcoming window is the only one that reaches 2099.
      if (path === 'games' && String(params?.dates ?? '').endsWith('2099-12-31')) {
        return { ...answer, results: answer.results?.slice(0, 3) }
      }
      return answer
    }
    const shelves = await shelvesOf({ index, rawg })
    expect(shelves.map((entry) => entry.id)).not.toContain('UPCOMING')
    expect(shelves.map((entry) => entry.id)).toContain('BEST_THIS_YEAR')
  })

  it('ask RAWG for this calendar year by popularity, and for future releases by popularity', async () => {
    const index = await publishTestIndex(RICH)
    const rawg = recordingRawg()
    await shelvesOf({ index, rawg })
    // Not `-rating`: over a year that surfaces games with a handful of votes. The year's forty
    // most added games are ranked by rating here instead, among those with enough votes.
    expect(rawg.calls).toContainEqual({
      ordering: '-added',
      page: 1,
      page_size: 40,
      dates: '2026-01-01,2026-12-31',
    })
    expect(rawg.calls).toContainEqual({
      ordering: '-added',
      page: 1,
      page_size: SHELF_SIZE,
      dates: '2026-09-19,2099-12-31',
    })
  })

  it('rank this year by rating among the games with at least twenty votes', async () => {
    const index = await publishTestIndex(RICH)
    const best = shelf(await shelvesOf({ index }), 'BEST_THIS_YEAR')!
    const ids = best.games.map((game) => Number(game.id))
    // The 5.0 with three votes and the 4.8 with nineteen are out; twenty votes is enough.
    expect(ids).not.toContain(5001)
    expect(ids).not.toContain(5003)
    expect(ids).toContain(5004)
    expect(ids).toHaveLength(SHELF_SIZE)
    const ratings = ids.map((id) => THIS_YEAR.find((item) => item.id === id)!.rating!)
    expect(ratings).toEqual([...ratings].sort((left, right) => right - left))
    expect(ids[0]).toBe(5004)
  })

  it('ask the index for exactly the catalog query each shelf links to', async () => {
    const index = countCalls(await publishTestIndex(RICH))
    await shelvesOf({ index })
    const asked = index.calls.search.map(({ today: _today, ...query }) => query)
    const common = { sort: 'POPULARITY_DESC', page: 1, pageSize: SHELF_SIZE }
    expect(asked).toHaveLength(3)
    expect(asked).toContainEqual(expect.objectContaining({ madeInUkraine: true, ...common }))
    expect(asked).toContainEqual(
      expect.objectContaining({ ukrainianLocalisation: 'ANY', ...common }),
    )
    expect(asked).toContainEqual(expect.objectContaining({ onSaleMinPercent: 30, ...common }))
  })
})

describe('what the landing asks the index', () => {
  it('runs the three index shelves in one concurrent round', async () => {
    const store = await publishTestIndex(RICH)
    let inFlight = 0
    let most = 0
    const index = countCalls(
      overriding(store, {
        search: async (query) => {
          inFlight += 1
          most = Math.max(most, inFlight)
          // Held for a macrotask, so a search that waited for the previous one would be seen.
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return store.search(query)
        },
      }),
    )
    await shelvesOf({ index })
    expect(index.calls.search).toHaveLength(3)
    expect(most).toBe(3)
  })

  it('reads the metadata once and attaches the RAWG cards with one document read', async () => {
    const index = countCalls(await publishTestIndex(RICH))
    await shelvesOf({ index })
    expect(index.calls.meta).toBe(1)
    expect(index.calls.getMany).toHaveLength(1)
  })

  it('serves a repeated landing from the page cache, keyed by the index version', async () => {
    const cache = createTestCache()
    const index = countCalls(await publishTestIndex(RICH))
    const first = await shelvesOf({ index, cache })
    const second = await shelvesOf({ index, cache })
    expect(second).toEqual(first)
    expect(index.calls.search).toHaveLength(3)
    expect(cache.writes).toHaveLength(3)
    for (const [key, ttl] of cache.writes) {
      expect(ttl).toBe(600)
      expect(key).toContain('"version":1')
    }
  })
})

describe('an index whose prices have gone stale', () => {
  const STALE = { ...TEST_INDEX_META, pricesUpdatedAt: '2026-09-01T06:00:00.000Z' }

  it('drops the sale shelf, keeps the other two without prices, and never searches for sales', async () => {
    const index = countCalls(await publishTestIndex(RICH, STALE))
    const shelves = await shelvesOf({ index })
    expect(shelves.map((entry) => entry.id)).toEqual([
      'MADE_IN_UKRAINE',
      'UKRAINIAN',
      'BEST_THIS_YEAR',
      'UPCOMING',
    ])
    for (const entry of shelves) expect(entry.games.every((game) => game.price === null)).toBe(true)
    expect(index.calls.search.some((query) => query.onSaleMinPercent !== undefined)).toBe(false)
  })
})

describe('an index that cannot answer', () => {
  it('leaves the index shelves out of a fresh deployment that has published nothing', async () => {
    // No metadata is how an index that was never published — or is not configured — answers.
    const unpublished: CountingIndex = countCalls(
      overriding(await publishTestIndex(RICH), { meta: async () => null }),
    )
    const shelves = await shelvesOf({ index: unpublished })
    expect(shelves.map((entry) => entry.id)).toEqual(['BEST_THIS_YEAR', 'UPCOMING'])
    expect(unpublished.calls.search).toEqual([])
  })

  it('leaves the index shelves out when the searches fail, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await publishTestIndex(RICH)
    const failing = overriding(store, { search: () => Promise.reject(new Error('ECONNRESET')) })
    const shelves = await shelvesOf({ index: degradeOnFailure(failing) })
    expect(shelves.map((entry) => entry.id)).toEqual(['BEST_THIS_YEAR', 'UPCOMING'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('renders the landing instead of hanging when the store stops answering', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const never = () => new Promise<never>(() => {})
    const store = await publishTestIndex(RICH)
    // The metadata answers, then every search hangs: the deadline turns each into a failure.
    const hanging: GameIndex = withDeadline(overriding(store, { search: never }), {
      timeoutMs: 20,
    })
    const shelves = await shelvesOf({ index: degradeOnFailure(hanging) })
    expect(shelves.map((entry) => entry.id)).toEqual(['BEST_THIS_YEAR', 'UPCOMING'])
  })
})
