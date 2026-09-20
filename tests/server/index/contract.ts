import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GameIndex, GameIndexWriter, IndexQuery } from '../../../server/index/GameIndex'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { FIXTURE_GAMES, FIXTURE_TODAY } from '../../fixtures/index/games'

/**
 * The behaviour every `GameIndex` adapter owes its callers. The in-memory adapter and the Upstash
 * adapter run this same suite, so a rule written here is a rule both stores obey — that is the
 * point of keeping the semantics in one file instead of in each adapter's own test.
 */

export interface GameIndexAdapter {
  index: GameIndex
  writer: GameIndexWriter
  /** Called once the suite is done with the adapter; a remote store drops its keys here. */
  teardown?: () => void | Promise<void>
}

export type MakeGameIndexAdapter = () => GameIndexAdapter | Promise<GameIndexAdapter>

export const FIXTURE_META: IndexMeta = {
  version: 0,
  updatedAt: '2026-09-20T06:30:00.000Z',
  pricesUpdatedAt: '2026-09-20T06:00:00.000Z',
  gameCount: FIXTURE_GAMES.length,
  stats: { gamesIndexed: FIXTURE_GAMES.length, failures: 0 },
}

/** Writes one version through the writer port and publishes it. Returns the version number. */
export async function publishGames(
  adapter: GameIndexAdapter,
  games: IndexedGame[],
  meta: Omit<IndexMeta, 'version' | 'gameCount'> = FIXTURE_META,
): Promise<number> {
  const version = await adapter.writer.beginVersion()
  await adapter.writer.putGames(version, games)
  await adapter.writer.publish(version, {
    ...meta,
    version,
    gameCount: games.length,
  })
  return version
}

export function describeGameIndexContract(name: string, makeAdapter: MakeGameIndexAdapter): void {
  describe(`GameIndex contract: ${name}`, () => {
    describe('reading a published version', () => {
      let adapter: GameIndexAdapter

      beforeAll(async () => {
        adapter = await makeAdapter()
        await publishGames(adapter, FIXTURE_GAMES)
      })

      afterAll(async () => {
        await adapter.teardown?.()
      })

      const ids = async (query: IndexQuery): Promise<number[]> =>
        (await adapter.index.search(query)).ids

      const total = async (query: IndexQuery): Promise<number> =>
        (await adapter.index.search(query)).total

      describe('facets', () => {
        it('matches any of the selected values within one facet', async () => {
          expect(await ids({ genres: ['indie'] })).toEqual([2, 3, 5])
          expect(await ids({ genres: ['indie', 'strategy'] })).toEqual([2, 3, 4, 5])
        })

        it('requires every facet to match across facets', async () => {
          expect(await ids({ genres: ['indie'], platforms: [7] })).toEqual([2, 3])
        })

        it('filters by store', async () => {
          expect(await ids({ stores: ['epic-games'] })).toEqual([6])
          expect(await ids({ stores: ['gog', 'epic-games'] })).toEqual([5, 6])
        })

        it('filters by game mode', async () => {
          expect(await ids({ gameModes: ['ONLINE_COOP'] })).toEqual([8])
          expect(await ids({ gameModes: ['LOCAL_COOP', 'MULTIPLAYER'] })).toEqual([7, 9])
        })

        it('filters by age rating', async () => {
          expect(await ids({ ageRating: ['PEGI3', 'PEGI7'] })).toEqual([8, 9])
        })

        it('filters by playtime bucket', async () => {
          expect(await ids({ playtime: 'SHORT' })).toEqual([15])
          expect(await ids({ playtime: 'LONG' })).toEqual([18])
          const medium = await ids({ playtime: 'MEDIUM' })
          expect(medium).toContain(16)
          expect(medium).toContain(17)
          expect(medium).not.toContain(15)
          expect(medium).not.toContain(18)
          expect(medium).not.toContain(19)
        })

        it('filters by made in Ukraine', async () => {
          expect(await ids({ madeInUkraine: true })).toEqual([39, 38])
        })

        it('returns an empty page for a facet value nothing carries', async () => {
          const result = await adapter.index.search({ genres: ['nonexistent'] })
          expect(result).toEqual({ ids: [], total: 0, games: [] })
        })
      })

      describe('ranges', () => {
        it('includes both bounds of the release year range', async () => {
          expect(await ids({ yearFrom: 2015, yearTo: 2018 })).toEqual([10, 11])
          expect(await ids({ yearTo: 2015 })).toEqual([10])
          expect(await ids({ yearFrom: 2021 })).toEqual([12, 13])
        })

        it('lists only games released after today when upcoming is set', async () => {
          expect(await ids({ upcoming: true, today: FIXTURE_TODAY })).toEqual([13])
        })

        it('includes the bound of the Metacritic minimum', async () => {
          expect(await ids({ metacriticMin: 80 })).toEqual([20, 21])
        })

        it('includes the bound of the rating minimum', async () => {
          const matching = await ids({ ratingMin: 4, pageSize: 40 })
          expect(matching).toHaveLength(38)
          expect(matching).not.toContain(22)
          expect(matching).not.toContain(23)
        })
      })

      describe('localisation', () => {
        it('matches text or audio for ANY', async () => {
          expect(await ids({ ukrainianLocalisation: 'ANY' })).toEqual([33, 34, 35, 38])
        })

        it('matches the text set for TEXT', async () => {
          expect(await ids({ ukrainianLocalisation: 'TEXT' })).toEqual([33, 34, 38])
        })

        it('matches the audio set alone for AUDIO', async () => {
          expect(await ids({ ukrainianLocalisation: 'AUDIO' })).toEqual([34, 35, 38])
        })
      })

      describe('price and discount', () => {
        it('matches free games for free', async () => {
          expect(await ids({ free: true })).toEqual([28, 36])
        })

        it('includes free games in a price ceiling and includes the bound', async () => {
          expect(await ids({ priceMaxUah: 300 })).toEqual([24, 25, 28, 29, 32, 36])
        })

        it('includes the bound of the discount minimum', async () => {
          expect(await ids({ onSaleMinPercent: 50 })).toEqual([25, 26, 27, 29, 32])
        })

        it('combines a price ceiling, a discount floor and the discount sort', async () => {
          expect(
            await ids({ priceMaxUah: 300, onSaleMinPercent: 50, sort: 'DISCOUNT_DESC' }),
          ).toEqual([29, 32, 25])
        })

        it('leaves games without a price out of the price sorts', async () => {
          expect(await ids({ sort: 'PRICE_ASC' })).toEqual([28, 36, 29, 32, 25, 24, 26, 27])
          expect(await ids({ sort: 'PRICE_DESC' })).toEqual([27, 26, 24, 25, 32, 29, 28, 36])
          expect(await ids({ sort: 'DISCOUNT_DESC' })).toEqual([26, 29, 32, 25, 27, 24, 28, 36])
          expect(await total({ sort: 'PRICE_ASC' })).toBe(8)
        })

        it('leaves games without a price out of a price filter', async () => {
          const matching = await ids({ priceMaxUah: 100_000 })
          expect(matching).not.toContain(30)
          expect(matching).not.toContain(31)
          expect(matching).toHaveLength(8)
        })
      })

      describe('sorts', () => {
        it('orders by popularity by default', async () => {
          expect((await ids({})).slice(0, 4)).toEqual([1, 2, 3, 4])
        })

        it('orders by rating', async () => {
          const ordered = await ids({ sort: 'RATING_DESC', pageSize: 40 })
          expect(ordered.slice(0, 2)).toEqual([20, 1])
          expect(ordered.slice(-2)).toEqual([22, 23])
        })

        it('orders by Metacritic', async () => {
          const ordered = await ids({ sort: 'METACRITIC_DESC', pageSize: 40 })
          expect(ordered.slice(0, 3)).toEqual([20, 21, 22])
          expect(ordered.at(-1)).toBe(23)
        })

        it('orders by release date, leaving out games without one', async () => {
          const descending = await adapter.index.search({ sort: 'RELEASED_DESC', pageSize: 40 })
          expect(descending.total).toBe(39)
          expect(descending.ids.slice(0, 2)).toEqual([13, 12])
          expect(descending.ids.slice(-2)).toEqual([11, 10])
          const ascending = await ids({ sort: 'RELEASED_ASC', pageSize: 40 })
          expect(ascending.slice(0, 2)).toEqual([10, 11])
          expect(ascending.at(-1)).toBe(13)
        })

        it('orders by name', async () => {
          const ordered = await adapter.index.search({ sort: 'NAME_ASC', pageSize: 40 })
          expect(ordered.total).toBe(40)
          expect(ordered.ids.slice(0, 4)).toEqual([1, 25, 26, 2])
          expect(ordered.ids.slice(-2)).toEqual([14, 6])
        })

        it('breaks ties by popularity and then by id', async () => {
          expect(await ids({ genres: ['racing'], sort: 'METACRITIC_DESC' })).toEqual([39, 40, 38])
        })
      })

      describe('search', () => {
        it('matches a case-insensitive substring of the name', async () => {
          expect(await ids({ search: 'kite' })).toEqual([35])
          expect(await ids({ search: 'KITE' })).toEqual([35])
          expect(await ids({ search: 'arb' })).toEqual([32])
        })

        it('applies the search before paging', async () => {
          const first = await adapter.index.search({ search: 'ar', page: 1, pageSize: 2 })
          expect(first).toMatchObject({ ids: [10, 25], total: 4 })
          const second = await adapter.index.search({ search: 'ar', page: 2, pageSize: 2 })
          expect(second).toMatchObject({ ids: [32, 37], total: 4 })
          const third = await adapter.index.search({ search: 'ar', page: 3, pageSize: 2 })
          expect(third).toMatchObject({ ids: [], total: 4 })
        })

        it('ignores a blank search', async () => {
          expect(await total({ search: '   ' })).toBe(40)
        })
      })

      describe('paging', () => {
        it('reports the exact total and pages through it', async () => {
          const first = await adapter.index.search({ page: 1, pageSize: 20 })
          expect(first.total).toBe(40)
          expect(first.ids).toHaveLength(20)
          const second = await adapter.index.search({ page: 2, pageSize: 20 })
          expect(second.ids).toHaveLength(20)
          expect(second.ids.every((id) => !first.ids.includes(id))).toBe(true)
        })

        it('answers an out-of-range page with the correct total and no ids', async () => {
          const result = await adapter.index.search({ page: 99, pageSize: 20 })
          expect(result).toMatchObject({ ids: [], total: 40, games: [] })
        })

        it('clamps the page size', async () => {
          const result = await adapter.index.search({ page: 1, pageSize: 500 })
          expect(result.ids).toHaveLength(40)
        })
      })

      describe('documents', () => {
        it('returns the documents of the page in the order of the ids', async () => {
          const result = await adapter.index.search({ genres: ['indie'] })
          expect(result.games.map((entry) => entry.id)).toEqual(result.ids)
          expect(result.games[0]).toEqual(FIXTURE_GAMES.find((entry) => entry.id === 2))
        })

        it('reads one document by id', async () => {
          expect(await adapter.index.getOne(34)).toEqual(
            FIXTURE_GAMES.find((entry) => entry.id === 34),
          )
          expect(await adapter.index.getOne(9999)).toBeNull()
        })

        it('reads many documents and leaves out the unknown ids', async () => {
          const many = await adapter.index.getMany([3, 9999, 7])
          expect([...many.keys()].sort((a, b) => a - b)).toEqual([3, 7])
          expect(many.get(3)?.name).toBe('Gamma Ray')
          expect(await adapter.index.getMany([])).toEqual(new Map())
        })

        it('reports the published meta', async () => {
          const meta = await adapter.index.meta()
          expect(meta).toMatchObject({
            updatedAt: FIXTURE_META.updatedAt,
            pricesUpdatedAt: FIXTURE_META.pricesUpdatedAt,
            gameCount: FIXTURE_GAMES.length,
          })
        })
      })
    })

    describe('versions', () => {
      let adapter: GameIndexAdapter

      beforeAll(async () => {
        adapter = await makeAdapter()
      })

      afterAll(async () => {
        await adapter.teardown?.()
      })

      it('reads nothing before the first version is published', async () => {
        expect(await adapter.index.search({})).toEqual({ ids: [], total: 0, games: [] })
        expect(await adapter.index.getOne(1)).toBeNull()
        expect(await adapter.index.getMany([1, 2])).toEqual(new Map())
        expect(await adapter.index.meta()).toBeNull()
        expect(await adapter.writer.currentVersion()).toBeNull()
      })

      it('keeps an unpublished version invisible and swaps on publish', async () => {
        const first = FIXTURE_GAMES.slice(0, 3)
        await publishGames(adapter, first)
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.writer.currentVersion()).toBe(1)

        const next = await adapter.writer.beginVersion()
        expect(next).not.toBe(1)
        await adapter.writer.putGames(next, FIXTURE_GAMES.slice(3, 6))
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.index.getOne(4)).toBeNull()

        await adapter.writer.publish(next, {
          ...FIXTURE_META,
          version: next,
          gameCount: 3,
          updatedAt: '2026-09-21T06:30:00.000Z',
        })
        expect((await adapter.index.search({})).ids).toEqual([4, 5, 6])
        expect(await adapter.index.getOne(1)).toBeNull()
        expect(await adapter.writer.currentVersion()).toBe(next)
        expect((await adapter.index.meta())?.updatedAt).toBe('2026-09-21T06:30:00.000Z')
      })
    })

    describe('job state outside the version prefix', () => {
      let adapter: GameIndexAdapter

      beforeAll(async () => {
        adapter = await makeAdapter()
      })

      afterAll(async () => {
        await adapter.teardown?.()
      })

      it('stores Steam app ids, including the empty one, across publications', async () => {
        expect(await adapter.writer.getAppId(3328)).toBeNull()
        await adapter.writer.setAppId(3328, '292030')
        await adapter.writer.setAppId(4200, '')
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 2))
        expect(await adapter.writer.getAppId(3328)).toBe('292030')
        expect(await adapter.writer.getAppId(4200)).toBe('')
      })

      it('stores a resume cursor per stage', async () => {
        expect(await adapter.writer.getCursor('prices')).toBeNull()
        await adapter.writer.setCursor('prices', '120')
        await adapter.writer.setCursor('languages', 'abc')
        expect(await adapter.writer.getCursor('prices')).toBe('120')
        expect(await adapter.writer.getCursor('languages')).toBe('abc')
      })
    })
  })
}
