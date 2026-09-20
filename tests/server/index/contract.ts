import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../../shared/catalog'
import type { GameIndex, GameIndexWriter, IndexQuery } from '../../../server/index/GameIndex'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { FIXTURE_GAMES, FIXTURE_TODAY } from '../../fixtures/index/games'

/**
 * The behaviour every `GameIndex` adapter owes its callers. The in-memory adapter and the Upstash
 * adapter run this same suite, so a rule written here is a rule both stores obey — that is the
 * point of keeping the semantics in one file instead of in each adapter's own test.
 *
 * Reads never mutate: the read cases share one published version through `beforeAll`, so a case
 * that writes would leak into its neighbours. Writer behaviour belongs in the groups below, each
 * of which gets its own adapter.
 */

export interface GameIndexAdapter {
  index: GameIndex
  writer: GameIndexWriter
  /** A second run against the same store: what an overlapping job process is. */
  rival: GameIndexWriter
  /** Moves the clock both runs read, so a lock can be old enough to take over. */
  advance: (ms: number) => void
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
  await adapter.writer.writeVersion(version, games)
  await adapter.writer.publish(version, { ...meta, version, gameCount: games.length })
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

      /** The whole ordered result: the fixture is larger than one page on purpose. */
      const allIds = async (query: IndexQuery): Promise<number[]> => {
        const first = await adapter.index.search({ ...query, page: 1, pageSize: MAX_PAGE_SIZE })
        const second = await adapter.index.search({ ...query, page: 2, pageSize: MAX_PAGE_SIZE })
        return [...first.ids, ...second.ids]
      }

      describe('facets', () => {
        it('matches any of the selected values within one facet', async () => {
          expect(await ids({ genres: ['indie'] })).toEqual([2, 3, 5])
          expect(await ids({ genres: ['indie', 'strategy'] })).toEqual([2, 3, 4, 5])
        })

        it('requires every facet to match across facets', async () => {
          expect(await ids({ genres: ['indie'], platforms: [7] })).toEqual([2, 3])
        })

        it('returns nothing when two facets that each match cannot match together', async () => {
          const result = await adapter.index.search({ genres: ['indie'], platforms: [18] })
          expect(result).toEqual({ ids: [], total: 0, games: [] })
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
          const medium = await allIds({ playtime: 'MEDIUM' })
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
        it('includes both bounds of the release year range, 31 December included', async () => {
          expect(await ids({ yearFrom: 2015, yearTo: 2018 })).toEqual([10, 11, 42])
          expect(await ids({ yearTo: 2015 })).toEqual([10])
          expect(await ids({ yearFrom: 2021 })).toEqual([12, 13, 41])
        })

        it('lists only games released after today when upcoming is set', async () => {
          // Game 41 is released exactly on `FIXTURE_TODAY`, which is not upcoming.
          expect(await ids({ upcoming: true, today: FIXTURE_TODAY })).toEqual([13])
        })

        it('includes the bound of the Metacritic minimum', async () => {
          expect(await ids({ metacriticMin: 80 })).toEqual([20, 21])
        })

        it('includes the bound of the rating minimum', async () => {
          const matching = await allIds({ ratingMin: 4 })
          expect(matching).toHaveLength(FIXTURE_GAMES.length - 2)
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
        it('matches free games for free, and ignores free: false', async () => {
          expect(await ids({ free: true })).toEqual([28, 36])
          expect(await total({ free: false })).toBe(FIXTURE_GAMES.length)
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
          const ordered = await allIds({ sort: 'RATING_DESC' })
          expect(ordered.slice(0, 2)).toEqual([20, 1])
          expect(ordered.slice(-2)).toEqual([22, 23])
        })

        it('orders by Metacritic', async () => {
          const ordered = await allIds({ sort: 'METACRITIC_DESC' })
          expect(ordered.slice(0, 3)).toEqual([20, 21, 22])
          expect(ordered.at(-1)).toBe(23)
        })

        it('orders by release date, leaving out games without one', async () => {
          const descending = await adapter.index.search({ sort: 'RELEASED_DESC' })
          expect(descending.total).toBe(FIXTURE_GAMES.length - 1)
          expect(descending.ids.slice(0, 2)).toEqual([13, 41])
          expect((await allIds({ sort: 'RELEASED_DESC' })).slice(-2)).toEqual([11, 10])
          const ascending = await allIds({ sort: 'RELEASED_ASC' })
          expect(ascending.slice(0, 2)).toEqual([10, 11])
          expect(ascending.at(-1)).toBe(13)
        })

        it('orders by name', async () => {
          const ordered = await adapter.index.search({ sort: 'NAME_ASC' })
          expect(ordered.total).toBe(FIXTURE_GAMES.length)
          expect(ordered.ids.slice(0, 4)).toEqual([1, 25, 26, 2])
          expect((await allIds({ sort: 'NAME_ASC' })).slice(-2)).toEqual([14, 6])
        })

        it('breaks ties by popularity and then by id, whichever way the sort runs', async () => {
          // The three racing games share their Metacritic score and their release date; two of
          // them also share their popularity, which leaves the id as the last word.
          expect(await ids({ genres: ['racing'], sort: 'METACRITIC_DESC' })).toEqual([39, 40, 38])
          expect(await ids({ genres: ['racing'], sort: 'RELEASED_ASC' })).toEqual([39, 40, 38])
        })
      })

      describe('search', () => {
        it('matches a case-insensitive substring of the name', async () => {
          expect(await ids({ search: 'kite' })).toEqual([35])
          expect(await ids({ search: 'KITE' })).toEqual([35])
          expect(await ids({ search: 'arb' })).toEqual([32])
        })

        it('combines the search with a facet', async () => {
          expect(await ids({ genres: ['racing'], search: 'o' })).toEqual([39, 38])
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
          expect(await total({ search: '   ' })).toBe(FIXTURE_GAMES.length)
        })
      })

      describe('paging', () => {
        it('reports the exact total and pages through it', async () => {
          const first = await adapter.index.search({ page: 1, pageSize: 20 })
          expect(first.total).toBe(FIXTURE_GAMES.length)
          expect(first.ids).toHaveLength(20)
          const second = await adapter.index.search({ page: 2, pageSize: 20 })
          expect(second.ids).toHaveLength(20)
          expect(second.ids.every((id) => !first.ids.includes(id))).toBe(true)
        })

        it('answers an out-of-range page with the correct total and no ids', async () => {
          const result = await adapter.index.search({ page: 99, pageSize: 20 })
          expect(result).toMatchObject({ ids: [], total: FIXTURE_GAMES.length, games: [] })
        })

        it('clamps the page size down and a missing or invalid one up', async () => {
          // The fixture is larger than one page, so an adapter that ignores the clamp is caught.
          expect((await adapter.index.search({ pageSize: 500 })).ids).toHaveLength(MAX_PAGE_SIZE)
          expect((await adapter.index.search({ pageSize: 0 })).ids).toHaveLength(DEFAULT_PAGE_SIZE)
          expect((await adapter.index.search({ page: 0 })).ids[0]).toBe(1)
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

        it('hands the whole published version to the refresh job', async () => {
          const all = await adapter.writer.allGames()
          expect(all).toHaveLength(FIXTURE_GAMES.length)
          expect(all.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
            FIXTURE_GAMES.map((entry) => entry.id).sort((a, b) => a - b),
          )
          expect(all.find((entry) => entry.id === 3)).toEqual(
            FIXTURE_GAMES.find((entry) => entry.id === 3),
          )
        })

        it('reports the published meta, version included', async () => {
          const meta = await adapter.index.meta()
          expect(meta).toMatchObject({
            updatedAt: FIXTURE_META.updatedAt,
            pricesUpdatedAt: FIXTURE_META.pricesUpdatedAt,
            gameCount: FIXTURE_GAMES.length,
          })
          expect(meta?.version).toBe(await adapter.writer.currentVersion())
        })
      })
    })

    /**
     * Every case here builds the state it asserts on, on an adapter of its own: a version is what
     * these cases are about, so one leaving its version behind would decide the next one's answer
     * and a run of a single case would prove something else than the whole file does.
     */
    describe('versions', () => {
      const used: GameIndexAdapter[] = []

      const fresh = async (): Promise<GameIndexAdapter> => {
        const adapter = await makeAdapter()
        used.push(adapter)
        return adapter
      }

      afterEach(async () => {
        while (used.length > 0) await used.pop()?.teardown?.()
      })

      it('reads nothing before the first version is published', async () => {
        const adapter = await fresh()
        expect(await adapter.index.search({})).toEqual({ ids: [], total: 0, games: [] })
        expect(await adapter.index.getOne(1)).toBeNull()
        expect(await adapter.index.getMany([1, 2])).toEqual(new Map())
        expect(await adapter.index.meta()).toBeNull()
        expect(await adapter.writer.meta()).toBeNull()
        expect(await adapter.writer.allGames()).toEqual([])
        expect(await adapter.writer.previousMeta()).toBeNull()
        expect(await adapter.writer.currentVersion()).toBeNull()
      })

      it('keeps an unpublished version invisible and swaps on publish', async () => {
        const adapter = await fresh()
        const first = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.writer.currentVersion()).toBe(first)

        const next = await adapter.writer.beginVersion()
        expect(next).not.toBe(first)
        await adapter.writer.writeVersion(next, FIXTURE_GAMES.slice(3, 6))
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

      it('remembers the meta of the version a publish replaced', async () => {
        const adapter = await fresh()
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        await publishGames(adapter, FIXTURE_GAMES.slice(3, 6), {
          ...FIXTURE_META,
          updatedAt: '2026-09-21T06:30:00.000Z',
        })
        expect((await adapter.writer.previousMeta())?.updatedAt).toBe(FIXTURE_META.updatedAt)
        expect((await adapter.writer.meta())?.updatedAt).toBe('2026-09-21T06:30:00.000Z')
      })

      it('refuses to rewrite the version that is published', async () => {
        const adapter = await fresh()
        const version = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        await expect(
          adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(3, 6)),
        ).rejects.toThrow()
        // A rewrite empties the version before it fills it again; the live one must not be seen
        // half-written, so it is refused rather than attempted.
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.index.getOne(1)).not.toBeNull()
      })

      it('refuses to discard the version that is published', async () => {
        const adapter = await fresh()
        const version = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        await expect(adapter.writer.discardVersion(version)).rejects.toThrow()
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.writer.currentVersion()).toBe(version)
      })

      it('republishes the current version as a no-op that only refreshes the meta', async () => {
        const adapter = await fresh()
        const version = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        await adapter.writer.publish(version, {
          ...FIXTURE_META,
          version,
          gameCount: 3,
          updatedAt: '2026-09-22T06:30:00.000Z',
        })
        expect(await adapter.writer.currentVersion()).toBe(version)
        expect((await adapter.index.meta())?.updatedAt).toBe('2026-09-22T06:30:00.000Z')
        // The version must not be treated as the one it replaced: its own keys stay untouched.
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
        expect(await adapter.index.getOne(1)).not.toBeNull()
        expect(await adapter.writer.previousMeta()).toBeNull()
      })

      it('never hands out a version number twice', async () => {
        const adapter = await fresh()
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        const current = await adapter.writer.currentVersion()
        const seen = new Set<number>(current === null ? [] : [current])
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const version = await adapter.writer.beginVersion()
          expect(seen.has(version)).toBe(false)
          seen.add(version)
          await adapter.writer.discardVersion(version)
        }
      })

      it('writes a version whole, replacing whatever was written before the publish', async () => {
        const adapter = await fresh()
        const version = await adapter.writer.beginVersion()
        await adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(0, 5))
        await adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(6, 8))
        await adapter.writer.publish(version, { ...FIXTURE_META, version, gameCount: 2 })
        expect((await adapter.index.search({})).ids).toEqual([7, 8])
      })

      it('forgets a discarded version and refuses to publish it', async () => {
        const adapter = await fresh()
        await publishGames(adapter, FIXTURE_GAMES.slice(6, 8))
        const version = await adapter.writer.beginVersion()
        await adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(8, 10))
        await adapter.writer.discardVersion(version)
        expect((await adapter.index.search({})).ids).toEqual([7, 8])
        await expect(
          adapter.writer.publish(version, { ...FIXTURE_META, version, gameCount: 2 }),
        ).rejects.toThrow()
      })

      it('refuses to write a version that was never begun', async () => {
        const adapter = await fresh()
        await expect(adapter.writer.writeVersion(9_999, FIXTURE_GAMES)).rejects.toThrow()
      })

      it('refuses to publish a version that was never written', async () => {
        const adapter = await fresh()
        const version = 9_999
        await expect(
          adapter.writer.publish(version, { ...FIXTURE_META, version, gameCount: 0 }),
        ).rejects.toThrow()
      })
    })

    /**
     * One run writes at a time. Two overlapping runs — a retried workflow beside the schedule —
     * would each move the pointer and one of them would leave its whole version behind, so a run
     * takes a lock before it begins a version and gives it back when it publishes or gives up.
     */
    describe('the write lock', () => {
      const used: GameIndexAdapter[] = []

      const fresh = async (): Promise<GameIndexAdapter> => {
        const adapter = await makeAdapter()
        used.push(adapter)
        return adapter
      }

      afterEach(async () => {
        while (used.length > 0) await used.pop()?.teardown?.()
      })

      it('refuses a second run while the first is between begin and publish', async () => {
        const adapter = await fresh()
        await adapter.writer.beginVersion()
        await expect(adapter.rival.beginVersion()).rejects.toThrow()
      })

      it('lets the next run begin once the first has published', async () => {
        const adapter = await fresh()
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
        await expect(adapter.rival.beginVersion()).resolves.toBeGreaterThan(0)
      })

      it('lets the next run begin once the first has given up', async () => {
        const adapter = await fresh()
        const version = await adapter.writer.beginVersion()
        await adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(0, 3))
        await adapter.writer.discardVersion(version)
        await expect(adapter.rival.beginVersion()).resolves.toBeGreaterThan(0)
      })

      it('says who holds the lock and how to take it over', async () => {
        const adapter = await fresh()
        await adapter.writer.beginVersion()
        await expect(adapter.rival.beginVersion()).rejects.toThrow(/held the write lock/)
        await expect(adapter.rival.beginVersion()).rejects.toThrow(/force/)
      })

      it('takes over a lock that has been held far too long, when a run forces it', async () => {
        const adapter = await fresh()
        await adapter.writer.beginVersion()
        await expect(adapter.rival.beginVersion({ force: true })).rejects.toThrow()
        adapter.advance(31 * 60 * 1000)
        await expect(adapter.rival.beginVersion({ force: true })).resolves.toBeGreaterThan(0)
        // The run that lost the lock can no longer write with it.
        await expect(adapter.writer.beginVersion()).rejects.toThrow(/held the write lock/)
      })

      it('refuses every write from a run that does not hold the lock', async () => {
        const adapter = await fresh()
        const version = await adapter.writer.beginVersion()
        await adapter.writer.writeVersion(version, FIXTURE_GAMES.slice(0, 3))
        await expect(adapter.rival.writeVersion(version, FIXTURE_GAMES)).rejects.toThrow()
        await expect(
          adapter.rival.publish(version, { ...FIXTURE_META, version, gameCount: 3 }),
        ).rejects.toThrow()
        await expect(adapter.rival.discardVersion(version)).rejects.toThrow()
        // The run that does hold it is unaffected.
        await adapter.writer.publish(version, { ...FIXTURE_META, version, gameCount: 3 })
        expect((await adapter.index.search({})).ids).toEqual([1, 2, 3])
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

      it('stores Steam app ids in batches, including the empty one, across publications', async () => {
        expect(await adapter.writer.getAppIds([3328, 4200])).toEqual(new Map())
        await adapter.writer.setAppIds([
          [3328, '292030'],
          [4200, ''],
        ])
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 2))
        const resolved = await adapter.writer.getAppIds([3328, 4200, 5000])
        expect(resolved.get(3328)).toBe('292030')
        expect(resolved.get(4200)).toBe('')
        expect(resolved.has(5000)).toBe(false)
      })

      it('stores Steam language records in batches, across publications', async () => {
        expect(await adapter.writer.getLanguages(['292030'])).toEqual(new Map())
        await adapter.writer.setLanguages([
          [
            '292030',
            { text: true, audio: true, isFree: false, updatedAt: '2026-09-13T00:00:00.000Z' },
          ],
          [
            '413150',
            { text: true, audio: false, isFree: false, updatedAt: '2026-09-20T00:00:00.000Z' },
          ],
        ])
        await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))

        const records = await adapter.writer.getLanguages(['292030', '413150', '999'])
        expect(records.get('292030')).toEqual({
          text: true,
          audio: true,
          isFree: false,
          updatedAt: '2026-09-13T00:00:00.000Z',
        })
        expect(records.get('413150')?.audio).toBe(false)
        expect(records.has('999')).toBe(false)
      })

      it('overwrites a language record with a newer read', async () => {
        await adapter.writer.setLanguages([
          [
            '620',
            { text: false, audio: false, isFree: false, updatedAt: '2026-09-01T00:00:00.000Z' },
          ],
        ])
        await adapter.writer.setLanguages([
          [
            '620',
            { text: true, audio: false, isFree: true, updatedAt: '2026-09-20T00:00:00.000Z' },
          ],
        ])

        expect((await adapter.writer.getLanguages(['620'])).get('620')).toEqual({
          text: true,
          audio: false,
          isFree: true,
          updatedAt: '2026-09-20T00:00:00.000Z',
        })
      })

      it('stores and clears a resume cursor per stage', async () => {
        expect(await adapter.writer.getCursor('prices')).toBeNull()
        await adapter.writer.setCursor('prices', '120')
        await adapter.writer.setCursor('languages', 'abc')
        expect(await adapter.writer.getCursor('prices')).toBe('120')
        expect(await adapter.writer.getCursor('languages')).toBe('abc')
        await adapter.writer.clearCursor('prices')
        expect(await adapter.writer.getCursor('prices')).toBeNull()
        expect(await adapter.writer.getCursor('languages')).toBe('abc')
      })
    })
  })
}
