import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexedGame } from '../../server/index/document'
import { degradeOnFailure } from '../../server/index/index'
import {
  countCalls,
  createTestCache,
  overriding,
  publishTestIndex,
  runQuery,
  steamPricesReturning,
  TEST_INDEX_META,
} from './support/yoga'

/**
 * `Game.similar`, read from the list the refresh job stored on the game's own index document: one
 * `getMany` for those ids, in their order, ids the version no longer holds skipped, and nothing at
 * all when fewer than four remain. The game's document is the one the game page already read, so
 * the row costs one index call more than the page.
 *
 * Without a stored list — a document published before the job computed them, or a game the index
 * does not hold — it falls back to games from the index that share at least one genre, most
 * popular first, the game itself left out, games that share a platform family with it ahead of
 * those that do not, eight at most — and nothing at all when fewer than four qualify or when the
 * index cannot answer. Stale prices only take the prices off the cards.
 *
 * The page's game is the RAWG fixture's The Witcher 3 (id 3328): genres `action` and
 * `role-playing-games-rpg`, on PC, PlayStation 5 and Nintendo Switch.
 */

const SIMILAR = /* GraphQL */ `
  query Similar($slug: String!) {
    game(slug: $slug) {
      id
      similar {
        id
        slug
        platformFamilies
        price {
          bestUah
        }
      }
    }
  }
`

const WITHOUT_SIMILAR = /* GraphQL */ `
  query Plain($slug: String!) {
    game(slug: $slug) {
      id
    }
  }
`

const WITCHER = { slug: 'the-witcher-3-wild-hunt' }

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

const THE_GAME = document(3328, { slug: 'the-witcher-3-wild-hunt', popularity: 999_999 })

/** Ten action games on PC, the most popular first, plus the Witcher itself on top of them. */
const TEN_ACTION = Array.from({ length: 10 }, (_, offset) => document(offset + 1))

async function similarOf(context: Parameters<typeof runQuery>[0]) {
  const { data, errors } = await runQuery(context, SIMILAR, WITCHER)
  expect(errors).toBeUndefined()
  return data!.game.similar as {
    id: string
    slug: string
    platformFamilies: string[]
    price: { bestUah: number } | null
  }[]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('similar games', () => {
  it('are the eight most popular games sharing a genre, without the game itself', async () => {
    const index = await publishTestIndex([THE_GAME, ...TEN_ACTION])
    const similar = await similarOf({ index })
    expect(similar.map((game) => Number(game.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(similar.every((game) => game.price?.bestUah === 400)).toBe(true)
  })

  it('count a game that shares only one of the genres, and not one that shares none', async () => {
    const index = await publishTestIndex([
      THE_GAME,
      document(1, { genres: ['role-playing-games-rpg'] }),
      document(2, { genres: ['action', 'shooter'] }),
      document(3, { genres: ['puzzle'] }),
      document(4, { genres: ['action'] }),
      document(5, { genres: ['role-playing-games-rpg', 'strategy'] }),
    ])
    const similar = await similarOf({ index })
    expect(similar.map((game) => Number(game.id))).toEqual([1, 2, 4, 5])
  })

  it('put games on a platform family the game is on ahead of the rest', async () => {
    const index = await publishTestIndex([
      THE_GAME,
      // The two most popular are Xbox-only: the Witcher is not on Xbox.
      document(1, { platforms: [186] }),
      document(2, { platforms: [1] }),
      document(3, { platforms: [187] }),
      document(4, { platforms: [7] }),
      document(5, { platforms: [4] }),
      document(6, { platforms: [4, 186] }),
    ])
    const similar = await similarOf({ index })
    expect(similar.map((game) => Number(game.id))).toEqual([3, 4, 5, 6, 1, 2])
  })

  it('are hidden when fewer than four games qualify', async () => {
    const index = await publishTestIndex([THE_GAME, ...TEN_ACTION.slice(0, 3)])
    expect(await similarOf({ index })).toEqual([])
  })

  it('ask the index once, for the genres of the game, by popularity', async () => {
    const index = countCalls(await publishTestIndex([THE_GAME, ...TEN_ACTION]))
    await similarOf({ index })
    expect(index.calls.search).toHaveLength(1)
    expect(index.calls.search[0]).toMatchObject({
      genres: ['action', 'role-playing-games-rpg'],
      sort: 'POPULARITY_DESC',
      page: 1,
    })
  })

  it('cost the index nothing when the page does not ask for them', async () => {
    const index = countCalls(await publishTestIndex([THE_GAME, ...TEN_ACTION]))
    const { errors } = await runQuery({ index }, WITHOUT_SIMILAR, WITCHER)
    expect(errors).toBeUndefined()
    expect(index.calls.search).toEqual([])
  })

  it('come from the page cache on the next view of the same game', async () => {
    const cache = createTestCache()
    const index = countCalls(await publishTestIndex([THE_GAME, ...TEN_ACTION]))
    const first = await similarOf({ index, cache })
    const second = await similarOf({ index, cache })
    expect(second).toEqual(first)
    expect(index.calls.search).toHaveLength(1)
  })

  it('are hidden when the index has not been published', async () => {
    const index = countCalls(
      overriding(await publishTestIndex([THE_GAME, ...TEN_ACTION]), { meta: async () => null }),
    )
    expect(await similarOf({ index })).toEqual([])
    expect(index.calls.search).toEqual([])
  })

  it('are still shown when the index prices are stale, only without their prices', async () => {
    // They read no price — genres and popularity only — so stale prices are withheld from the
    // cards, as everywhere else, and the row stays.
    const stale = { ...TEST_INDEX_META, pricesUpdatedAt: '2026-09-01T06:00:00.000Z' }
    const index = await publishTestIndex([THE_GAME, ...TEN_ACTION], stale)
    const similar = await similarOf({ index })
    expect(similar.map((game) => Number(game.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(similar.every((game) => game.price === null)).toBe(true)
  })

  it('are hidden, and the page still renders, when the search fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await publishTestIndex([THE_GAME, ...TEN_ACTION])
    const failing = degradeOnFailure(
      overriding(store, { search: () => Promise.reject(new Error('ECONNRESET')) }),
    )
    expect(await similarOf({ index: failing })).toEqual([])
  })
})

describe('similar games from the stored list', () => {
  const STORED = [5, 3, 9, 1, 7]
  const WITH_LIST = { ...THE_GAME, similar: STORED }

  it('are the stored ids in their order, read with one getMany and no search', async () => {
    const index = countCalls(await publishTestIndex([WITH_LIST, ...TEN_ACTION]))
    const similar = await similarOf({ index })

    expect(similar.map((game) => Number(game.id))).toEqual(STORED)
    expect(similar.every((game) => game.price?.bestUah === 400)).toBe(true)
    expect(index.calls.search).toEqual([])
    expect(index.calls.getMany).toEqual([STORED])
    // The game page's own read of the document is the only one.
    expect(index.calls.getOne).toEqual([3328])
  })

  it('skip ids the version no longer holds', async () => {
    const index = await publishTestIndex([
      { ...THE_GAME, similar: [5, 404, 3, 405, 9, 1] },
      ...TEN_ACTION,
    ])
    expect((await similarOf({ index })).map((game) => Number(game.id))).toEqual([5, 3, 9, 1])
  })

  it('are hidden when fewer than four of them are left, without asking by genre', async () => {
    const index = countCalls(
      await publishTestIndex([{ ...THE_GAME, similar: [5, 404, 405, 3, 9] }, ...TEN_ACTION]),
    )
    expect(await similarOf({ index })).toEqual([])
    expect(index.calls.search).toEqual([])
  })

  it('take the row whatever genres the page has, since the list already weighed them', async () => {
    const index = await publishTestIndex([
      { ...THE_GAME, similar: STORED },
      ...TEN_ACTION.map((game) => ({ ...game, genres: ['puzzle'] })),
    ])
    expect((await similarOf({ index })).map((game) => Number(game.id))).toEqual(STORED)
  })

  it('fall back to the genres when the game is not in the index at all', async () => {
    const index = countCalls(await publishTestIndex(TEN_ACTION))
    // The page asks Steam for the price of a game the index does not hold; Steam has none.
    const similar = await similarOf({ index, steamPrices: steamPricesReturning(() => null) })
    expect(similar.map((game) => Number(game.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(index.calls.search).toHaveLength(1)
    expect(index.calls.getMany).toEqual([])
  })

  it('keep the row, without prices, when the prices are stale', async () => {
    const stale = { ...TEST_INDEX_META, pricesUpdatedAt: '2026-09-01T06:00:00.000Z' }
    const index = await publishTestIndex([WITH_LIST, ...TEN_ACTION], stale)
    const similar = await similarOf({ index })
    expect(similar.map((game) => Number(game.id))).toEqual(STORED)
    expect(similar.every((game) => game.price === null)).toBe(true)
  })

  it('are hidden, and the page still renders, when the documents cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await publishTestIndex([WITH_LIST, ...TEN_ACTION])
    const failing = degradeOnFailure(
      overriding(store, { getMany: () => Promise.reject(new Error('ECONNRESET')) }),
    )
    expect(await similarOf({ index: failing })).toEqual([])
  })

  it('are hidden, without a search, when the game page could not read its document', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = countCalls(await publishTestIndex([WITH_LIST, ...TEN_ACTION]))
    const failing = degradeOnFailure(
      overriding(store, { getOne: () => Promise.reject(new Error('ECONNRESET')) }),
    )
    expect(await similarOf({ index: failing })).toEqual([])
    expect(store.calls.search).toEqual([])
    expect(store.calls.getMany).toEqual([])
  })
})
