import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexedGame } from '../../server/index/document'
import { degradeOnFailure } from '../../server/index/index'
import { DEAL_POOL_SIZE } from '../../server/graphql/resolvers/dealOfTheDay'
import {
  countCalls,
  createTestCache,
  overriding,
  publishTestIndex,
  runQuery,
  TEST_INDEX_META,
  TEST_TODAY,
} from './support/yoga'

/**
 * The mascot's deal of the day, through the operation the app ships: which game it is, that it is
 * the same game all day and another one tomorrow, what it costs the index, and every way it
 * answers `null` instead of failing.
 */

const DEAL_OF_THE_DAY = readFileSync(
  resolve(process.cwd(), 'app/graphql/dealOfTheDay.graphql'),
  'utf-8',
)

interface Deal {
  id: string
  slug: string
  name: string
  cover: { url: string } | null
  price: { bestUah: number; regularUah: number | null; discountPercent: number }
}

function document(id: number, overrides: Partial<IndexedGame> = {}): IndexedGame {
  return {
    id,
    slug: `game-${id}`,
    name: `Game ${id}`,
    cover: `https://media.rawg.io/media/games/${id}.jpg`,
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

const onSale = (percent: number): Partial<IndexedGame> => ({
  priceUah: 1_000 - percent * 10,
  regularPriceUah: 1_000,
  discountPercent: percent,
})

/** Three games that qualify — −90 %, −70 % and −50 % — among five that do not. */
const CATALOG = [
  document(1, onSale(70)),
  document(2, onSale(90)),
  document(3, onSale(50)),
  // One percent short of a deal.
  document(4, onSale(49)),
  // Deep discounts on games critics did not rate highly enough, or did not rate at all.
  document(5, { ...onSale(95), metacritic: 74 }),
  document(6, { ...onSale(95), metacritic: null }),
  // A free game is not a deal, whatever its record says about a discount.
  document(7, { priceUah: 0, regularPriceUah: 500, discountPercent: 100, free: true }),
  document(8),
]
/** The qualifying games in the order the pick walks them: biggest discount first. */
const QUALIFYING_IDS = ['2', '1', '3']

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

async function dealOf(context: Parameters<typeof runQuery>[0]): Promise<Deal | null> {
  const { data, errors } = await runQuery(context, DEAL_OF_THE_DAY)
  expect(errors).toBeUndefined()
  return data!.dealOfTheDay as Deal | null
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the deal of the day', () => {
  it('is a well-reviewed, paid game at half price or better, with what the greeter shows', async () => {
    const index = await publishTestIndex(CATALOG)
    const deal = (await dealOf({ index }))!
    expect(QUALIFYING_IDS).toContain(deal.id)
    const percent = deal.price.discountPercent
    expect(deal).toEqual({
      id: deal.id,
      slug: `game-${deal.id}`,
      name: `Game ${deal.id}`,
      cover: { url: `https://media.rawg.io/media/games/${deal.id}.jpg` },
      price: { bestUah: 1_000 - percent * 10, regularUah: 1_000, discountPercent: percent },
    })
  })

  it('is the same game for every request on one date', async () => {
    const index = await publishTestIndex(CATALOG)
    const first = await dealOf({ index })
    const second = await dealOf({ index, now: `${TEST_TODAY}T23:59:00.000Z` })
    expect(second).toEqual(first)
  })

  it('moves to the next biggest discount each day and comes round again', async () => {
    const index = await publishTestIndex(CATALOG)
    const ids: string[] = []
    for (let offset = 0; offset < 6; offset += 1) {
      const today = addDays(TEST_TODAY, offset)
      // The prices stay as fresh as on the first day: only the date moves.
      const deal = await dealOf({ index, today })
      ids.push(deal!.id)
    }
    const start = QUALIFYING_IDS.indexOf(ids[0]!)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(ids).toEqual(
      ids.map((_, offset) => QUALIFYING_IDS[(start + offset) % QUALIFYING_IDS.length]),
    )
    // Never the same game two days running, and never one that does not qualify.
    expect(new Set(ids)).toEqual(new Set(QUALIFYING_IDS))
  })

  it('picks from the twenty biggest discounts only', async () => {
    // Thirty qualifying games, −99 % down to −70 %: ids 1–20 hold the twenty biggest.
    const many = Array.from({ length: 30 }, (_, position) =>
      document(position + 1, onSale(99 - position)),
    )
    const index = await publishTestIndex(many)
    const seen = new Set<number>()
    for (let offset = 0; offset < 40; offset += 1) {
      seen.add(Number((await dealOf({ index, today: addDays(TEST_TODAY, offset) }))!.id))
    }
    expect(DEAL_POOL_SIZE).toBe(20)
    expect([...seen].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, position) => position + 1),
    )
  })
})

describe('what the deal of the day asks the index', () => {
  it('reads the metadata once and one page of the biggest discounts', async () => {
    const index = countCalls(await publishTestIndex(CATALOG))
    await dealOf({ index })
    expect(index.calls.meta).toBe(1)
    expect(index.calls.getMany).toEqual([])
    expect(index.calls.getOne).toEqual([])
    expect(index.calls.search).toHaveLength(1)
    expect(index.calls.search[0]).toMatchObject({
      onSaleMinPercent: 50,
      metacriticMin: 75,
      sort: 'DISCOUNT_DESC',
      page: 1,
      pageSize: 20,
    })
  })

  it('costs one page read however many times one document repeats the field', async () => {
    const index = countCalls(await publishTestIndex(CATALOG))
    const aliases = Array.from({ length: 12 }, (_, n) => `d${n}: dealOfTheDay { id }`).join(' ')
    const { data, errors } = await runQuery({ index }, `{ ${aliases} }`)
    expect(errors).toBeUndefined()
    expect(new Set(Object.values(data!).map((deal) => deal.id)).size).toBe(1)
    expect(index.calls.meta).toBe(1)
    expect(index.calls.search).toHaveLength(1)
  })

  it('serves a repeated request from the page cache, under the index page key', async () => {
    const cache = createTestCache()
    const index = countCalls(await publishTestIndex(CATALOG))
    const first = await dealOf({ index, cache })
    const second = await dealOf({ index, cache })
    expect(second).toEqual(first)
    expect(index.calls.search).toHaveLength(1)
    expect(cache.writes).toHaveLength(1)
    const [key, ttl] = cache.writes[0]!
    expect(key.startsWith('index-page:')).toBe(true)
    expect(key).toContain('"version":1')
    expect(ttl).toBe(600)
  })
})

describe('no deal of the day', () => {
  it('when nothing qualifies', async () => {
    const index = await publishTestIndex(CATALOG.filter((game) => game.id > 3))
    expect(await dealOf({ index })).toBeNull()
  })

  it('when the index has published nothing, without searching it', async () => {
    const index = countCalls(
      overriding(await publishTestIndex(CATALOG), { meta: async () => null }),
    )
    expect(await dealOf({ index })).toBeNull()
    expect(index.calls.search).toEqual([])
  })

  it('when the prices are stale, without searching for them', async () => {
    const stale = { ...TEST_INDEX_META, pricesUpdatedAt: '2026-09-01T06:00:00.000Z' }
    const index = countCalls(await publishTestIndex(CATALOG, stale))
    expect(await dealOf({ index })).toBeNull()
    expect(index.calls.search).toEqual([])
  })

  it('when the metadata cannot be read, with one warning and no error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await publishTestIndex(CATALOG)
    const index = overriding(store, { meta: () => Promise.reject(new Error('ECONNRESET')) })
    expect(await dealOf({ index })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('when the search fails, with one warning and no error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await publishTestIndex(CATALOG)
    const failing = overriding(store, { search: () => Promise.reject(new Error('ECONNRESET')) })
    expect(await dealOf({ index: degradeOnFailure(failing) })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('when the result cache itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = await publishTestIndex(CATALOG)
    const cache = {
      get: () => Promise.reject(new Error('cache down')),
      set: async () => {},
    }
    expect(await dealOf({ index, cache })).toBeNull()
  })
})

describe('the deal of the day beside the landing', () => {
  it('answers in one request with the landing, sharing its one metadata read', async () => {
    const index = countCalls(await publishTestIndex(CATALOG))
    const { data, errors } = await runQuery(
      { index },
      /* GraphQL */ `
        {
          landing {
            totalGames
          }
          dealOfTheDay {
            id
          }
        }
      `,
    )
    expect(errors).toBeUndefined()
    expect(QUALIFYING_IDS).toContain(data!.dealOfTheDay.id)
    expect(index.calls.meta).toBe(1)
  })
})
