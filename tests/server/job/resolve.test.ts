import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_ID_BATCH_SIZE } from '../../../scripts/index/appIds'
import {
  CANDIDATE_PAGE_SIZE,
  collectCandidates,
  DEFAULT_CANDIDATE_PAGES,
} from '../../../scripts/index/candidates'
import {
  assertResolveOptions,
  isReleased,
  RESOLVE_BUDGET_MS,
  RESOLVE_DEFAULT_FROM_PAGE,
  RESOLVE_DEFAULT_PAGES,
  RESOLVE_MAX_BUDGET,
  RESOLVE_STORES,
  resolveMoreGames,
  resolveWarnings,
  type ResolveOptions,
} from '../../../scripts/index/resolve'
import { errorLine, formatSummary, parseArgs, runCli, runJob } from '../../../scripts/index/run'
import type { IndexedStoreRefs } from '../../../server/index/document'
import { createMemoryGameIndex, MemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import type { RawgGameListItem, RawgStoreLink } from '../../../server/rawg/types'
import { STORE_OPTIONS } from '../../../shared/catalog'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createFakeRedis } from '../index/fakeRedis'
import {
  createJobHarness,
  createRawgWire,
  createWireHarness,
  type RawgWire,
  type WireAnswer,
  type WireHarness,
  type WireRequest,
} from './harness'

/**
 * `--mode=resolve`: the store pages of the next most popular games, inside a fixed number of RAWG
 * requests, with nothing published.
 *
 * Almost every rule here is a statement about requests — which were sent, in what order, and how
 * many — so the stage runs on the transport `runCli` builds, over a RAWG that stands behind
 * `fetch` (`createRawgWire`). What is counted is what reached it: `wire.requests`. No test here
 * reads the meter to learn how many requests were sent; the meter is what is being tested.
 */

const RUN_AT = '2026-10-13T09:00:00.000Z'
const TODAY = '2026-10-13'
const MINUTE = 60_000

/** RAWG's ids of the stores a game is listed on. */
const STORE = { steam: 1, xbox: 2, playstation: 3, gog: 5, nintendo: 6, epic: 11 } as const
type StoreName = keyof typeof STORE

/** The link RAWG has to a game on each store, in the shape the job's parsers read. */
const LINK: Record<number, (id: number) => string> = {
  [STORE.steam]: (id) => `https://store.steampowered.com/app/${id}0/`,
  [STORE.gog]: (id) => `https://www.gog.com/game/game_${id}`,
  [STORE.xbox]: (id) =>
    `https://www.microsoft.com/en-us/p/game-${id}/9n${String(id).padStart(10, '0')}`,
  [STORE.playstation]: (id) => `https://store.playstation.com/en-us/product/UP0001-GAME${id}`,
  [STORE.nintendo]: (id) => `https://www.nintendo.com/store/products/game-${id}/`,
  [STORE.epic]: (id) => `https://store.epicgames.com/p/game-${id}`,
}

/** One game of RAWG's list: out since 2020 and on Steam, unless the case says otherwise. */
function listed(
  id: number,
  fields: Partial<RawgGameListItem> & { on?: StoreName[] } = {},
): RawgGameListItem {
  const { on = ['steam'], ...rest } = fields
  return {
    id,
    slug: `game-${id}`,
    name: `Game ${id}`,
    released: '2020-05-05',
    tba: false,
    added: 1_000_000 - id,
    stores: on.map((store) => ({ store: { id: STORE[store] } })),
    ...rest,
  }
}

/** The links RAWG has for a game: one for each store it lists the game on, in that order. */
function linksOf(game: RawgGameListItem): RawgStoreLink[] {
  return (game.stores ?? []).map(({ store }, index) => ({
    id: game.id! * 10 + index,
    store_id: store!.id!,
    url: LINK[store!.id!]!(game.id!),
  }))
}

/** `count` games on Steam with consecutive ids from `first`. */
const run = (first: number, count: number) =>
  Array.from({ length: count }, (_, index) => listed(first + index))

/** A RAWG with these pages of the order, and for every game on them the links of its stores. */
function rawgWith(pages: Record<number, RawgGameListItem[]>): RawgWire {
  const links: Record<string, RawgStoreLink[]> = {}
  for (const game of Object.values(pages).flat()) if (game) links[game.slug!] = linksOf(game)
  return createRawgWire(pages, links)
}

/** A run of the job against `wire`: a transport of its own, and the index it is given. */
function against(wire: RawgWire, writer?: WireHarness['writer']): WireHarness {
  const harness = createWireHarness({ start: RUN_AT, wire, writer })
  vi.stubGlobal('fetch', wire.fetch)
  return harness
}

const options = (budget: number, extra: Partial<ResolveOptions> = {}): ResolveOptions => ({
  budget,
  fromPage: 76,
  pages: 250,
  ...extra,
})

const storesOf = (...ids: number[]) => ids.map((id) => `games/game-${id}/stores`)
const asked = (wire: RawgWire) => wire.lookupRequests().map((request) => request.path)
const pagesRead = (wire: RawgWire) =>
  wire.pageRequests().map((request) => Number(request.params.page))
const lookupOf = (id: number) => (request: WireRequest) =>
  request.path === `games/game-${id}/stores`
const pageOf = (page: number) => (request: WireRequest) =>
  request.path === 'games' && request.params.page === String(page)
const BAD_GATEWAY: WireAnswer = { status: 502 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the numbers a resolve run is held to', () => {
  it('are the ones the owner set', () => {
    expect(RESOLVE_MAX_BUDGET).toBe(8000)
    expect(RESOLVE_DEFAULT_PAGES).toBe(250)
    expect(RESOLVE_BUDGET_MS).toBe(60 * MINUTE)
    // The first page after the nightly run's seventy-five.
    expect(DEFAULT_CANDIDATE_PAGES).toBe(75)
    expect(RESOLVE_DEFAULT_FROM_PAGE).toBe(76)
  })

  it('names the four stores by the slugs the catalog and the documents carry', () => {
    expect([...RESOLVE_STORES]).toEqual(['steam', 'gog', 'xbox-store', 'playstation-store'])
    const catalog = STORE_OPTIONS.map((option) => option.slug as string)
    for (const slug of RESOLVE_STORES) expect(catalog).toContain(slug)
    expect(STORE_OPTIONS.find((option) => option.name === 'PlayStation Store')?.slug).toBe(
      'playstation-store',
    )
  })
})

describe('isReleased', () => {
  it.each([
    ['a game out for years', { released: '2015-05-18', tba: false }, true],
    ['a game out today', { released: TODAY, tba: false }, true],
    ['a game with no mark at all beside its date', { released: '2020-01-01' }, true],
    ['a game due tomorrow', { released: '2026-10-14', tba: false }, false],
    ['a game due next year', { released: '2027-03-01', tba: false }, false],
    ['a game with no date', { released: null, tba: false }, false],
    ['a game whose date is missing', { tba: false }, false],
    ['a game to be announced, with no date', { released: null, tba: true }, false],
    [
      'a game to be announced, whatever date stands beside it',
      { released: '2020-01-01', tba: true },
      false,
    ],
    ['a game whose date is no date', { released: 'Q4 2025', tba: false }, false],
    ['a game whose date is a year alone', { released: '2020', tba: false }, false],
  ])('%s: %o', (_what, game, expected) => {
    expect(isReleased(game, TODAY)).toBe(expected)
  })
})

describe('resolveMoreGames: who is asked', () => {
  it('asks about the released games on one of the four stores that nothing is known about', async () => {
    const wire = rawgWith({
      76: [
        listed(201),
        listed(202, { released: null }),
        listed(203, { on: [] }),
        listed(204, { on: ['gog', 'xbox'] }),
        listed(205),
        listed(206, { on: ['playstation'] }),
      ],
    })
    const harness = against(wire)
    await harness.writer.setAppIds([[205, '2050']])

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(asked(wire)).toEqual(storesOf(201, 204, 206))
    expect(report).toMatchObject({
      seen: 6,
      skipped: { notReleased: 1, noStore: 1, known: 1 },
      asked: 3,
      failed: 0,
      unasked: 0,
    })
  })

  it.each([
    ['has no release date', { released: null }],
    ['is due tomorrow', { released: '2026-10-14' }],
    ['is to be announced', { tba: true }],
    ['is to be announced and has no date', { released: null, tba: true }],
  ])(
    'does not ask about a game that %s, though it is on Steam and unknown',
    async (_why, fields) => {
      const wire = rawgWith({ 76: [listed(201, fields), listed(202)] })
      const harness = against(wire)

      const report = await resolveMoreGames(harness.deps, options(100))

      expect(asked(wire)).toEqual(storesOf(202))
      expect(report.skipped).toEqual({ notReleased: 1, noStore: 0, known: 0 })
      // Not asked is not known: the day it is out, a run asks.
      expect(await harness.writer.getAppIds([201])).toEqual(new Map())
      expect(await harness.writer.getStoreRefs([201])).toEqual(new Map())
    },
  )

  it('asks about a game that is out on the day of the run', async () => {
    const wire = rawgWith({ 76: [listed(201, { released: TODAY })] })

    await resolveMoreGames(against(wire).deps, options(100))

    expect(asked(wire)).toEqual(storesOf(201))
  })

  it.each([['steam'], ['gog'], ['xbox'], ['playstation']] as [StoreName][])(
    'asks about a game RAWG lists on %s alone',
    async (store) => {
      const wire = rawgWith({ 76: [listed(201, { on: [store] })] })

      const report = await resolveMoreGames(against(wire).deps, options(100))

      expect(asked(wire)).toEqual(storesOf(201))
      expect(report.skipped.noStore).toBe(0)
    },
  )

  it.each([
    ['on no store at all', []],
    ['on the Epic Games Store alone', ['epic']],
    ['on Nintendo’s store alone', ['nintendo']],
    ['on stores the job reads none of', ['epic', 'nintendo']],
  ] as [string, StoreName[]][])(
    'does not ask about a game %s, though it is out and unknown',
    async (_where, on) => {
      const wire = rawgWith({ 76: [listed(201, { on }), listed(202)] })

      const report = await resolveMoreGames(against(wire).deps, options(100))

      expect(asked(wire)).toEqual(storesOf(202))
      expect(report.skipped).toEqual({ notReleased: 0, noStore: 1, known: 0 })
    },
  )

  it.each([
    ['a Steam app id', { appId: '2010' }],
    ['the empty app id, "asked, no Steam page"', { appId: '' }],
    ['a store-reference record', { record: { gog: 'game_201' } }],
    ['a record that says nothing of either store', { record: {} }],
    ['a record of links alone', { record: { links: [[3, LINK[3]!(201)]] } }],
  ] as [string, { appId?: string; record?: IndexedStoreRefs }][])(
    'does not ask about a game that has %s, though it is out and on Steam',
    async (_what, known) => {
      const wire = rawgWith({ 76: [listed(201), listed(202)] })
      const harness = against(wire)
      if (known.appId !== undefined) await harness.writer.setAppIds([[201, known.appId]])
      if (known.record) await harness.writer.setStoreRefs([[201, known.record]])

      const report = await resolveMoreGames(harness.deps, options(100))

      expect(asked(wire)).toEqual(storesOf(202))
      expect(report.skipped).toEqual({ notReleased: 0, noStore: 0, known: 1 })
    },
  )

  it('counts a game under the first rule that leaves it out, once', async () => {
    const wire = rawgWith({
      // Not out, on no store and known, all three; on no store and known; known alone.
      76: [listed(201, { released: null, on: [] }), listed(202, { on: [] }), listed(203)],
    })
    const harness = against(wire)
    await harness.writer.setAppIds([201, 202, 203].map((id) => [id, '']))

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(asked(wire)).toEqual([])
    expect(report).toMatchObject({
      seen: 3,
      skipped: { notReleased: 1, noStore: 1, known: 1 },
    })
  })

  it('asks most popular first: in the order of the pages, and of the games on a page', async () => {
    // Ids and counts that say nothing about the order: RAWG's is the order of the list.
    const pages = {
      76: [listed(350, { added: 10 }), listed(310, { added: 90 })],
      77: [listed(390, { added: 50 }), listed(305, { added: 70 })],
    }

    const whole = rawgWith(pages)
    await resolveMoreGames(against(whole).deps, options(100))
    expect(asked(whole)).toEqual(storesOf(350, 310, 390, 305))

    // And when the budget ends first, it is the top of that order that was asked about.
    const cut = rawgWith(pages)
    const report = await resolveMoreGames(against(cut).deps, options(5))
    expect(asked(cut)).toEqual(storesOf(350, 310, 390))
    expect(report).toMatchObject({ asked: 3, unasked: 1, stopped: 'budget' })
  })

  it('reads the pages in order from the first one it is given, with the candidates’ own query', async () => {
    const wire = rawgWith({ 80: run(201, 2), 81: run(203, 2), 82: run(205, 2) })

    const report = await resolveMoreGames(
      against(wire).deps,
      options(100, { fromPage: 80, pages: 2 }),
    )

    expect(pagesRead(wire)).toEqual([80, 81])
    expect(report).toMatchObject({ pagesRead: 2, lastPage: 81, readingEnded: 'pages' })
    expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204))

    // The list the index is the top of: the same ordering and the same page size, read from
    // what the full run's own walk sends rather than written down a second time.
    const nightly = rawgWith({ 1: run(1, 1) })
    await collectCandidates(against(nightly).deps, { pages: 1 })
    const { page: _first, ...query } = nightly.pageRequests()[0]!.params
    expect(query).toEqual({ ordering: '-added', page_size: String(CANDIDATE_PAGE_SIZE) })
    for (const request of wire.pageRequests()) {
      const { page: _page, ...sent } = request.params
      expect(sent).toEqual(query)
    }
  })

  it('asks once about a game RAWG’s shifting pages bring twice', async () => {
    const wire = rawgWith({ 76: [listed(201), listed(202)], 77: [listed(202), listed(203)] })

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(asked(wire)).toEqual(storesOf(201, 202, 203))
    expect(report.seen).toBe(3)
  })

  it('ignores an entry of a page that has no id or no slug', async () => {
    const wire = rawgWith({
      76: [{ name: 'No id', slug: 'no-id' }, { id: 9, name: 'No slug' }, listed(201)],
    })

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(asked(wire)).toEqual(storesOf(201))
    expect(report).toMatchObject({ seen: 1, unreadable: 2 })
  })

  it('skips and counts an entry the card mapping cannot take, and goes on with the others', async () => {
    const wire = rawgWith({
      76: [
        listed(201),
        // A `null` among the tags, an entry that is no object, a `null` in the platform list.
        { ...listed(202), tags: [null as never] },
        null as never,
        { ...listed(203), platforms: [null as never] },
        listed(204),
      ],
      77: [listed(205)],
    })
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    // Both pages were read and paid for; the good games on them were asked about.
    expect(pagesRead(wire)).toEqual([76, 77])
    expect(asked(wire)).toEqual(storesOf(201, 204, 205))
    expect(report).toMatchObject({ seen: 3, unreadable: 3, asked: 3, stopped: 'done' })
    expect(
      formatSummary(
        await runJob(against(rawgWith({ 76: [null as never, listed(301)] })).deps, {
          mode: 'resolve',
          pages: 250,
          forceUnlock: false,
          budget: 10,
        }),
      ),
    ).toContain(
      '| Skipped | 0 not released, 0 on none of the four stores, 0 already known; 1 entry of a page could not be read as a game |',
    )
  })
})

describe('resolveMoreGames: what an answer leaves behind', () => {
  it('writes the Steam app id, and a record of the references with RAWG’s links beside them', async () => {
    const wire = rawgWith({ 76: [listed(201, { on: ['steam', 'gog', 'xbox', 'playstation'] })] })
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(await harness.writer.getAppIds([201])).toEqual(new Map([[201, '2010']]))
    expect((await harness.writer.getStoreRefs([201])).get(201)).toEqual({
      gog: 'game_201',
      microsoft: { id: '9N0000000201', name: 'game-201' },
      // Every link, the PlayStation Store's among them, which no parser reads yet.
      links: [
        [1, 'https://store.steampowered.com/app/2010/'],
        [5, 'https://www.gog.com/game/game_201'],
        [2, 'https://www.microsoft.com/en-us/p/game-201/9n0000000201'],
        [3, 'https://store.playstation.com/en-us/product/UP0001-GAME201'],
      ],
    })
    expect(report).toMatchObject({ asked: 1, steam: 1, gog: 1, microsoft: 1, failed: 0 })
  })

  it('writes the empty app id for a game RAWG lists on Steam and links to no Steam page', async () => {
    const wire = rawgWith({ 76: [listed(201, { on: ['steam', 'gog'] })] })
    wire.links.set('game-201', [
      { store_id: STORE.steam, url: 'https://publisher.example/buy/game-201' },
    ])
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(await harness.writer.getAppIds([201])).toEqual(new Map([[201, '']]))
    // On GOG by RAWG's list, with no GOG link: asked, and nothing to read.
    expect((await harness.writer.getStoreRefs([201])).get(201)).toEqual({
      gog: null,
      links: [[1, 'https://publisher.example/buy/game-201']],
    })
    expect(report).toMatchObject({ asked: 1, steam: 0, gog: 0, microsoft: 0 })
  })

  it('writes no app id for a game RAWG does not list on Steam, and knows it by its record', async () => {
    const wire = rawgWith({
      76: [listed(201, { on: ['playstation'] }), listed(202, { on: ['gog'] })],
    })
    const harness = against(wire)

    await resolveMoreGames(harness.deps, options(100))

    // "No Steam page" would be an answer the nightly run takes for good; for a game that is not
    // on Steam it was never asked. The day RAWG lists it there, the app-id stage asks.
    expect(await harness.writer.getAppIds([201, 202])).toEqual(new Map())
    const records = await harness.writer.getStoreRefs([201, 202])
    expect(records.get(201)).toEqual({
      links: [[3, 'https://store.playstation.com/en-us/product/UP0001-GAME201']],
    })
    expect(records.get(202)).toEqual({
      gog: 'game_202',
      links: [[5, 'https://www.gog.com/game/game_202']],
    })

    // And the record is enough for the next run to leave both alone.
    const again = against(wire, harness.writer)
    const second = await resolveMoreGames(again.deps, options(100))
    expect(asked(wire)).toEqual(storesOf(201, 202))
    expect(second).toMatchObject({ asked: 0, skipped: { known: 2 } })
  })

  it('keeps the app id a link names though RAWG’s list does not put the game on Steam', async () => {
    const wire = rawgWith({ 76: [listed(201, { on: ['gog'] })] })
    wire.links.set('game-201', [
      { store_id: STORE.steam, url: 'https://store.steampowered.com/app/777/' },
    ])
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(await harness.writer.getAppIds([201])).toEqual(new Map([[201, '777']]))
    expect(report.steam).toBe(1)
  })

  it('remembers a game RAWG has no link for at all, so that it is not asked about twice', async () => {
    const wire = rawgWith({ 76: [listed(201, { on: ['playstation'] }), listed(202)] })
    wire.links.set('game-201', [])
    wire.links.set('game-202', [])
    const harness = against(wire)

    await resolveMoreGames(harness.deps, options(100))

    // Nothing to say of either store and no link to keep: a record all the same, because the
    // record is what says "asked".
    expect((await harness.writer.getStoreRefs([201])).get(201)).toEqual({})
    expect(await harness.writer.getAppIds([201, 202])).toEqual(new Map([[202, '']]))

    await resolveMoreGames(against(wire, harness.writer).deps, options(100))
    expect(asked(wire)).toEqual(storesOf(201, 202))
  })

  it.each([
    ['RAWG refuses for good', [{ status: 404 }]],
    ['RAWG fails and fails again', [BAD_GATEWAY, BAD_GATEWAY]],
    ['RAWG times out twice', ['timeout', 'timeout']],
    ['RAWG answers with no body', [{ status: 200, body: null }]],
    ['RAWG answers with something that is no list of links', [{ status: 200, body: { count: 0 } }]],
  ] as [string, WireAnswer[]][])(
    'writes nothing about a game when %s, and leaves it for another run',
    async (_how, answers) => {
      const wire = rawgWith({
        76: [listed(201), listed(202, { on: ['steam', 'gog'] }), listed(203)],
      })
      wire.answerNext(lookupOf(202), ...answers)
      const harness = against(wire)

      const report = await resolveMoreGames(harness.deps, options(100))

      expect(report).toMatchObject({ asked: 3, failed: 1, steam: 2, stopped: 'done' })
      // Not "no Steam page" and not "no link to read": either would make one failure permanent.
      expect(await harness.writer.getAppIds([201, 202, 203])).toEqual(
        new Map([
          [201, '2010'],
          [203, '2030'],
        ]),
      )
      expect((await harness.writer.getStoreRefs([201, 202, 203])).has(202)).toBe(false)
      expect(harness.logs).toContain(
        'resolve: game-202 could not be read, leaving it for another run',
      )

      // The next run asks about that game and about no other.
      const before = wire.lookupRequests().length
      const next = against(wire, harness.writer)
      const second = await resolveMoreGames(next.deps, options(100))
      expect(asked(wire).slice(before)).toEqual(storesOf(202))
      expect(second).toMatchObject({ asked: 1, failed: 0, skipped: { known: 2 } })
      expect(await next.writer.getAppIds([202])).toEqual(new Map([[202, '2020']]))
    },
  )

  it('writes in batches as the app ids do, the records first, and what is left when it stops', async () => {
    const wire = rawgWith({ 76: run(201, 5) })
    const harness = against(wire)
    const written: string[] = []
    const setAppIds = harness.writer.setAppIds.bind(harness.writer)
    const setStoreRefs = harness.writer.setStoreRefs.bind(harness.writer)
    vi.spyOn(harness.writer, 'setAppIds').mockImplementation(async (entries) => {
      const batch = [...entries]
      written.push(`app ids ${batch.map(([id]) => id).join(' ')}`)
      return setAppIds(batch)
    })
    vi.spyOn(harness.writer, 'setStoreRefs').mockImplementation(async (entries) => {
      const batch = [...entries]
      written.push(`records ${batch.map(([id]) => id).join(' ')}`)
      return setStoreRefs(batch)
    })

    await resolveMoreGames(harness.deps, options(100, { batchSize: 2 }))

    expect(written).toEqual([
      'records 201 202',
      'app ids 201 202',
      'records 203 204',
      'app ids 203 204',
      'records 205',
      'app ids 205',
    ])
    expect(APP_ID_BATCH_SIZE).toBe(100)
  })

  it('keeps what it had learned when the budget ends it between two batches', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    const harness = against(wire)

    // One page and seven lookups, none of them at a batch's end.
    const report = await resolveMoreGames(harness.deps, options(8))

    expect(report).toMatchObject({ asked: 7, stopped: 'budget' })
    const ids = Array.from({ length: 40 }, (_, index) => 201 + index)
    expect([...(await harness.writer.getAppIds(ids)).keys()]).toEqual(ids.slice(0, 7))
    expect([...(await harness.writer.getStoreRefs(ids)).keys()]).toEqual(ids.slice(0, 7))
  })

  it('puts no link and no answer of RAWG’s into the log', async () => {
    const wire = rawgWith({
      76: [listed(201, { on: ['steam', 'gog', 'playstation'] }), listed(202)],
    })
    wire.answerNext(lookupOf(202), { status: 404 })
    const harness = against(wire)

    await resolveMoreGames(harness.deps, options(100))

    expect(harness.logs.join('\n')).not.toMatch(/https?:|store\.|gog\.com|UP0001/)
  })

  it('writes no name that could begin a command of the runner into the log', async () => {
    const wire = rawgWith({ 76: [listed(201, { slug: '##[stop-commands]x' })] })
    wire.answerNext((request) => request.path.endsWith('/stores'), { status: 404 })
    const harness = against(wire)

    await resolveMoreGames(harness.deps, options(100))

    expect(harness.logs).toContain(
      'resolve: ## [stop-commands]x could not be read, leaving it for another run',
    )
    expect(harness.logs.some((line) => line.includes('##['))).toBe(false)
  })
})

describe('resolveMoreGames: the budget', () => {
  it('sends exactly as many requests as it was given when there is more to do', async () => {
    const wire = rawgWith({ 76: run(201, 40), 77: run(241, 40), 78: run(281, 40) })
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(10))

    // One page — its forty games are more than nine requests can ask about — and nine lookups.
    expect(wire.requests).toHaveLength(10)
    expect(pagesRead(wire)).toEqual([76])
    expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204, 205, 206, 207, 208, 209))
    expect(report).toMatchObject({
      budget: 10,
      requests: { pages: 1, lookups: 9, retries: 0, total: 10 },
      asked: 9,
      unasked: 31,
      readingEnded: 'enough',
      stopped: 'budget',
    })
    expect(harness.meter.issued()).toBe(10)
  })

  it.each([1, 2, 3, 7, 41, 42, 43, 60, 83, 84, 100, 121, 122])(
    'sends exactly %i requests of a budget of that many',
    async (budget) => {
      const wire = rawgWith({
        76: run(201, 40),
        77: run(241, 40),
        78: run(281, 40),
        79: run(321, 40),
      })

      const report = await resolveMoreGames(against(wire).deps, options(budget))

      expect(wire.requests).toHaveLength(budget)
      expect(report.requests.total).toBe(budget)
      expect(report.requests.pages + report.requests.lookups + report.requests.retries).toBe(budget)
      expect(report.stopped).toBe('budget')
    },
  )

  it('counts pages and lookups against the one budget, and reads no page it could not use', async () => {
    const wire = rawgWith({ 76: run(201, 5), 77: run(206, 5), 78: run(211, 5), 79: run(216, 5) })

    const report = await resolveMoreGames(against(wire).deps, options(13))

    // Page 76: five games wait and eleven requests are left, so 77 is read; ten wait and ten
    // are left after 78. Page 79 would cost a request no game on it could ever get.
    expect(wire.requests).toHaveLength(13)
    expect(pagesRead(wire)).toEqual([76, 77, 78])
    expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204, 205, 206, 207, 208, 209, 210))
    expect(report).toMatchObject({
      requests: { pages: 3, lookups: 10, retries: 0, total: 13 },
      readingEnded: 'enough',
      unasked: 5,
      // Where the next run can begin: the pages before it are done with.
      firstUnaskedPage: 78,
      stopped: 'budget',
    })
  })

  it('counts the transport’s retry of a lookup, and spends the last request on it', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    wire.answerNext(lookupOf(202), BAD_GATEWAY)
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(4))

    // The page, game 201, game 202 — which failed — and game 202 again: four, and the fourth a
    // retry. What the retry learned is kept.
    expect(wire.requests.map((request) => request.path)).toEqual([
      'games',
      ...storesOf(201, 202, 202),
    ])
    expect(report).toMatchObject({
      requests: { pages: 1, lookups: 2, retries: 1, total: 4 },
      asked: 2,
      failed: 0,
      stopped: 'budget',
    })
    expect(await harness.writer.getAppIds([201, 202, 203])).toEqual(
      new Map([
        [201, '2010'],
        [202, '2020'],
      ]),
    )
  })

  it('does not send the retry that would be one request too many', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    wire.answerNext(lookupOf(203), BAD_GATEWAY)
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(4))

    // The fourth request is game 203's first attempt, and it fails. The retry it has earned
    // would be a fifth: it is not sent, and the game waits for another run.
    expect(wire.requests.map((request) => request.path)).toEqual([
      'games',
      ...storesOf(201, 202, 203),
    ])
    expect(report).toMatchObject({
      requests: { pages: 1, lookups: 3, retries: 0, total: 4 },
      asked: 3,
      failed: 1,
      stopped: 'budget',
    })
    expect(await harness.writer.getAppIds([203])).toEqual(new Map())
    expect(await harness.writer.getStoreRefs([203])).toEqual(new Map())
  })

  it.each([
    ['a 5xx', BAD_GATEWAY],
    ['a timeout', 'timeout'],
  ] as [string, WireAnswer][])('counts the retry of a page after %s', async (_what, bad) => {
    const wire = rawgWith({ 76: run(201, 2) })
    wire.answerNext(pageOf(76), bad)

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(wire.requests.map((request) => request.path)).toEqual([
      'games',
      'games',
      ...storesOf(201, 202),
    ])
    expect(report.requests).toEqual({ pages: 1, lookups: 2, retries: 1, total: 4 })
  })

  it('counts the second ask for a page that came back without a list', async () => {
    const wire = rawgWith({ 76: run(201, 2) })
    wire.answerNext(pageOf(76), { status: 200, body: null })

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(wire.pageRequests()).toHaveLength(2)
    expect(report.requests).toEqual({ pages: 1, lookups: 2, retries: 1, total: 4 })
    expect(report).toMatchObject({ pagesRead: 1, asked: 2 })
  })

  it('spends the whole budget on pages when no game on them can be asked about', async () => {
    const unreleased = (first: number) => [listed(first, { released: null })]
    const wire = rawgWith({
      76: unreleased(201),
      77: unreleased(202),
      78: unreleased(203),
      79: unreleased(204),
    })

    const report = await resolveMoreGames(against(wire).deps, options(3))

    expect(wire.requests).toHaveLength(3)
    expect(pagesRead(wire)).toEqual([76, 77, 78])
    expect(report).toMatchObject({
      requests: { pages: 3, lookups: 0, retries: 0, total: 3 },
      asked: 0,
      readingEnded: 'budget',
      stopped: 'budget',
    })
  })

  it('does not send a page’s second ask past the budget, and says the budget ended the reading', async () => {
    const wire = rawgWith({ 76: run(201, 2), 77: run(203, 2) })
    wire.answerNext(pageOf(76), { status: 200, body: null })

    const report = await resolveMoreGames(against(wire).deps, options(1))

    expect(wire.requests).toHaveLength(1)
    expect(report).toMatchObject({ pagesRead: 0, readingEnded: 'budget', stopped: 'budget' })
    expect(report.failedPage).toBeNull()
  })

  it('leaves the rest of the budget unspent when nobody is left to ask', async () => {
    const wire = rawgWith({ 76: run(201, 3) })
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(8000))

    expect(wire.requests).toHaveLength(4)
    expect(report).toMatchObject({
      requests: { pages: 1, lookups: 3, retries: 0, total: 4 },
      readingEnded: 'list-end',
      stopped: 'done',
      unasked: 0,
      firstUnaskedPage: null,
    })
    expect(harness.meter.remaining()).toBe(7996)
  })

  it('holds the transport to the budget itself: a request past it is refused, whoever asks', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    const harness = against(wire)

    await resolveMoreGames(harness.deps, options(5))

    // The run is over and the limit is still in force on the transport it used.
    await expect(harness.deps.rawg('games/game-240/stores')).rejects.toThrow()
    await expect(harness.deps.rawg('games', { page: 99 })).rejects.toThrow()
    expect(wire.requests).toHaveLength(5)
  })

  it('follows no redirect while it is held to a budget', async () => {
    const wire = rawgWith({ 76: run(201, 2) })

    await resolveMoreGames(against(wire).deps, options(100))

    expect(wire.requests.map((request) => request.redirect)).toEqual(['manual', 'manual', 'manual'])
  })

  it('refuses to run on a transport nobody counts', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await expect(resolveMoreGames(harness.deps, options(10))).rejects.toThrow(
      /cannot run without the RAWG request meter/,
    )
    expect(harness.calls).toHaveLength(0)
  })

  it.each([
    ['no budget', { budget: undefined }, /needs a budget/],
    ['a budget of none', { budget: 0 }, /--budget must be a positive whole number/],
    ['a negative budget', { budget: -5 }, /--budget must be a positive whole number/],
    [
      'a budget that is no whole number',
      { budget: 10.5 },
      /--budget must be a positive whole number/,
    ],
    [
      'a budget that is no number',
      { budget: Number.NaN },
      /--budget must be a positive whole number/,
    ],
    [
      'a budget above the ceiling',
      { budget: 8001 },
      /above the most one run may be given \(8000\)/,
    ],
    ['a budget without end', { budget: Number.POSITIVE_INFINITY }, /--budget must be a positive/],
    ['a first page of none', { fromPage: 0 }, /--from-page must be a positive whole number/],
    ['a first page that is no whole number', { fromPage: 76.5 }, /--from-page must be/],
    ['no pages', { pages: 0 }, /--pages must be a positive whole number/],
  ] as [string, Partial<ResolveOptions>, RegExp][])(
    'refuses %s before it asks RAWG or the index anything',
    async (_what, wrong, message) => {
      const wire = rawgWith({ 76: run(201, 2) })
      const harness = against(wire)
      const getAppIds = vi.spyOn(harness.writer, 'getAppIds')

      expect(() => assertResolveOptions({ ...options(10), ...wrong })).toThrow(message)
      await expect(
        resolveMoreGames(harness.deps, { ...options(10), ...wrong } as ResolveOptions),
      ).rejects.toThrow(message)

      expect(wire.requests).toHaveLength(0)
      expect(getAppIds).not.toHaveBeenCalled()
      // And no limit was set by a run that never began.
      expect(harness.meter.limited()).toBe(false)
    },
  )

  it('takes the ceiling itself, and one request', () => {
    expect(() => assertResolveOptions(options(8000))).not.toThrow()
    expect(() => assertResolveOptions(options(1))).not.toThrow()
  })
})

describe('resolveMoreGames: reading the pages', () => {
  it.each([
    ['RAWG fails it and fails its retry', [BAD_GATEWAY, BAD_GATEWAY], 2],
    ['RAWG times out on it twice', ['timeout', 'timeout'], 2],
    ['RAWG refuses it', [{ status: 429 }], 1],
    [
      'RAWG answers twice without a list',
      [
        { status: 200, body: null },
        { status: 200, body: null },
      ],
      2,
    ],
  ] as [string, WireAnswer[], number][])(
    'ends the reading at a page when %s, and goes on with the games it has',
    async (_how, answers, sent) => {
      const wire = rawgWith({ 76: run(201, 2), 77: run(203, 2), 78: run(205, 2), 79: run(207, 2) })
      wire.answerNext(pageOf(78), ...answers)
      const harness = against(wire)

      const report = await resolveMoreGames(harness.deps, options(100))

      // Page 79 is not tried: the order has a hole in it at 78, and the run does not skip it.
      expect(pagesRead(wire)).toEqual([76, 77, ...Array.from({ length: sent }, () => 78)])
      expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204))
      expect(report).toMatchObject({
        pagesRead: 2,
        lastPage: 77,
        failedPage: 78,
        readingEnded: 'page-failed',
        asked: 4,
        failed: 0,
        stopped: 'done',
        requests: { pages: 3, lookups: 4, retries: sent - 1, total: 3 + sent - 1 + 4 },
      })
      expect(harness.logs).toContain('resolve: page 78 could not be read; the reading ends there')
      expect(await harness.writer.getAppIds([201, 204, 205])).toEqual(
        new Map([
          [201, '2010'],
          [204, '2040'],
        ]),
      )
    },
  )

  it('does not fail the run when the very first page cannot be read', async () => {
    const wire = rawgWith({ 76: run(201, 2) })
    wire.answerNext(pageOf(76), 'timeout', 'timeout')

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(report).toMatchObject({
      pagesRead: 0,
      lastPage: null,
      failedPage: 76,
      readingEnded: 'page-failed',
      asked: 0,
      stopped: 'done',
      requests: { pages: 1, lookups: 0, retries: 1, total: 2 },
    })
  })

  it('stops reading at the end of RAWG’s list, and at a page past it', async () => {
    const listEnds = rawgWith({ 76: run(201, 2), 77: run(203, 2) })
    const ended = await resolveMoreGames(against(listEnds).deps, options(100))
    expect(pagesRead(listEnds)).toEqual([76, 77])
    expect(ended).toMatchObject({ readingEnded: 'list-end', asked: 4, stopped: 'done' })

    // Asked to begin past the end: RAWG has no such page, which is one request and no failure
    // of the run.
    const past = rawgWith({ 76: run(201, 2) })
    const nothing = await resolveMoreGames(against(past).deps, options(100, { fromPage: 500 }))
    expect(past.requests).toHaveLength(1)
    expect(nothing).toMatchObject({ pagesRead: 0, failedPage: 500, asked: 0, stopped: 'done' })
  })

  it('reads no more pages than it was given', async () => {
    const wire = rawgWith({ 76: run(201, 2), 77: run(203, 2), 78: run(205, 2) })

    const report = await resolveMoreGames(against(wire).deps, options(100, { pages: 1 }))

    expect(pagesRead(wire)).toEqual([76])
    expect(report).toMatchObject({ pagesRead: 1, readingEnded: 'pages', asked: 2, stopped: 'done' })
  })

  it('consults the two mappings when the count calls for it, not once a page', async () => {
    const pages: Record<number, RawgGameListItem[]> = {}
    for (let page = 76; page < 116; page += 1) pages[page] = run(page * 100, 5)
    const wire = rawgWith(pages)
    const harness = against(wire)
    const getAppIds = vi.spyOn(harness.writer, 'getAppIds')
    const getStoreRefs = vi.spyOn(harness.writer, 'getStoreRefs')

    // Forty pages of five; 120 requests are 20 pages and their hundred games.
    const report = await resolveMoreGames(harness.deps, options(120))

    expect(report).toMatchObject({ pagesRead: 20, asked: 100, readingEnded: 'enough' })
    expect(wire.requests).toHaveLength(120)
    // Read once, when the games in hand could first have been enough, for all of them together.
    expect(getAppIds).toHaveBeenCalledTimes(1)
    expect(getStoreRefs).toHaveBeenCalledTimes(1)
    expect(getAppIds.mock.calls[0]![0]).toHaveLength(100)
  })
})

describe('resolveMoreGames: a second run', () => {
  it('asks only who is left, further down the order, and nobody twice', async () => {
    const wire = rawgWith({ 76: run(201, 5), 77: run(206, 5), 78: run(211, 5) })
    const index = createMemoryGameIndex()

    const first = await resolveMoreGames(against(wire, index).deps, options(7))
    expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204, 205))
    expect(first).toMatchObject({ asked: 5, skipped: { known: 0 }, stopped: 'budget' })

    const second = await resolveMoreGames(against(wire, index).deps, options(7))
    expect(asked(wire).slice(5)).toEqual(storesOf(206, 207, 208, 209, 210))
    expect(second).toMatchObject({ asked: 5, skipped: { known: 5 }, stopped: 'budget' })

    // A third, smaller one: the pages it re-reads cost it requests, and the one it has left for
    // a game goes to the first game nobody has asked about.
    const third = await resolveMoreGames(against(wire, index).deps, options(4))
    expect(asked(wire).slice(10)).toEqual(storesOf(211))
    expect(third).toMatchObject({
      pagesRead: 3,
      asked: 1,
      skipped: { known: 10 },
      requests: { pages: 3, lookups: 1, retries: 0, total: 4 },
    })

    expect(new Set(asked(wire)).size).toBe(asked(wire).length)
    expect(wire.requests).toHaveLength(7 + 7 + 4)
  })

  it('finds nobody to ask when every game on the pages is known', async () => {
    const wire = rawgWith({ 76: run(201, 3) })
    const index = createMemoryGameIndex()
    await resolveMoreGames(against(wire, index).deps, options(100))

    const again = await resolveMoreGames(against(wire, index).deps, options(100))

    expect(asked(wire)).toEqual(storesOf(201, 202, 203))
    expect(again).toMatchObject({
      asked: 0,
      skipped: { known: 3 },
      stopped: 'done',
      requests: { pages: 1, lookups: 0, retries: 0, total: 1 },
    })
  })
})

describe('resolveMoreGames: when it stops', () => {
  const failing = (wire: RawgWire, ids: number[], answer: WireAnswer = { status: 429 }) => {
    for (const id of ids) wire.answerNext(lookupOf(id), answer)
  }

  it('stops when RAWG is failing wholesale: past five failures and a twentieth of what it tried', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    failing(wire, [201, 202, 203, 204, 205, 206, 207, 208])
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    // The sixth failure of six is the one: the seventh game is not begun.
    expect(asked(wire)).toEqual(storesOf(201, 202, 203, 204, 205, 206))
    expect(report).toMatchObject({ asked: 6, failed: 6, unasked: 34, stopped: 'failures' })
    expect(wire.requests).toHaveLength(7)
    expect(resolveWarnings(report)).toEqual([
      'Resolve stopped early because RAWG was failing: 6 of 6 lookups failed and 34 games were left unasked; 7 of 100 requests were sent',
    ])
  })

  it('says the budget stopped it when the last request failed and its retry was refused', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    // Five failures early on, and then the very last request of the budget meets a 502.
    failing(wire, [201, 202, 203, 204, 205])
    wire.answerNext(lookupOf(210), BAD_GATEWAY)

    const report = await resolveMoreGames(against(wire).deps, options(11))

    // The page and ten lookups: the tenth's retry would be the twelfth request.
    expect(wire.requests).toHaveLength(11)
    expect(asked(wire).at(-1)).toBe('games/game-210/stores')
    expect(report).toMatchObject({ asked: 10, failed: 6, stopped: 'budget' })
    // Six failures of ten would be "RAWG is failing" by the sweep's rule; it was the budget.
    expect(resolveWarnings(report)).toEqual([])
  })

  it('shrugs off five failures, however early they come', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    failing(wire, [201, 202, 203, 204, 205])

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(report).toMatchObject({ asked: 40, failed: 5, stopped: 'done' })
    expect(resolveWarnings(report)).toEqual([])
  })

  it('shrugs off more than five when they are under a twentieth of what it tried', async () => {
    const wire = rawgWith({
      76: run(1001, 40),
      77: run(1041, 40),
      78: run(1081, 40),
      79: run(1121, 40),
    })
    // Six failures, the sixth at the 126th game: six of 126 is under five percent.
    failing(wire, [1121, 1122, 1123, 1124, 1125, 1126])

    const report = await resolveMoreGames(against(wire).deps, options(1000))

    expect(report).toMatchObject({ asked: 160, failed: 6, stopped: 'done' })
  })

  it('keeps what it had learned when RAWG’s failing ends it', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    failing(wire, [203, 204, 205, 206, 207, 208], BAD_GATEWAY)
    for (const id of [203, 204, 205, 206, 207, 208]) wire.answerNext(lookupOf(id), BAD_GATEWAY)
    const harness = against(wire)

    const report = await resolveMoreGames(harness.deps, options(100))

    expect(report).toMatchObject({ asked: 8, failed: 6, steam: 2, stopped: 'failures' })
    // Each failure was two requests: the retries are RAWG's quota too.
    expect(report.requests).toEqual({ pages: 1, lookups: 8, retries: 6, total: 15 })
    expect(await harness.writer.getAppIds([201, 202, 203])).toEqual(
      new Map([
        [201, '2010'],
        [202, '2020'],
      ]),
    )
  })

  it('stops after sixty minutes on the job’s clock, and keeps what it had learned', async () => {
    const wire = rawgWith({ 76: run(201, 40), 77: run(241, 40) })
    const harness = against(wire)
    // RAWG answers everything, and takes a minute over each answer.
    wire.onRequest = () => harness.clock.advance(MINUTE)

    const report = await resolveMoreGames(harness.deps, options(8000))

    // Two pages and fifty-eight games in sixty minutes; the fifty-ninth is not begun.
    expect(report).toMatchObject({
      pagesRead: 2,
      asked: 58,
      failed: 0,
      unasked: 22,
      stopped: 'time',
      requests: { pages: 2, lookups: 58, retries: 0, total: 60 },
    })
    expect(wire.requests).toHaveLength(60)
    expect((await harness.writer.getAppIds([201, 258, 259])).size).toBe(2)
    expect(resolveWarnings(report)).toEqual([])
  })

  it('stops reading as well when the sixty minutes end among the pages', async () => {
    const pages: Record<number, RawgGameListItem[]> = {}
    for (let page = 76; page < 176; page += 1) pages[page] = [listed(page, { released: null })]
    const wire = rawgWith(pages)
    const harness = against(wire)
    wire.onRequest = () => harness.clock.advance(MINUTE)

    const report = await resolveMoreGames(harness.deps, options(8000))

    expect(report).toMatchObject({ pagesRead: 60, readingEnded: 'time', asked: 0, stopped: 'time' })
  })

  it('is not stopped by a run that is merely long: time is the limit, not a count', async () => {
    const wire = rawgWith({ 76: run(201, 40), 77: run(241, 40) })
    const harness = against(wire)
    // Forty seconds an answer: eighty-two of them are under fifty-five minutes.
    wire.onRequest = () => harness.clock.advance(40_000)

    const report = await resolveMoreGames(harness.deps, options(8000))

    expect(report).toMatchObject({ asked: 80, stopped: 'done' })
  })

  it('warns when a page RAWG failed cut the reading short', async () => {
    const wire = rawgWith({ 76: run(201, 2), 77: run(203, 2) })
    wire.answerNext(pageOf(77), 'timeout', 'timeout')

    const report = await resolveMoreGames(against(wire).deps, options(100))

    expect(resolveWarnings(report)).toEqual([
      'Resolve read 1 of at most 250 pages: RAWG failed page 77, and the reading ended there; 5 of 100 requests were sent',
    ])
  })
})

describe('resolveMoreGames: the lock', () => {
  it('gives the lock a sign of life among the pages and with every batch', async () => {
    const pages: Record<number, RawgGameListItem[]> = {}
    for (let page = 76; page < 116; page += 1) pages[page] = [listed(page, { released: null })]
    pages[116] = run(201, 5)
    const wire = rawgWith(pages)
    const harness = against(wire)
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    const report = await resolveMoreGames(harness.deps, options(200, { batchSize: 2 }))

    expect(report).toMatchObject({ pagesRead: 41, asked: 5 })
    // After the twentieth and the fortieth page, after each batch of two, and when it stops.
    expect(renewLock).toHaveBeenCalledTimes(2 + 3)
  })
})

describe('runJob in resolve mode', () => {
  const RESOLVE = { mode: 'resolve', pages: 250, forceUnlock: false, budget: 100 } as const
  const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const
  const world = () =>
    rawgWith({
      76: [listed(201, { on: ['steam', 'gog'] }), listed(202), listed(203, { released: null })],
      77: [listed(204, { on: ['xbox'] }), listed(205, { on: ['epic'] })],
    })

  it('learns the store pages and publishes nothing: the version, its pointer and its metadata stand', async () => {
    const index = createMemoryGameIndex()
    await runJob(createJobHarness({ start: '2026-10-13T02:30:00.000Z', writer: index }).deps, FULL)
    const before = {
      version: await index.currentVersion(),
      meta: await index.meta(),
      previous: await index.previousMeta(),
      games: await index.allGames(),
      everything: await index.search({ pageSize: 40 }),
    }
    expect(before.version).toBe(1)

    const wire = world()
    const harness = against(wire, index)
    const writeVersion = vi.spyOn(index, 'writeVersion')
    const publish = vi.spyOn(index, 'publish')
    const report = await runJob(harness.deps, RESOLVE)

    expect(report).toMatchObject({ mode: 'resolve', outcome: null })
    expect(report.resolve).toMatchObject({
      asked: 3,
      steam: 2,
      gog: 1,
      microsoft: 1,
      stopped: 'done',
    })
    expect(writeVersion).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect({
      version: await index.currentVersion(),
      meta: await index.meta(),
      previous: await index.previousMeta(),
      games: await index.allGames(),
      everything: await index.search({ pageSize: 40 }),
    }).toEqual(before)
    // No draft is left behind either: the next run begins a version as if this one had not been.
    expect(index.retainedVersions()).toEqual([1])
    // What it does leave is the two mappings.
    expect(await index.getAppIds([201, 202, 204])).toEqual(
      new Map([
        [201, '2010'],
        [202, '2020'],
      ]),
    )
    expect([...(await index.getStoreRefs([201, 202, 203, 204, 205])).keys()]).toEqual([
      201, 202, 204,
    ])
  })

  it('writes nothing but the two mappings to the store the site reads', async () => {
    const redis = createFakeRedis()
    const reader = createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 })
    await runJob(
      createJobHarness({
        start: '2026-10-13T02:30:00.000Z',
        writer: createUpstashIndex(redis, { runId: 'the-full-run' }),
      }).deps,
      FULL,
    )
    const pointer = async () => {
      const batch = redis.pipeline()
      const current = batch.get('idx:current')
      await batch.exec()
      return current.value
    }
    const read = async () => ({
      pointer: await pointer(),
      meta: await reader.meta(),
      page: await reader.search({ pageSize: 40 }),
      slug: await reader.idBySlug('hollow-cradle'),
    })
    const before = { keys: redis.keys().sort(), site: await read(), sent: redis.requests.length }
    expect(before.site.pointer).toBe('1')

    const wire = world()
    const harness = against(wire, createUpstashIndex(redis, { runId: 'the-resolve-run' }))
    const report = await runJob(harness.deps, RESOLVE)
    // What the run sent the store, taken before the reader below adds its own requests.
    const sent = redis.requests.slice(before.sent)

    expect(report.resolve).toMatchObject({ asked: 3, stopped: 'done' })
    expect(await read()).toEqual(before.site)
    // Every key that was there is there; the only new ones are the mappings of the games asked
    // about. No lock, no draft and no version is left.
    const after = redis.keys().sort()
    expect(before.keys.filter((key) => !after.includes(key))).toEqual([])
    expect(after.filter((key) => !before.keys.includes(key))).toEqual([
      'appid:201',
      'appid:202',
      'storeref:201',
      'storeref:202',
      'storeref:204',
    ])
    // And nothing that writes a version was sent: no transaction, which is how a pointer moves,
    // and none of the commands a document, a facet, an order or the metadata is written with.
    expect(sent.some((request) => request.multi)).toBe(false)
    const commands = new Set(sent.flatMap((request) => request.commands))
    for (const command of ['zadd', 'hset', 'unlink']) expect(commands.has(command)).toBe(false)
    expect([...commands].sort()).toEqual(
      [
        'del',
        'expire',
        'get',
        'incr',
        'mget',
        'mset',
        'sadd',
        'set',
        'setNx',
        'smembers',
        'srem',
      ].sort(),
    )
    expect(report.writes).toMatchObject({ requests: sent.length })

    // A scheduled run after it publishes as it would have.
    const next = await runJob(
      createJobHarness({
        start: '2026-10-13T12:15:00.000Z',
        writer: createUpstashIndex(redis, { runId: 'the-prices-run' }),
      }).deps,
      { mode: 'prices', pages: 1, forceUnlock: false },
    )
    expect(next.outcome?.published).toBe(true)
  })

  it('holds the writer’s lock from before its first request until it is done', async () => {
    const index = createMemoryGameIndex()
    const rival = index.connect('a-scheduled-run')
    const wire = world()
    const harness = against(wire, index)
    const beginVersion = vi.spyOn(index, 'beginVersion')
    const renewLock = vi.spyOn(index, 'renewLock')
    const whileRunning: Promise<string>[] = []
    wire.onRequest = () => {
      whileRunning.push(
        rival.beginVersion().then(
          () => 'taken',
          () => 'refused',
        ),
      )
    }

    await runJob(harness.deps, RESOLVE)

    expect(beginVersion).toHaveBeenCalledTimes(1)
    expect(beginVersion.mock.calls[0]![0]).toBeUndefined()
    expect(wire.requests).toHaveLength(5)
    expect(await Promise.all(whileRunning)).toEqual(Array.from({ length: 5 }, () => 'refused'))
    expect(renewLock.mock.calls.length).toBeGreaterThanOrEqual(2)
    // Given back: another run begins at once.
    await expect(rival.beginVersion()).resolves.toBeGreaterThan(0)
  })

  it('takes over a dead run’s lock only when it was told to', async () => {
    const index = createMemoryGameIndex()
    const harness = against(world(), index)
    const beginVersion = vi.spyOn(index, 'beginVersion')

    await runJob(harness.deps, { ...RESOLVE, forceUnlock: true })

    expect(beginVersion.mock.calls[0]![0]).toEqual({ force: true })
  })

  it('is refused, with nothing asked, while another run holds the lock', async () => {
    const index = createMemoryGameIndex()
    await index.connect('a-scheduled-run').beginVersion()
    const wire = world()
    const harness = against(wire, index)

    await expect(runJob(harness.deps, RESOLVE)).rejects.toMatchObject({
      stage: 'starting the version',
      message: expect.stringContaining('Another index run (a-scheduled-run)'),
    })

    expect(wire.requests).toHaveLength(0)
    expect(harness.meter.issued()).toBe(0)
  })

  it.each([
    ['no budget', { budget: undefined }, /needs a budget/],
    ['a budget above the ceiling', { budget: 8001 }, /above the most one run may be given/],
    ['a budget that is no whole number', { budget: 99.5 }, /positive whole number/],
  ] as [string, { budget?: number }, RegExp][])(
    'does not start on %s: no lock is taken and nothing is asked',
    async (_what, wrong, message) => {
      const index = createMemoryGameIndex()
      const wire = world()
      const harness = against(wire, index)
      const beginVersion = vi.spyOn(index, 'beginVersion')

      await expect(runJob(harness.deps, { ...RESOLVE, ...wrong })).rejects.toThrow(message)

      expect(beginVersion).not.toHaveBeenCalled()
      expect(wire.requests).toHaveLength(0)
    },
  )

  it('does not start on a transport nobody counts, and takes no lock for it', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const beginVersion = vi.spyOn(harness.writer, 'beginVersion')

    await expect(runJob(harness.deps, RESOLVE)).rejects.toThrow(/request meter/)

    expect(beginVersion).not.toHaveBeenCalled()
    expect(harness.calls).toHaveLength(0)
  })

  it('reads from the first page of the run it was given, and page 76 when it was given none', async () => {
    const wire = rawgWith({ 76: run(201, 1), 77: run(202, 1), 90: run(203, 1) })

    await runJob(against(wire).deps, RESOLVE)
    expect(pagesRead(wire)).toEqual([76, 77])

    const later = rawgWith({ 76: run(201, 1), 90: run(203, 1) })
    await runJob(against(later).deps, { ...RESOLVE, fromPage: 90, pages: 1 })
    expect(pagesRead(later)).toEqual([90])
  })

  it('never fails for RAWG’s sake, and says in an annotation what RAWG cost it', async () => {
    const wire = rawgWith({ 76: run(201, 40) })
    for (let id = 201; id <= 240; id += 1) wire.answerNext(lookupOf(id), { status: 429 })
    const index = createMemoryGameIndex()
    const harness = against(wire, index)

    const report = await runJob(harness.deps, RESOLVE)

    expect(report.resolve).toMatchObject({ asked: 6, failed: 6, stopped: 'failures' })
    expect(harness.logs.filter((line) => line.startsWith('::warning::'))).toEqual([
      '::warning::Resolve stopped early because RAWG was failing: 6 of 6 lookups failed and 34 games were left unasked; 7 of 100 requests were sent',
    ])
    await expect(index.connect('the-next-run').beginVersion()).resolves.toBeGreaterThan(0)
  })

  it('writes no annotation for a run RAWG answered', async () => {
    const harness = against(world())

    await runJob(harness.deps, RESOLVE)

    expect(harness.logs.some((line) => line.startsWith('::warning::'))).toBe(false)
  })

  it('gives the lock back when the index fails it, and carries out what it had spent', async () => {
    const index = createMemoryGameIndex()
    const wire = rawgWith({ 76: run(201, 5) })
    const harness = against(wire, index)
    vi.spyOn(index, 'setStoreRefs').mockRejectedValue(new Error('the store is unreachable'))

    const failure = await runJob(harness.deps, { ...RESOLVE, budget: 6 }).then(
      () => null,
      (error: unknown) => error as Error & { stage?: string; report?: { resolve?: unknown } },
    )

    expect(failure).toMatchObject({ message: 'the store is unreachable', stage: 'resolve' })
    // Quota spent is spent, and the summary of the failure has to say how much.
    expect(failure?.report?.resolve).toMatchObject({
      asked: 5,
      requests: { pages: 1, lookups: 5, retries: 0, total: 6 },
      stopped: null,
    })
    await expect(index.connect('the-next-run').beginVersion()).resolves.toBeGreaterThan(0)
    expect(index.retainedVersions()).toEqual([])
  })
})

describe('the summary of a resolve run', () => {
  it('says what was read, who was left out and why, what was learned and what it cost', async () => {
    const wire = rawgWith({
      76: [
        listed(201, { on: ['steam', 'gog'] }),
        listed(202),
        listed(203, { released: null }),
        listed(204, { on: ['epic'] }),
      ],
      77: [listed(205, { on: ['xbox'] }), listed(206), listed(207), listed(208)],
      78: run(301, 3),
    })
    wire.answerNext(lookupOf(202), BAD_GATEWAY)
    wire.answerNext(lookupOf(205), { status: 404 })
    const harness = against(wire)
    await harness.writer.setAppIds([[206, '']])

    const report = await runJob(harness.deps, {
      mode: 'resolve',
      pages: 250,
      forceUnlock: false,
      budget: 7,
    })
    const summary = formatSummary({ ...report, dryRun: true })

    for (const row of [
      '| Mode | resolve (dry run) |',
      '| Result | nothing published; the store pages of 3 games were learned |',
      '| Pages read | 2 of at most 250: pages 76 to 77; the reading ended because the games already waiting needed every request that was left |',
      '| Games seen | 8 |',
      '| Skipped | 1 not released, 1 on none of the four stores, 1 already known |',
      '| Asked | 4, 1 failed |',
      '| With a Steam page | 3 |',
      '| With a GOG page | 1 |',
      '| With a Microsoft Store product | 0 |',
      '| RAWG requests | 7 of a budget of 7: 2 pages, 4 lookups, 1 retry; counted as they left for RAWG, so nothing sent is missing |',
      '| Left unasked | 1 of the games waiting on the pages read, the first of them on page 77 |',
      '| Stopped | because the budget was spent |',
      '| Index traffic | not counted |',
    ]) {
      expect(summary).toContain(row)
    }
    // Its own table: nothing of a publication is in it, and no way out of a lock it gave back.
    expect(summary).not.toMatch(/Games \||Priced|Prices stamped|Item failures|force_unlock/)
    expect(summary.startsWith('## Index refresh\n')).toBe(true)
  })

  it.each([
    ['every page was read', { readingEnded: 'pages' }, 'every page it was given was read'],
    ['the list ended', { readingEnded: 'list-end' }, "RAWG's list ended there"],
    ['a page failed', { readingEnded: 'page-failed', failedPage: 131 }, 'RAWG failed page 131'],
    ['the budget ended it', { readingEnded: 'budget' }, 'no request was left to read another with'],
    ['time ended it', { readingEnded: 'time' }, 'the sixty minutes ran out'],
  ] as const)('says why the reading ended when %s', async (_what, fields, sentence) => {
    const report = await runJob(against(rawgWith({ 76: run(201, 2) })).deps, {
      mode: 'resolve',
      pages: 250,
      forceUnlock: false,
      budget: 10,
    })

    const summary = formatSummary({ ...report, resolve: { ...report.resolve!, ...fields } })

    expect(summary).toContain(`; the reading ended because ${sentence} |`)
  })

  it.each([
    ['done', 'because nobody was left to ask on the pages read'],
    ['budget', 'because the budget was spent'],
    ['time', 'because the run had used its sixty minutes'],
    ['failures', 'because RAWG was failing: 6 of 9 lookups failed, so the rest were not begun'],
  ] as const)('says why it stopped: %s', async (stopped, sentence) => {
    const report = await runJob(against(rawgWith({ 76: run(201, 2) })).deps, {
      mode: 'resolve',
      pages: 250,
      forceUnlock: false,
      budget: 10,
    })

    const summary = formatSummary({
      ...report,
      resolve: { ...report.resolve!, stopped, asked: 9, failed: 6 },
    })

    expect(summary).toContain(`| Stopped | ${sentence} |`)
  })

  it('says of a run that read no page that it read none', async () => {
    const wire = rawgWith({ 76: run(201, 2) })
    wire.answerNext(pageOf(76), { status: 429 })

    const report = await runJob(against(wire).deps, {
      mode: 'resolve',
      pages: 3,
      forceUnlock: false,
      budget: 10,
    })

    expect(formatSummary(report)).toContain(
      '| Pages read | none of at most 3 from page 76; the reading ended because RAWG failed page 76 |',
    )
  })

  it.each([
    [
      'the first game left unasked',
      { 76: run(201, 40), 77: run(241, 40) },
      [] as number[],
      { budget: 10 },
      'begin at page 76 (from_page=76)',
    ],
    [
      'the page RAWG failed',
      { 76: run(201, 2), 77: run(203, 2), 78: run(205, 2) },
      [77],
      { budget: 100 },
      'begin at page 77 (from_page=77)',
    ],
    [
      'the page after the last one read, when the page cap was reached',
      { 76: run(201, 2), 77: run(203, 2), 78: run(205, 2) },
      [],
      { budget: 100, pages: 2 },
      'begin at page 78 (from_page=78)',
    ],
    [
      'the page after the last one read, when the budget ran out exactly',
      { 76: run(201, 2), 77: run(203, 2), 78: run(205, 2) },
      [],
      { budget: 6 },
      'begin at page 78 (from_page=78)',
    ],
    [
      'nothing, when RAWG’s list ended',
      { 76: run(201, 2), 77: run(203, 2) },
      [],
      { budget: 100 },
      "nothing further to read: RAWG's list ended at page 77",
    ],
  ] as [
    string,
    Record<number, RawgGameListItem[]>,
    number[],
    { budget: number; pages?: number },
    string,
  ][])('names where a follow-up run begins: %s', async (_what, pages, failedPages, given, row) => {
    const wire = rawgWith(pages)
    for (const page of failedPages) wire.answerNext(pageOf(page), 'timeout', 'timeout')

    const report = await runJob(against(wire).deps, {
      mode: 'resolve',
      pages: given.pages ?? 250,
      forceUnlock: false,
      budget: given.budget,
    })

    expect(formatSummary(report)).toContain(`| Next run | ${row} |`)
  })

  it('reports a failure with its stage, what it had spent, and the way out of a held lock', () => {
    const summary = formatSummary({
      mode: 'resolve',
      dryRun: false,
      outcome: null,
      studios: null,
      pricesFetched: 0,
      languagesFetched: 0,
      failures: 0,
      durationMs: 65_000,
      writes: { requests: 12, commands: 40, bytes: 4096 },
      failedStage: 'resolve',
      error: 'the store is unreachable',
      resolve: {
        budget: 6000,
        fromPage: 76,
        pages: 250,
        pagesRead: 30,
        lastPage: 105,
        failedPage: null,
        readingEnded: null,
        seen: 1200,
        skipped: { notReleased: 100, noStore: 300, known: 0 },
        asked: 0,
        steam: 0,
        gog: 0,
        microsoft: 0,
        failed: 0,
        requests: { pages: 30, lookups: 0, retries: 1, total: 31 },
        unreadable: 0,
        unasked: 0,
        firstUnaskedPage: null,
        stopped: null,
        nextPage: 106,
      },
    })

    expect(summary).toContain('| Result | failed in resolve |')
    expect(summary).toContain('| Error | the store is unreachable |')
    expect(summary).toContain('| Pages read | 30 of at most 250: pages 76 to 105 |')
    expect(summary).toContain(
      '| RAWG requests | 31 of a budget of 6000: 30 pages, 0 lookups, 1 retry;',
    )
    expect(summary).toContain('| Stopped | by the failure above, not by itself |')
    expect(summary).toContain('| Next run | begin at page 106 (from_page=106) |')
    expect(summary).toContain('| Index traffic | 12 requests, 40 commands, 4 KiB |')
    expect(summary).toContain('| Duration | 1m 5s |')
    expect(summary).toContain('re-run the workflow')
  })
})

describe('parseArgs for a resolve run', () => {
  it('takes the budget, the first page and the page count from the command line', () => {
    expect(parseArgs(['--mode=resolve', '--budget=6000', '--from-page=120', '--pages=40'])).toEqual(
      { mode: 'resolve', pages: 40, forceUnlock: false, budget: 6000, fromPage: 120 },
    )
  })

  it('takes them from the workflow’s inputs, and the defaults for the two that may be blank', () => {
    expect(
      parseArgs(['--mode=resolve'], {
        INDEX_BUDGET: '6000',
        INDEX_FROM_PAGE: '',
        INDEX_PAGES: '',
      }),
    ).toEqual({ mode: 'resolve', pages: 250, forceUnlock: false, budget: 6000, fromPage: 76 })
    expect(
      parseArgs(['--mode=resolve'], {
        INDEX_BUDGET: ' 500 ',
        INDEX_FROM_PAGE: '300',
        INDEX_PAGES: '25',
        INDEX_FORCE_UNLOCK: 'true',
      }),
    ).toEqual({ mode: 'resolve', pages: 25, forceUnlock: true, budget: 500, fromPage: 300 })
    // The command line over the environment, whichever order the flags come in.
    expect(parseArgs(['--budget=7', '--mode=resolve'], { INDEX_BUDGET: '6000' })).toMatchObject({
      mode: 'resolve',
      budget: 7,
    })
  })

  it('takes the ceiling itself', () => {
    expect(parseArgs(['--mode=resolve', '--budget=8000']).budget).toBe(8000)
    expect(parseArgs(['--mode=resolve', '--budget=1']).budget).toBe(1)
  })

  it.each([
    ['no budget at all', [], {}, /--mode=resolve needs a budget/],
    ['a blank budget', [], { INDEX_BUDGET: '   ' }, /needs a budget/],
    ['an empty flag', ['--budget='], {}, /needs a budget/],
    [
      'a budget above the ceiling',
      ['--budget=8001'],
      {},
      /--budget=8001 is above the most one run may be given \(8000\)/,
    ],
    ['a budget far above it', [], { INDEX_BUDGET: '20000' }, /above the most/],
    ['a budget of none', ['--budget=0'], {}, /--budget must be a positive whole number, got 0/],
    ['a negative budget', ['--budget=-1'], {}, /--budget must be a positive whole number/],
    ['a fraction', ['--budget=10.5'], {}, /--budget must be a positive whole number/],
    [
      'a number in another notation',
      ['--budget=8e3'],
      {},
      /--budget must be a positive whole number/,
    ],
    ['a number in hexadecimal', ['--budget=0x10'], {}, /--budget must be a positive whole number/],
    ['a number with a space in it', [], { INDEX_BUDGET: '6 000' }, /--budget must be a positive/],
    ['words', [], { INDEX_BUDGET: 'all of it' }, /--budget must be a positive whole number/],
    ['a number too long to be a budget', ['--budget=99999999999999999999'], {}, /--budget must be/],
    [
      'a first page of none',
      ['--budget=10', '--from-page=0'],
      {},
      /--from-page must be a positive whole number/,
    ],
    [
      'a first page that is no number',
      ['--budget=10', '--from-page=last'],
      {},
      /--from-page must be/,
    ],
    [
      'a first page that is a fraction',
      ['--budget=10'],
      { INDEX_FROM_PAGE: '76.5' },
      /--from-page must be/,
    ],
    ['no pages', ['--budget=10', '--pages=0'], {}, /--pages must be a positive whole number/],
  ] as [string, string[], Record<string, string>, RegExp][])(
    'refuses %s',
    (_what, flags, env, message) => {
      expect(() => parseArgs(['--mode=resolve', ...flags], env)).toThrow(message)
    },
  )

  it('says which mode it refused, so that the summary of the refusal can', () => {
    let refused: unknown
    try {
      parseArgs(['--mode=resolve'])
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ mode: 'resolve' })
  })

  it('quotes what was typed on one line', () => {
    expect(() => parseArgs(['--mode=resolve'], { INDEX_BUDGET: '1\n::error::x' })).toThrow(
      '--budget must be a positive whole number, got 1 ::error::x.',
    )
  })

  describe('fails closed when another mode is given resolve’s numbers', () => {
    const modes = ['full', 'prices', 'languages'] as const

    it.each(modes)(
      'refuses --mode=%s given a budget, from the form or the command line',
      (mode) => {
        const refused =
          /--budget belong to --mode=resolve; a --mode=\w+ run given it does not start/
        expect(() => parseArgs([`--mode=${mode}`], { INDEX_BUDGET: '6000' })).toThrow(refused)
        expect(() => parseArgs([`--mode=${mode}`, '--budget=6000'])).toThrow(refused)
        // Whatever the budget holds: it is its presence that is refused.
        expect(() => parseArgs([`--mode=${mode}`], { INDEX_BUDGET: 'nonsense' })).toThrow(refused)
      },
    )

    it.each(modes)(
      'refuses --mode=%s given a first page, from the form or the command line',
      (mode) => {
        const refused = /--from-page belong to --mode=resolve; a --mode=\w+ run given it/
        expect(() => parseArgs([`--mode=${mode}`], { INDEX_FROM_PAGE: '76' })).toThrow(refused)
        expect(() => parseArgs([`--mode=${mode}`, '--from-page=76'])).toThrow(refused)
        expect(() => parseArgs([`--mode=${mode}`], { INDEX_FROM_PAGE: '-4' })).toThrow(refused)
      },
    )

    it.each(modes)(
      'refuses --mode=%s given both, and names a page count above 75 with them',
      (mode) => {
        expect(() =>
          parseArgs([`--mode=${mode}`], {
            INDEX_BUDGET: '6000',
            INDEX_FROM_PAGE: '76',
            INDEX_PAGES: '250',
          }),
        ).toThrow(
          `--budget and --from-page belong to --mode=resolve; a --mode=${mode} run given them does ` +
            'not start, and --pages=250 is more than the 75 the index is made of.',
        )
        expect(() =>
          parseArgs([`--mode=${mode}`, '--pages=250'], { INDEX_BUDGET: '6000' }),
        ).toThrow(/--pages=250 is more than the 75/)
      },
    )

    it('says which mode it refused, for the summary', () => {
      let refused: unknown
      try {
        parseArgs(['--mode=full'], { INDEX_BUDGET: '6000' })
      } catch (error) {
        refused = error
      }
      expect(refused).toMatchObject({ mode: 'full' })
    })

    it('runs the other modes as before when the two are blank, as on every schedule', () => {
      const blank = { INDEX_BUDGET: '', INDEX_FROM_PAGE: ' ', INDEX_PAGES: '' }
      expect(parseArgs([], blank)).toEqual({ mode: 'full', pages: 75, forceUnlock: false })
      expect(parseArgs(['--mode=prices'], blank)).toEqual({
        mode: 'prices',
        pages: 75,
        forceUnlock: false,
      })
      expect(parseArgs(['--mode=languages'], blank)).toEqual({
        mode: 'languages',
        pages: 75,
        forceUnlock: false,
      })
      // A page count alone is a full run's own business, as it always was.
      expect(parseArgs(['--mode=full'], { INDEX_PAGES: '2' }).pages).toBe(2)
    })
  })
})

describe('runCli in resolve mode', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }
  const lastLogged = () => vi.mocked(console.log).mock.calls.at(-1)?.[0] as string

  it('runs on the recorded fixtures with no network, exits zero and publishes nothing', async () => {
    quiet()
    const network = vi.fn(async () => new Response('null'))
    vi.stubGlobal('fetch', network)

    const code = await runCli(['--mode=resolve', '--budget=10'], {
      INDEX_DRY_RUN: '1',
      RAWG_FIXTURES: '1',
    })

    expect(code).toBe(0)
    expect(network).not.toHaveBeenCalled()
    const summary = lastLogged()
    // The recorded list is four games on one page: three are out and on a store the job reads,
    // and the fourth is to be announced.
    for (const row of [
      '| Mode | resolve (dry run) |',
      '| Result | nothing published; the store pages of 3 games were learned |',
      "| Pages read | 1 of at most 250: page 76; the reading ended because RAWG's list ended there |",
      '| Games seen | 4 |',
      '| Skipped | 1 not released, 0 on none of the four stores, 0 already known |',
      '| Asked | 3, 0 failed |',
      '| With a Steam page | 3 |',
      '| With a GOG page | 1 |',
      '| With a Microsoft Store product | 1 |',
      '| RAWG requests | 4 of a budget of 10: 1 page, 3 lookups, 0 retries; counted as they left for RAWG, so nothing sent is missing |',
      '| Left unasked | 0 of the games waiting on the pages read |',
      '| Stopped | because nobody was left to ask on the pages read |',
    ]) {
      expect(summary).toContain(row)
    }
  })

  it('keeps a fixture run to its budget too', async () => {
    quiet()

    const code = await runCli(['--mode=resolve'], {
      INDEX_DRY_RUN: '1',
      RAWG_FIXTURES: '1',
      INDEX_BUDGET: '3',
    })

    expect(code).toBe(0)
    expect(lastLogged()).toContain(
      '| RAWG requests | 3 of a budget of 3: 1 page, 2 lookups, 0 retries;',
    )
    expect(lastLogged()).toContain('| Stopped | because the budget was spent |')
  })

  it.each([
    ['without a budget', ['--mode=resolve'], /--mode=resolve needs a budget/],
    [
      'with a budget above the ceiling',
      ['--mode=resolve', '--budget=8001'],
      /above the most one run may be given/,
    ],
  ] as [string, string[], RegExp][])(
    'refuses to start %s, exits non-zero and says so under its own mode',
    async (_what, argv, message) => {
      quiet()

      const code = await runCli(argv, { INDEX_DRY_RUN: '1', RAWG_FIXTURES: '1' })

      expect(code).toBe(1)
      expect(vi.mocked(console.error).mock.calls[0]?.[0]).toMatch(message)
      const summary = lastLogged()
      expect(summary).toContain('| Mode | resolve |')
      expect(summary).toContain('| Result | failed in start-up |')
      expect(summary).toMatch(message)
      expect(summary).not.toContain('| RAWG requests |')
    },
  )

  it('refuses a full run handed a budget before anything is asked of anybody', async () => {
    quiet()
    const network = vi.fn(async () => new Response('null'))
    vi.stubGlobal('fetch', network)

    const code = await runCli(['--mode=full'], {
      INDEX_DRY_RUN: '1',
      INDEX_BUDGET: '6000',
      INDEX_FROM_PAGE: '76',
      INDEX_PAGES: '250',
      // No fixtures: a run that started would go to the network, which is stubbed to count it.
      RAWG_API_KEY: 'test-key',
    })

    expect(code).toBe(1)
    expect(network).not.toHaveBeenCalled()
    const summary = lastLogged()
    expect(summary).toContain('| Mode | full |')
    expect(summary).toContain('| Result | failed in start-up |')
    expect(summary).toContain('belong to --mode=resolve')
  })

  it('prints no request the index refused: the error is cut to what the store said and the commands', async () => {
    quiet()
    const body = [
      [
        'MSET',
        'storeref:101',
        JSON.stringify({ links: [[3, 'https://store.example/p#\n##[stop-commands]x']] }),
      ],
      ['MSET', 'appid:101', '1010'],
    ]
    vi.spyOn(MemoryGameIndex.prototype, 'setStoreRefs').mockRejectedValue(
      new Error(`ERR max request size exceeded, command was: ${JSON.stringify(body)}`),
    )

    const code = await runCli(['--mode=resolve', '--budget=10'], {
      INDEX_DRY_RUN: '1',
      RAWG_FIXTURES: '1',
    })

    expect(code).toBe(1)
    const printed = [vi.mocked(console.error).mock.calls.flat().join('\n'), lastLogged()].join('\n')
    expect(printed).toContain('ERR max request size exceeded (request of MSET)')
    expect(printed).not.toMatch(/storeref|store\.example|https?:|##\[|command was/)
    expect(lastLogged()).toContain('| Error | ERR max request size exceeded (request of MSET) |')
  })

  it('keeps what was typed into the form inside one cell of the refusal', async () => {
    quiet()

    const code = await runCli(['--mode=resolve'], {
      INDEX_DRY_RUN: '1',
      RAWG_FIXTURES: '1',
      INDEX_BUDGET: '6000 | all\nof it',
    })

    expect(code).toBe(1)
    expect(lastLogged()).toContain(
      '| Error | --budget must be a positive whole number, got 6000 / all of it. |',
    )
  })
})

describe('errorLine', () => {
  it('cuts an Upstash error at the request it quotes, keeping the names of its commands', () => {
    const body = JSON.stringify([
      ['MGET', 'storeref:1', 'storeref:2'],
      ['MSET', 'storeref:1', '{"links":[[3,"https://x.example/"]]}'],
      ['EXPIRE', 'idx:lock', 1800],
    ])

    expect(errorLine(new Error(`ERR something, command was: ${body}`))).toBe(
      'ERR something (request of MGET, MSET, EXPIRE)',
    )
    // One command rather than a pipeline of them.
    expect(errorLine(new Error('NOPERM, command was: ["SET","job:cursor:probe","1"]'))).toBe(
      'NOPERM (request of SET)',
    )
  })

  it('names no command when the quote is not one it can read, and quotes nothing of it', () => {
    for (const quote of [
      '{"links":["https://x.example/"]}',
      'not json at all',
      '[]',
      '[["https://x"]]',
    ]) {
      const line = errorLine(new Error(`ERR broken, command was: ${quote}`))
      expect(line).toBe('ERR broken (request not quoted)')
    }
  })

  it('makes what the store said one line', () => {
    expect(errorLine(new Error('ERR a\nb, command was: [["DEL","k"]]'))).toBe(
      'ERR a b (request of DEL)',
    )
  })

  it('leaves every other message as it was', () => {
    const held =
      'Another index run (run-1) is refreshing the index. It has held the write lock for 3 minute(s) and was last heard from 1 minute(s) ago. If that run is dead, re-run the workflow with the force_unlock input to take the lock over.'
    expect(errorLine(new Error(held))).toBe(held)
    expect(errorLine('plain text')).toBe('plain text')
  })
})
