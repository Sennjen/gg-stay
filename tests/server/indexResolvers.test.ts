import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../server/index/GameIndex'
import { degradeOnFailure, unavailableGameIndex, withDeadline } from '../../server/index/index'
import type { ResolverCache } from '../../server/graphql/context'
import type { RawgFetch } from '../../server/rawg/rawgFetch'
import { createSteamPriceFetch } from '../../server/steam/steamPriceFetch'
import steamPrices from '../fixtures/steam/prices.json' with { type: 'json' }
import { FIXTURE_GAMES } from '../fixtures/index/games'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import {
  countCalls,
  createTestCache,
  fixtureRawg,
  overriding,
  publishTestIndex,
  runQuery,
  steamPricesReturning,
  TEST_INDEX_META,
  TEST_NOW,
  type CountingIndex,
} from './support/yoga'

/**
 * Which path answers a request, what it says about the index, and what it does when the index is
 * stale, unavailable or simply does not know a game. Every case goes through a real GraphQL
 * operation against yoga, so the answer is the one a page actually receives.
 *
 * The index holds the three games the RAWG fixtures show (`devGames.ts`) plus the synthetic
 * contract set (`games.ts`), which is what makes an index-served page interesting: it has games
 * RAWG's four-item fixture does not.
 */

const ALL_DOCUMENTS = [...DEV_FIXTURE_GAMES, ...FIXTURE_GAMES]

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
      ignoredFilters
      items {
        id
        slug
        name
        released
        metacritic
        platformFamilies
        cover {
          url
        }
        price {
          bestUah
          regularUah
          bestStore
          discountPercent
          isFree
          updatedAt
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

const GAME = /* GraphQL */ `
  query Game($slug: String!) {
    game(slug: $slug) {
      id
      slug
      madeInUkraine
      localisation {
        text
        audio
        source
      }
      stores {
        store
        url
        priceUah
        regularPriceUah
        discountPercent
        isFree
        updatedAt
      }
    }
  }
`

const LANDING = /* GraphQL */ `
  query Landing {
    landing {
      newReleases {
        slug
        price {
          bestUah
        }
        localisation {
          text
        }
      }
      topRated {
        slug
        price {
          bestUah
        }
      }
    }
  }
`

function countingRawg(inner: RawgFetch = fixtureRawg): RawgFetch & { paths: string[] } {
  const paths: string[] = []
  const fetch = ((path, params, options) => {
    paths.push(path)
    return inner(path, params, options)
  }) as RawgFetch & { paths: string[] }
  fetch.paths = paths
  return fetch
}

let index: CountingIndex

beforeEach(async () => {
  index = countCalls(await publishTestIndex(ALL_DOCUMENTS))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('which path serves a catalog request', () => {
  const indexCases: [name: string, variables: Record<string, unknown>][] = [
    ['a price ceiling', { filter: { priceMaxUah: 600 } }],
    ['the free filter', { filter: { free: true } }],
    ['a discount floor', { filter: { onSaleMinPercent: 50 } }],
    ['any Ukrainian localisation', { filter: { ukrainianLocalisation: 'ANY' } }],
    ['Ukrainian text', { filter: { ukrainianLocalisation: 'TEXT' } }],
    ['Ukrainian audio', { filter: { ukrainianLocalisation: 'AUDIO' } }],
    ['made in Ukraine', { filter: { madeInUkraine: true } }],
    ['the cheapest first', { sort: 'PRICE_ASC' }],
    ['the most expensive first', { sort: 'PRICE_DESC' }],
    ['the biggest discount first', { sort: 'DISCOUNT_DESC' }],
  ]

  it.each(indexCases)('%s is answered by the index alone', async (_name, variables) => {
    const rawg = countingRawg()
    const { data, errors } = await runQuery({ rawg, index }, GAMES, variables)
    expect(errors).toBeUndefined()
    expect(data!.games.indexedOnly).toBe(true)
    expect(index.calls.search).toHaveLength(1)
    expect(rawg.paths).toEqual([])
  })

  const rawgCases: [name: string, variables: Record<string, unknown>][] = [
    ['no filter at all', {}],
    ['an unchecked free box', { filter: { free: false } }],
    ['an unchecked made-in-Ukraine box', { filter: { madeInUkraine: false } }],
    ['a genre', { filter: { genres: ['action'] } }],
    ['a search term', { filter: { search: 'witcher' } }],
    ['a sort the index shares with RAWG', { sort: 'RATING_DESC' }],
  ]

  it.each(rawgCases)('%s is answered by RAWG', async (_name, variables) => {
    const rawg = countingRawg()
    const { data, errors } = await runQuery({ rawg, index }, GAMES, variables)
    expect(errors).toBeUndefined()
    expect(data!.games.indexedOnly).toBe(false)
    expect(index.calls.search).toHaveLength(0)
    expect(rawg.paths).toEqual(['games'])
  })

  it('reads the index metadata once per request, however many pages it answers', async () => {
    const query = /* GraphQL */ `
      query TwoPages {
        first: games(filter: { free: true }) {
          total
        }
        second: games(filter: { onSaleMinPercent: 50 }) {
          total
        }
      }
    `
    const { errors } = await runQuery({ index }, query)
    expect(errors).toBeUndefined()
    expect(index.calls.meta).toBe(1)
  })
})

describe('a page the index answers', () => {
  it('reports an exact total and pages through it', async () => {
    const first = await runQuery({ index }, GAMES, {
      filter: { free: true },
      page: 1,
      pageSize: 2,
    })
    expect(first.data!.games).toMatchObject({ total: 3, page: 1, pageSize: 2, hasNext: true })
    expect(first.data!.games.items.map((item: { id: string }) => item.id)).toEqual(['654', '28'])

    const second = await runQuery({ index }, GAMES, {
      filter: { free: true },
      page: 2,
      pageSize: 2,
    })
    expect(second.data!.games).toMatchObject({ total: 3, page: 2, hasNext: false })
    expect(second.data!.games.items.map((item: { id: string }) => item.id)).toEqual(['36'])
  })

  it('orders by the index sort and carries the price onto every card', async () => {
    const { data } = await runQuery({ index }, GAMES, {
      filter: { ukrainianLocalisation: 'AUDIO' },
      sort: 'PRICE_ASC',
    })
    expect(data!.games.items[0]).toMatchObject({
      id: '3328',
      slug: 'the-witcher-3-wild-hunt',
      platformFamilies: ['PC', 'PLAYSTATION', 'NINTENDO'],
      price: {
        bestUah: 675,
        regularUah: 1349,
        bestStore: 'steam',
        discountPercent: 50,
        isFree: false,
        updatedAt: '2026-09-20T03:00:00.000Z',
      },
      localisation: { text: true, audio: true, source: 'steam' },
    })
  })

  it('reports the index as the source and how fresh it is', async () => {
    const { data } = await runQuery({ index }, GAMES, { filter: { free: true } })
    expect(data!.games).toMatchObject({
      indexedOnly: true,
      indexStale: false,
      indexUpdatedAt: '2026-09-18T06:00:00.000Z',
      ignoredFilters: [],
    })
  })

  it('names the filters the index cannot express instead of pretending it applied them', async () => {
    const { data } = await runQuery({ index }, GAMES, {
      filter: {
        priceMaxUah: 600,
        developers: ['cd-projekt-red'],
        publishers: ['valve'],
        tags: ['singleplayer'],
      },
    })
    expect(data!.games.indexedOnly).toBe(true)
    expect(data!.games.ignoredFilters).toEqual(['developers', 'publishers', 'tags'])
  })

  it('applies every filter the index does express, alongside the price one', async () => {
    const { data } = await runQuery({ index }, GAMES, {
      filter: { priceMaxUah: 400, genres: ['action'] },
    })
    // Of the games at or under 400 ₴, every synthetic one carries the `action` genre; the free
    // Stardew Valley document (654, indie and simulation) does not, so the genre drops it.
    expect(data!.games.items.map((item: { id: string }) => item.id)).toEqual([
      '24',
      '25',
      '26',
      '28',
      '29',
      '32',
      '36',
    ])
    expect(data!.games.total).toBe(7)
  })
})

describe('a page RAWG answers', () => {
  it('attaches prices, localisation and the flag with exactly one index read', async () => {
    const { data, errors } = await runQuery({ index }, GAMES, {})
    expect(errors).toBeUndefined()
    expect(index.calls.getMany).toEqual([[3328, 4200, 654, 999001]])
    const items = data!.games.items as { id: string; price: unknown; localisation: unknown }[]
    expect(items.find((item) => item.id === '3328')).toMatchObject({
      price: { bestUah: 675, discountPercent: 50 },
      localisation: { text: true, audio: true },
    })
    expect(items.find((item) => item.id === '654')).toMatchObject({
      price: { bestUah: 0, isFree: true },
      localisation: null,
    })
  })

  it('leaves a game the index does not know without a price line', async () => {
    const { data } = await runQuery({ index }, GAMES, {})
    const items = data!.games.items as { id: string; price: unknown; madeInUkraine: boolean }[]
    expect(items.find((item) => item.id === '999001')).toMatchObject({
      price: null,
      localisation: null,
      madeInUkraine: false,
    })
  })

  it('reads nothing from the index for an empty page, but still reports its freshness', async () => {
    const { data } = await runQuery({ index }, GAMES, { page: 501 })
    expect(data!.games.items).toEqual([])
    expect(index.calls.getMany).toEqual([])
    // A banner must not flicker off because a visitor paged past the end.
    expect(data!.games).toMatchObject({
      indexStale: false,
      indexUpdatedAt: '2026-09-18T06:00:00.000Z',
      ignoredFilters: [],
    })
  })
})

describe('a sort the index never owned', () => {
  const stalePrices = {
    updatedAt: '2026-09-18T06:30:00.000Z',
    pricesUpdatedAt: '2026-09-10T09:00:00.000Z',
  }

  it('survives a stale index, because nothing about it depends on a price', async () => {
    const stale = countCalls(await publishTestIndex(ALL_DOCUMENTS, stalePrices))
    const { data } = await runQuery({ index: stale }, GAMES, {
      filter: { ukrainianLocalisation: 'TEXT' },
      sort: 'NAME_ASC',
    })
    expect(data!.games.indexedOnly).toBe(true)
    expect(data!.games.ignoredFilters).toEqual([])
    expect(stale.calls.search[0]).toMatchObject({ sort: 'NAME_ASC' })
  })

  it('survives an index that cannot answer, while the price filter is named', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = unavailableGameIndex('the store did not answer')
    const { data } = await runQuery({ index: down }, GAMES, {
      filter: { priceMaxUah: 600 },
      sort: 'RATING_DESC',
    })
    expect(data!.games.ignoredFilters).toEqual(['priceMaxUah'])
    // The sort was the visitor's and the RAWG path can order by it, so it is not in the list.
    expect(data!.games.ignoredFilters).not.toContain('sort')
  })

  it('is named only when it is one the index alone could have applied', async () => {
    const stale = await publishTestIndex(ALL_DOCUMENTS, stalePrices)
    const { data } = await runQuery({ index: stale }, GAMES, { sort: 'DISCOUNT_DESC' })
    expect(data!.games.ignoredFilters).toEqual(['sort'])
  })
})

describe('an index whose prices have gone stale', () => {
  // Eight days since the last price stage: past the seven-day limit the design sets. The run
  // itself published this morning — staleness is about the prices, not about the run.
  const stalePrices = {
    updatedAt: '2026-09-18T06:30:00.000Z',
    pricesUpdatedAt: '2026-09-10T09:00:00.000Z',
  }
  const staleIndex = async () => countCalls(await publishTestIndex(ALL_DOCUMENTS, stalePrices))

  it('says so and withholds every price, on a page nothing was filtered on', async () => {
    const stale = await staleIndex()
    const { data } = await runQuery({ index: stale }, GAMES, {})
    expect(data!.games).toMatchObject({
      indexStale: true,
      indexedOnly: false,
      indexUpdatedAt: '2026-09-10T09:00:00.000Z',
      ignoredFilters: [],
    })
    const items = data!.games.items as { id: string; price: unknown; localisation: unknown }[]
    expect(items.find((item) => item.id === '3328')).toMatchObject({
      price: null,
      // A stale price is worse than none; a language list does not go stale with the prices.
      localisation: { text: true, audio: true },
    })
  })

  it('counts an index that has never priced anything as stale', async () => {
    const unpriced = await publishTestIndex(ALL_DOCUMENTS, {
      updatedAt: '2026-09-18T06:30:00.000Z',
      pricesUpdatedAt: null,
    })
    const { data } = await runQuery({ index: unpriced }, GAMES, {})
    expect(data!.games).toMatchObject({ indexStale: true, indexUpdatedAt: null })
  })

  it('ignores the price filters and the price sort, and names them', async () => {
    const stale = await staleIndex()
    const rawg = countingRawg()
    const { data } = await runQuery({ index: stale, rawg }, GAMES, {
      filter: { priceMaxUah: 600, free: true },
      sort: 'PRICE_ASC',
    })
    expect(rawg.paths).toEqual(['games'])
    expect(stale.calls.search).toHaveLength(0)
    expect(data!.games).toMatchObject({ indexedOnly: false, indexStale: true })
    expect(data!.games.ignoredFilters).toEqual(['priceMaxUah', 'free', 'sort'])
    expect(data!.games.items).toHaveLength(4)
  })

  it('still answers a localisation filter from the index, without prices', async () => {
    const stale = await staleIndex()
    const rawg = countingRawg()
    const { data } = await runQuery({ index: stale, rawg }, GAMES, {
      filter: { ukrainianLocalisation: 'AUDIO' },
    })
    expect(rawg.paths).toEqual([])
    expect(data!.games).toMatchObject({
      indexedOnly: true,
      indexStale: true,
      ignoredFilters: [],
    })
    const items = data!.games.items as { id: string; price: unknown; localisation: unknown }[]
    expect(items.map((item) => item.id)).toEqual(['3328', '34', '35', '38'])
    expect(items.every((item) => item.price === null)).toBe(true)
    expect(items[0]!.localisation).toEqual({ text: true, audio: true, source: 'steam' })
  })

  it('drops the price half of a mixed filter and keeps answering the rest from the index', async () => {
    const stale = await staleIndex()
    const { data } = await runQuery({ index: stale }, GAMES, {
      filter: { ukrainianLocalisation: 'AUDIO', priceMaxUah: 100 },
      sort: 'PRICE_ASC',
    })
    expect(data!.games.indexedOnly).toBe(true)
    expect(data!.games.ignoredFilters).toEqual(['priceMaxUah', 'sort'])
    // The price ceiling would have left nothing; dropped, the localisation filter still answers.
    expect(data!.games.total).toBe(4)
    expect(stale.calls.search[0]).toMatchObject({ priceMaxUah: undefined, sort: 'POPULARITY_DESC' })
  })

  it('still answers made in Ukraine from the index', async () => {
    const stale = await staleIndex()
    const { data } = await runQuery({ index: stale }, GAMES, { filter: { madeInUkraine: true } })
    expect(data!.games.indexedOnly).toBe(true)
    expect(data!.games.items.map((item: { id: string }) => item.id)).toEqual(['39', '38'])
  })
})

describe('an index that cannot answer', () => {
  it('serves the RAWG page without prices and says which filters were dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = countCalls(unavailableGameIndex('the store did not answer'))
    const { data, errors } = await runQuery({ index: down }, GAMES, {
      filter: { free: true },
      sort: 'DISCOUNT_DESC',
    })
    expect(errors).toBeUndefined()
    expect(data!.games).toMatchObject({ indexedOnly: false, indexStale: false })
    expect(data!.games.ignoredFilters).toEqual(['free', 'sort'])
    expect(data!.games.items).toHaveLength(4)
    expect(data!.games.items.every((item: { price: unknown }) => item.price === null)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps reporting the freshness it knew before the search failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = overriding(await publishTestIndex(ALL_DOCUMENTS), {
      search: () => Promise.reject(new Error('ECONNRESET')),
    })
    const { data } = await runQuery({ index: broken }, GAMES, { filter: { free: true } })
    expect(data!.games).toMatchObject({
      indexedOnly: false,
      indexStale: false,
      indexUpdatedAt: '2026-09-18T06:00:00.000Z',
    })
    expect(data!.games.ignoredFilters).toEqual(['free'])
  })

  it('serves the RAWG page when the attachment itself fails, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = overriding(await publishTestIndex(ALL_DOCUMENTS), {
      getMany: () => Promise.reject(new Error('ECONNRESET')),
    })
    const { data, errors } = await runQuery({ index: broken }, GAMES, {})
    expect(errors).toBeUndefined()
    expect(data!.games.items).toHaveLength(4)
    expect(data!.games.items.every((item: { price: unknown }) => item.price === null)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports nothing as stale when there is no index metadata to judge', async () => {
    const down = unavailableGameIndex('nothing is configured')
    const { data } = await runQuery({ index: down }, GAMES, {})
    expect(data!.games).toMatchObject({ indexStale: false, indexUpdatedAt: null })
  })
})

describe('an index that never answers', () => {
  /** Fires every deadline at once, so no test waits for a real timer. */
  const immediate = { setTimeout: (handler: () => void) => (handler(), 0), clearTimeout: () => {} }

  /** The adapter the site would build around a store that accepts a call and goes quiet. */
  function hungIndex(): CountingIndex {
    const hung: GameIndex = {
      search: () => new Promise(() => {}),
      getMany: () => new Promise(() => {}),
      getOne: () => new Promise(() => {}),
      meta: () => new Promise(() => {}),
    }
    return countCalls(degradeOnFailure(withDeadline(hung, { setTimer: immediate }), () => {}))
  }

  it('renders the catalog on RAWG instead of hanging, and gives up after one call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = hungIndex()
    const rawg = countingRawg()
    const { data, errors } = await runQuery({ index: hung, rawg }, GAMES, {})
    expect(errors).toBeUndefined()
    expect(rawg.paths).toEqual(['games'])
    expect(data!.games.items).toHaveLength(4)
    expect(data!.games.items.every((item: { price: unknown }) => item.price === null)).toBe(true)
    expect(data!.games).toMatchObject({ indexStale: false, indexUpdatedAt: null })
    // One timeout for the whole request: `meta()` failed, so the attachment was never attempted.
    expect(hung.calls.meta).toBe(1)
    expect(hung.calls.getMany).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('renders a filtered catalog page on RAWG instead of hanging', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = hungIndex()
    const { data, errors } = await runQuery({ index: hung }, GAMES, {
      filter: { free: true },
      sort: 'DISCOUNT_DESC',
    })
    expect(errors).toBeUndefined()
    expect(data!.games.indexedOnly).toBe(false)
    expect(data!.games.ignoredFilters).toEqual(['free', 'sort'])
    expect(hung.calls.search).toEqual([])
  })

  it('renders the game page instead of hanging', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = hungIndex()
    const { data, errors } = await runQuery({ index: hung }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(errors).toBeUndefined()
    expect(data!.game.localisation).toBeNull()
    const offers = data!.game.stores as { store: string; priceUah: number | null }[]
    expect(offers.find((offer) => offer.store === 'steam')?.priceUah).toBeNull()
    expect(hung.calls.getOne).toEqual([3328])
  })

  it('renders the landing instead of hanging', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = hungIndex()
    const { data, errors } = await runQuery({ index: hung }, LANDING)
    expect(errors).toBeUndefined()
    const rows = data!.landing.newReleases as { price: unknown }[]
    expect(rows.every((row) => row.price === null)).toBe(true)
    expect(hung.calls.getMany).toEqual([])
  })

  it('stops asking after the first failure, whatever the operation asks for next', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hung = hungIndex()
    const query = /* GraphQL */ `
      query TwoPages {
        first: games(filter: { free: true }) {
          total
        }
        second: games {
          total
        }
      }
    `
    const { errors } = await runQuery({ index: hung }, query)
    expect(errors).toBeUndefined()
    expect(hung.calls.meta).toBe(1)
    expect(hung.calls.search).toEqual([])
    expect(hung.calls.getMany).toEqual([])
  })

  it('renders the game page when the entry read throws rather than hangs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = overriding(await publishTestIndex(ALL_DOCUMENTS), {
      getOne: () => Promise.reject(new Error('ECONNRESET')),
    })
    const { data, errors } = await runQuery({ index: throwing }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(errors).toBeUndefined()
    expect(data!.game.localisation).toBeNull()
    expect(data!.game.madeInUkraine).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('renders the landing when the attachment throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = overriding(await publishTestIndex(ALL_DOCUMENTS), {
      getMany: () => Promise.reject(new Error('ECONNRESET')),
    })
    const { data, errors } = await runQuery({ index: throwing }, LANDING)
    expect(errors).toBeUndefined()
    const rows = data!.landing.newReleases as { price: unknown }[]
    expect(rows.every((row) => row.price === null)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('a slow but healthy index', () => {
  /**
   * A clock that only moves when something waits on it, and an index and a RAWG double that each
   * declare how long they take. Nothing here sleeps: `at()` records the moment a call finished,
   * and the promises resolve in the order the event loop drains them, so the assertions are about
   * which calls overlapped rather than about real milliseconds.
   */
  function stopwatch() {
    let now = 0
    const finished: Record<string, number> = {}
    // A call that "takes" `ms` finishes at the later of (the clock when it started + ms) and the
    // clock as it stands, and drags the clock with it — the shape of a wall clock under work that
    // may or may not overlap.
    const take = async <T>(name: string, ms: number, value: T): Promise<T> => {
      const startedAt = now
      await Promise.resolve()
      const endsAt = startedAt + ms
      now = Math.max(now, endsAt)
      finished[name] = endsAt
      return value
    }
    return { take, finished, elapsed: () => now }
  }

  it('runs the index beside RAWG instead of in front of it', async () => {
    const clock = stopwatch()
    const documents = await publishTestIndex(ALL_DOCUMENTS)
    const slow = overriding(documents, {
      meta: () => clock.take('meta', 1400, documents.meta()),
      getMany: (ids) => clock.take('getMany', 1400, documents.getMany(ids)),
    })
    const rawg: RawgFetch = (path, params, options) =>
      clock.take('rawg', 1000, fixtureRawg(path, params, options))

    const { data, errors } = await runQuery({ index: slow, rawg }, GAMES, {})
    expect(errors).toBeUndefined()

    // `meta()` and the RAWG fetch start together, so the page costs the greater of the two and
    // then the one document read — not all three in a row.
    expect(clock.finished.meta).toBe(1400)
    expect(clock.finished.rawg).toBe(1000)
    expect(clock.elapsed()).toBe(2800)
    // Serialised, this page would have been 1400 + 1000 + 1400.
    expect(clock.elapsed()).toBeLessThan(3800)
    // And it is still a page with prices on it.
    const items = data!.games.items as { id: string; price: unknown }[]
    expect(items.find((item) => item.id === '3328')?.price).toMatchObject({ bestUah: 675 })
  })

  it('runs the index beside the landing rows too', async () => {
    const clock = stopwatch()
    const documents = await publishTestIndex(ALL_DOCUMENTS)
    const slow = overriding(documents, {
      meta: () => clock.take('meta', 1400, documents.meta()),
      getMany: (ids) => clock.take('getMany', 1400, documents.getMany(ids)),
    })
    const rawg: RawgFetch = (path, params, options) =>
      clock.take(
        path.includes('games/') ? 'detail' : 'rawg',
        1000,
        fixtureRawg(path, params, options),
      )

    const { errors } = await runQuery({ index: slow, rawg }, LANDING)
    expect(errors).toBeUndefined()
    expect(clock.finished.meta).toBe(1400)
    expect(clock.finished.rawg).toBe(1000)
  })
})

describe('caching an index-served page', () => {
  it('serves the second identical request from the cache, keyed by the index version', async () => {
    const cache = createTestCache()
    const variables = { filter: { free: true }, page: 1, pageSize: 2 }
    const first = await runQuery({ index, cache }, GAMES, variables)
    const second = await runQuery({ index, cache }, GAMES, variables)

    expect(second.data!.games.items).toEqual(first.data!.games.items)
    expect(second.data!.games.total).toBe(first.data!.games.total)
    expect(index.calls.search).toHaveLength(1)
    expect(cache.writes).toHaveLength(1)
    expect(cache.writes[0]![1]).toBe(600)
    expect(cache.writes[0]![0]).toContain('"version":1')
  })

  it('misses when the index publishes a new version, without anything clearing it', async () => {
    const cache = createTestCache()
    const store = await publishTestIndex(ALL_DOCUMENTS)
    const first = countCalls(store)
    await runQuery({ index: first, cache }, GAMES, { filter: { free: true } })
    expect(first.calls.search).toHaveLength(1)

    // The same store, one publication later: the version is part of every key, so nothing has to
    // sweep the cache.
    const second = countCalls(await publishTestIndex(ALL_DOCUMENTS, TEST_INDEX_META, store))
    await runQuery({ index: second, cache }, GAMES, { filter: { free: true } })
    expect(second.calls.search).toHaveLength(1)
    expect(cache.writes).toHaveLength(2)
    expect(cache.writes[0]![0]).toContain('"version":1')
    expect(cache.writes[1]![0]).toContain('"version":2')
  })

  it('does not cache a page RAWG answered', async () => {
    const cache = createTestCache()
    await runQuery({ index, cache }, GAMES, {})
    expect(cache.writes).toEqual([])
  })
})

describe('the game page', () => {
  it('carries the index price onto the Steam offer, with the localisation and the flag', async () => {
    const { data, errors } = await runQuery({ index }, GAME, { slug: 'the-witcher-3-wild-hunt' })
    expect(errors).toBeUndefined()
    expect(data!.game.localisation).toEqual({ text: true, audio: true, source: 'steam' })
    expect(data!.game.madeInUkraine).toBe(false)
    const offers = data!.game.stores as { store: string; priceUah: number | null }[]
    expect(offers.find((offer) => offer.store === 'steam')).toEqual({
      store: 'steam',
      url: 'https://store.steampowered.com/app/292030/',
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      isFree: false,
      updatedAt: '2026-09-20T03:00:00.000Z',
    })
    // Other stores stay plain links until week 4.
    expect(offers.find((offer) => offer.store === 'gog')).toMatchObject({ priceUah: null })
  })

  it('keeps a price younger than six hours instead of asking Steam again', async () => {
    const steamPrices = steamPricesReturning(() => {
      throw new Error('should not be called')
    })
    const fresh = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T08:00:00.000Z' },
    ])
    const { data } = await runQuery({ index: fresh, steamPrices }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(steamPrices.calls).toEqual([])
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')?.priceUah).toBe(675)
  })

  it('refreshes a price older than six hours from Steam and serves the fresh one', async () => {
    const steamPrices = steamPricesReturning(async () => ({
      priceUah: 404,
      regularPriceUah: 1349,
      discountPercent: 70,
      isFree: false,
    }))
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const cache = createTestCache()
    const { data } = await runQuery({ index: stale, steamPrices, cache }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(steamPrices.calls).toEqual(['292030'])
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')).toMatchObject({
      priceUah: 404,
      regularPriceUah: 1349,
      discountPercent: 70,
      updatedAt: TEST_NOW,
    })
    expect(cache.writes[0]![1]).toBe(21_600)
  })

  it('keeps the index copy and warns when Steam refuses the live read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const steamPrices = steamPricesReturning(async () => {
      throw new Error('502 Bad Gateway')
    })
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const { data, errors } = await runQuery({ index: stale, steamPrices }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(errors).toBeUndefined()
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')).toMatchObject({
      priceUah: 675,
      updatedAt: '2026-09-18T01:00:00.000Z',
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('asks Steam for a game with a store page the index has never seen', async () => {
    const steamPrices = steamPricesReturning(async () => ({
      priceUah: 999,
      regularPriceUah: 999,
      discountPercent: 0,
      isFree: false,
    }))
    const empty = await publishTestIndex(FIXTURE_GAMES)
    const { data } = await runQuery({ index: empty, steamPrices }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(steamPrices.calls).toEqual(['292030'])
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')).toMatchObject({ priceUah: 999 })
    // Nothing else came from the index, because the index knows nothing about this game.
    expect(data!.game.localisation).toBeNull()
    expect(data!.game.madeInUkraine).toBe(false)
  })

  it('reuses a cached live price instead of calling Steam again', async () => {
    const steamPrices = steamPricesReturning(async () => ({
      priceUah: 404,
      regularPriceUah: 1349,
      discountPercent: 70,
      isFree: false,
    }))
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const cache = createTestCache()
    await runQuery({ index: stale, steamPrices, cache }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    const { data } = await runQuery({ index: stale, steamPrices, cache }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(steamPrices.calls).toEqual(['292030'])
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')?.priceUah).toBe(404)
  })
})

describe('the live price is honest about its age', () => {
  const steamFixtureDeps = (fetched: string[]) => ({
    fixtures: false,
    fetchJson: async (url: string) => {
      fetched.push(url)
      return { status: 200, body: steamPrices as unknown }
    },
    readFixture: async () => null,
    now: () => Date.parse(TEST_NOW),
    sleep: async () => {},
    steamFetch: () => {
      throw new Error('the game page must not read the 24h-cached per-app transport')
    },
  })

  it('reads the price through the uncached transport, not the day-long per-app cache', async () => {
    const fetched: string[] = []
    const transport = createSteamPriceFetch(steamFixtureDeps(fetched))
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const { data, errors } = await runQuery({ index: stale, steamPrices: transport }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(errors).toBeUndefined()
    // One request, with the price filter and the Ukrainian storefront, and nothing cached.
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toContain('appids=292030')
    expect(fetched[0]).toContain('filters=price_overview')
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    expect(offers.find((offer) => offer.store === 'steam')?.priceUah).toBe(675)
  })

  it('keeps the moment of the read when the cached entry is served later', async () => {
    const cache = createTestCache()
    const steam = steamPricesReturning(async () => ({
      priceUah: 404,
      regularPriceUah: 1349,
      discountPercent: 70,
      isFree: false,
    }))
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    await runQuery({ index: stale, steamPrices: steam, cache }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })

    // Five hours later the resolver cache is still warm; the answer must still claim the age it
    // really has, not the age of the request that read it.
    const later = '2026-09-18T14:00:00.000Z'
    const { data } = await runQuery({ index: stale, steamPrices: steam, cache, now: later }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    expect(steam.calls).toEqual(['292030'])
    const offers = data!.game.stores as { store: string; updatedAt: string }[]
    expect(offers.find((offer) => offer.store === 'steam')?.updatedAt).toBe(TEST_NOW)
  })

  it('renders the page rather than failing when the cache itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken: ResolverCache = {
      get: () => Promise.reject(new Error('the storage driver is broken')),
      set: () => Promise.reject(new Error('the storage driver is broken')),
    }
    const steam = steamPricesReturning(async () => null)
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const { data, errors } = await runQuery(
      { index: stale, steamPrices: steam, cache: broken },
      GAME,
      { slug: 'the-witcher-3-wild-hunt' },
    )
    expect(errors).toBeUndefined()
    const offers = data!.game.stores as { store: string; priceUah: number }[]
    // The index copy, kept because the refresh could not complete.
    expect(offers.find((offer) => offer.store === 'steam')?.priceUah).toBe(675)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the index copy when Steam answers without a price', async () => {
    const steam = steamPricesReturning(async () => null)
    const stale = await publishTestIndex([
      { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
    ])
    const { data } = await runQuery({ index: stale, steamPrices: steam }, GAME, {
      slug: 'the-witcher-3-wild-hunt',
    })
    const offers = data!.game.stores as { store: string; priceUah: number; updatedAt: string }[]
    expect(offers.find((offer) => offer.store === 'steam')).toMatchObject({
      priceUah: 675,
      updatedAt: '2026-09-18T01:00:00.000Z',
    })
  })
})

describe('the landing rows', () => {
  it('attach prices to every row with a single index read', async () => {
    const { data, errors } = await runQuery({ index }, LANDING)
    expect(errors).toBeUndefined()
    expect(index.calls.getMany).toHaveLength(1)
    const rows = data!.landing.newReleases as { slug: string; price: { bestUah: number } | null }[]
    expect(rows.find((row) => row.slug === 'the-witcher-3-wild-hunt')?.price).toEqual({
      bestUah: 675,
    })
    expect(rows.find((row) => row.slug === 'unreleased-sample')?.price).toBeNull()
    const top = data!.landing.topRated as { slug: string; price: { bestUah: number } | null }[]
    expect(top.find((row) => row.slug === 'portal-2')?.price).toEqual({ bestUah: 225 })
  })
})
