import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toIndexedGame } from '../../../scripts/index/candidates'
import type { JobIndex } from '../../../scripts/index/deps'
import {
  EXPORT_COLUMNS,
  EXPORT_DEFAULT_PAGES,
  EXPORT_MAX_BUDGET,
  exportGames,
  type ExportReport,
  exportTotals,
  toCsv,
  type ExportRow,
} from '../../../scripts/index/export'
import { createRequestMeter } from '../../../scripts/index/requestMeter'
import { formatSummary, parseArgs, runCli, runJob } from '../../../scripts/index/run'
import type {
  IndexedGame,
  IndexedOffer,
  IndexedStoreRefs,
  IndexMeta,
} from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import type { RawgGameListItem } from '../../../server/rawg/types'
import { createFakeRedis } from '../index/fakeRedis'
import {
  createRawgWire,
  createWireHarness,
  type RawgWire,
  type WireAnswer,
  type WireRequest,
} from './harness'

/**
 * `--mode=export`: every game the job knows, with its store links and prices, in a CSV file, for
 * the price of RAWG's list pages inside a budget and with nothing written to the index.
 */

const RUN_AT = '2026-10-15T09:00:00.000Z'
const RATE = 41.5
const BOM = String.fromCharCode(0xfeff)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** One game of RAWG's most-added list. */
function listed(id: number): RawgGameListItem {
  return {
    id,
    slug: `game-${id}`,
    name: `Game ${id}`,
    released: '2020-05-05',
    tba: false,
    added: 1_000_000 - id,
    stores: [{ store: { id: 1 } }],
  }
}

function document(id: number, extra: Partial<IndexedGame> = {}): IndexedGame {
  return { ...toIndexedGame(listed(id))!, ...extra }
}

function offer(store: IndexedOffer['store'], fields: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    store,
    amount: 99_900,
    regularAmount: 99_900,
    currency: store === 'gog' ? 'USD' : 'UAH',
    discountPercent: 0,
    url: `https://${store}.example/product`,
    updatedAt: RUN_AT,
    ...fields,
  }
}

/** An index with these documents published, and these entries in the two mappings. */
async function indexWith(
  documents: IndexedGame[],
  mappings: { appIds?: [number, string][]; refs?: [number, IndexedStoreRefs][] } = {},
): Promise<JobIndex> {
  const index = createMemoryGameIndex()
  if (documents.length > 0) {
    const version = await index.beginVersion()
    await index.writeVersion(version, documents)
    const meta: IndexMeta = {
      version,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: documents.length,
      exchangeRate: { currency: 'USD', uah: RATE, date: '2026-10-15', readAt: RUN_AT },
    }
    await index.publish(version, meta)
  }
  await index.setAppIds(mappings.appIds ?? [])
  await index.setStoreRefs(mappings.refs ?? [])
  return index
}

/** A clock for a stage that is never meant to pause. */
const NO_PAUSE = { sleep: async () => {} }

/** RAWG's list as a stand-in that spends one request of the meter a page, and has one page. */
function onePage(games: RawgGameListItem[]) {
  const meter = createRequestMeter()
  const rawg = async () => {
    meter.take()
    return { count: games.length, next: null, previous: null, results: games }
  }
  return { meter, rawg }
}

async function exportOf(
  index: JobIndex,
  page: RawgGameListItem[],
): Promise<Map<number, ExportRow>> {
  const { meter, rawg } = onePage(page)
  const { rows } = await exportGames(
    { rawg, rawgRequests: meter, index, log: () => {}, clock: NO_PAUSE },
    { budget: 5, pages: 1 },
  )
  return new Map(rows.map((row) => [Number(row.rawg_id), row]))
}

describe('which games an export holds', () => {
  it('every published game, and every game on the pages a resolve run learned, in that order', async () => {
    const index = await indexWith([document(1), document(2)], {
      appIds: [
        [11, '110'],
        [1, '10'],
      ],
      refs: [[12, { gog: 'game_12' }]],
    })
    // On the page: a published game, a game with an app id only, one with a record only, one
    // that nothing is known about, and a published game twice.
    const page = [listed(1), listed(11), listed(12), listed(13), listed(1)]

    const rows = [...(await exportOf(index, page)).values()]

    expect(rows.map((row) => [row.rawg_id, row.on_site])).toEqual([
      ['1', 'yes'],
      ['2', 'yes'],
      ['11', 'no'],
      ['12', 'no'],
    ])
    expect(rows[2]).toMatchObject({ name: 'Game 11', slug: 'game-11', released: '2020-05-05' })
  })

  it('needs no page to list the published games', async () => {
    const index = await indexWith([document(1)])
    const rows = await exportOf(index, [])
    expect([...rows.keys()]).toEqual([1])
  })
})

describe('the columns of each store', () => {
  it('fills a store from its offer, its reference, or leaves it empty', async () => {
    const index = await indexWith(
      [
        document(1, {
          steamAppId: '10',
          priceUah: 499,
          offers: [
            offer('gog', { amount: 999, url: 'https://www.gog.com/en/game/game_1' }),
            offer('xbox-store', { via: 'relation', amount: 129_900 }),
            offer('playstation-store', { via: 'name', amount: 249_900 }),
          ],
        }),
        document(2, { steamAppId: '20', priceUah: 0, free: true }),
        document(3),
      ],
      {
        refs: [
          [1, { gog: 'game_1' }],
          [
            2,
            {
              gog: 'game_2',
              microsoft: { id: '9NABCDEFGHIJ', name: 'game-2' },
              playstation: { titleId: 'CUSA00002_00' },
              links: [
                [1, 'https://store.steampowered.com/app/20/'],
                [
                  3,
                  'https://store.playstation.com/en-us/product/UP0001-CUSA00002_00-GAME2GAME2GAME200',
                ],
              ],
            },
          ],
          [
            3,
            {
              gog: null,
              fallbacks: {
                gog: { slug: 'game_three', via: 'name', foundAt: RUN_AT },
                microsoft: {
                  searchedAt: RUN_AT,
                  found: { id: '9NZZZZZZZZZZ', name: 'game-3', via: 'name', foundAt: RUN_AT },
                },
              },
              // Not the PlayStation Store's host: not a link of it.
              links: [[3, 'https://example.com/product/x']],
            },
          ],
        ],
      },
    )

    const rows = await exportOf(index, [])

    expect(rows.get(1)).toEqual({
      rawg_id: '1',
      name: 'Game 1',
      slug: 'game-1',
      released: '2020-05-05',
      on_site: 'yes',
      steam_url: 'https://store.steampowered.com/app/10/',
      steam_price_uah: '499',
      gog_url: 'https://www.gog.com/en/game/game_1',
      gog_price_usd: '9.99',
      gog_price_uah_approx: String(Math.round(9.99 * RATE)),
      gog_via: 'link',
      xbox_url: 'https://xbox-store.example/product',
      xbox_price_uah: '1299.00',
      xbox_via: 'relation',
      playstation_url: 'https://playstation-store.example/product',
      playstation_price_uah: '2499.00',
      playstation_via: 'name',
    })
    // References and no price: the links, and every price and way empty. A free game is 0.
    expect(rows.get(2)).toMatchObject({
      steam_url: 'https://store.steampowered.com/app/20/',
      steam_price_uah: '0',
      gog_url: 'https://www.gog.com/en/game/game_2',
      gog_price_usd: '',
      gog_price_uah_approx: '',
      gog_via: '',
      xbox_url: 'https://www.microsoft.com/uk-ua/p/game-2/9nabcdefghij',
      xbox_price_uah: '',
      playstation_url:
        'https://store.playstation.com/en-us/product/UP0001-CUSA00002_00-GAME2GAME2GAME200',
      playstation_price_uah: '',
      playstation_via: '',
    })
    // What the store's own ways found is a reference too; no app id and no PlayStation link.
    expect(rows.get(3)).toMatchObject({
      steam_url: '',
      steam_price_uah: '',
      gog_url: 'https://www.gog.com/en/game/game_three',
      xbox_url: 'https://www.microsoft.com/uk-ua/p/game-3/9nzzzzzzzzzz',
      playstation_url: '',
    })
  })

  it('gives a game a resolve run learned its links and no price', async () => {
    const index = await indexWith([], {
      appIds: [
        [11, '110'],
        [12, ''],
      ],
      refs: [
        [11, { gog: 'game_11', links: [[3, 'https://store.playstation.com/en-us/product/X']] }],
        [12, { gog: null, microsoft: null }],
      ],
    })

    const rows = await exportOf(index, [listed(11), listed(12)])

    expect(rows.get(11)).toMatchObject({
      on_site: 'no',
      steam_url: 'https://store.steampowered.com/app/110/',
      steam_price_uah: '',
      gog_url: 'https://www.gog.com/en/game/game_11',
      gog_price_usd: '',
      playstation_url: 'https://store.playstation.com/en-us/product/X',
    })
    // "No Steam page" and stores with no reference: a row of empty store cells.
    const empty = rows.get(12)!
    for (const column of EXPORT_COLUMNS.slice(5)) expect(empty[column], column).toBe('')
  })
})

describe('the totals of the summary', () => {
  it('counts links and prices per store, on the site and not on it', async () => {
    const index = await indexWith(
      [
        document(1, {
          steamAppId: '10',
          priceUah: 100,
          offers: [offer('playstation-store')],
        }),
        document(2, { steamAppId: '20' }),
      ],
      {
        appIds: [[11, '110']],
        refs: [
          [11, { links: [[3, 'https://store.playstation.com/en-us/product/X']] }],
          [12, { links: [[3, 'https://store.playstation.com/en-us/product/Y']] }],
        ],
      },
    )
    const { meter, rawg } = onePage([listed(11), listed(12)])

    const { rows, report } = await exportGames(
      { rawg, rawgRequests: meter, index, log: () => {}, clock: NO_PAUSE },
      { budget: 5, pages: 1 },
    )

    expect(exportTotals(rows)).toEqual(report.stores)
    expect(report.games).toEqual({ onSite: 2, notOnSite: 2 })
    expect(report.stores.onSite).toEqual({
      steam: { links: 2, prices: 1 },
      gog: { links: 0, prices: 0 },
      xbox: { links: 0, prices: 0 },
      playstation: { links: 1, prices: 1 },
    })
    expect(report.stores.notOnSite).toEqual({
      steam: { links: 1, prices: 0 },
      gog: { links: 0, prices: 0 },
      xbox: { links: 0, prices: 0 },
      playstation: { links: 2, prices: 0 },
    })

    const summary = formatSummary({
      mode: 'export',
      dryRun: false,
      outcome: null,
      studios: null,
      pricesFetched: 0,
      languagesFetched: 0,
      failures: 0,
      durationMs: 0,
      writes: null,
      export: report,
    })
    expect(summary).toContain('| Result | nothing published; 4 games written to games.csv |')
    expect(summary).toContain('| Pages skipped | none |')
    expect(summary).toContain('| Games | 2 on the site, 2 learned by resolve and not on it |')
    expect(summary).toContain('| Steam | 2 | 1 | 1 | 0 |')
    expect(summary).toContain('| PlayStation Store | 1 | 1 | 2 | 0 |')
    // Counts only: no name, slug or link of a game.
    expect(summary).not.toMatch(/Game 1|game-1|https?:/)
  })
})

describe('the RAWG budget of an export', () => {
  const pages = { 1: [listed(11)], 2: [listed(12)], 3: [listed(13)], 4: [listed(14)] }
  const pageOf = (page: number) => (request: WireRequest) =>
    request.path === 'games' && request.params.page === String(page)
  const BAD_GATEWAY: WireAnswer = { status: 502 }

  async function run(budget: number, pageCount: number, wire = createRawgWire(pages)) {
    const ids = [...wire.pages.values()].flat().flatMap((game) => game.id ?? [])
    const writer = await indexWith([], {
      appIds: ids.map((id): [number, string] => [id, `${id}0`]),
    })
    const harness = createWireHarness({ start: RUN_AT, wire, writer })
    vi.stubGlobal('fetch', wire.fetch)
    /** The export's own pauses, apart from the transport's. */
    const pauses: number[] = []
    const result = await exportGames(
      {
        rawg: harness.deps.rawg,
        rawgRequests: harness.meter,
        index: writer,
        log: (line) => void harness.logs.push(line),
        clock: {
          sleep: async (ms) => {
            pauses.push(ms)
            await harness.clock.sleep(ms)
          },
        },
      },
      { budget, pages: pageCount },
    )
    const asked = wire.pageRequests().map((request) => Number(request.params.page))
    return { ...result, wire, logs: harness.logs, pauses, asked }
  }

  /** A list of `count` pages, one game a page: page N holds game 10 + N. */
  function listOf(count: number): RawgWire {
    return createRawgWire(
      Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, [listed(11 + i)]])),
    )
  }

  /** Every try of a page fails: the transport's request and its retry, four times over. */
  const EVERY_TRY: WireAnswer[] = Array.from({ length: 8 }, () => BAD_GATEWAY)

  it('reads every page it was given when the budget is exactly enough', async () => {
    const { report, wire, rows } = await run(3, 3)

    expect(wire.requests).toHaveLength(3)
    expect(report).toMatchObject({ pagesRead: 3, readingEnded: 'pages', requests: 3 })
    expect(rows.map((row) => row.rawg_id)).toEqual(['11', '12', '13'])
  })

  it('stops reading a request short, and says so', async () => {
    const { report, wire, rows, logs } = await run(2, 3)

    expect(wire.requests.map((request) => request.params.page)).toEqual(['1', '2'])
    expect(report).toMatchObject({ pagesRead: 2, readingEnded: 'budget', requests: 2 })
    expect(rows.map((row) => row.rawg_id)).toEqual(['11', '12'])
    expect(logs).toContain(
      '::warning::Export: the budget of 2 RAWG requests was spent after 2 of 3 pages; games ' +
        'learned by resolve further down are not in the file',
    )
  })

  it('counts the transport’s retry of a page against the budget', async () => {
    const wire = createRawgWire(pages)
    wire.answerNext(pageOf(1), BAD_GATEWAY)

    const { report } = await run(3, 4, wire)

    expect(wire.requests.map((request) => request.params.page)).toEqual(['1', '1', '2'])
    expect(report).toMatchObject({ pagesRead: 2, readingEnded: 'budget', requests: 3 })
  })

  it('never sends the retry the budget has no request for', async () => {
    const wire = createRawgWire(pages)
    wire.answerNext(pageOf(1), BAD_GATEWAY)

    const { report, rows } = await run(1, 4, wire)

    expect(wire.requests).toHaveLength(1)
    expect(report).toMatchObject({ pagesRead: 0, readingEnded: 'budget', requests: 1 })
    expect(rows).toEqual([])
  })

  it('ends the reading at the end of RAWG’s list', async () => {
    const { report } = await run(10, 8)
    expect(report).toMatchObject({ pagesRead: 4, readingEnded: 'list-end', requests: 4 })
  })

  it('asks again for a page RAWG failed, after 5 and then 15 seconds, and reads it', async () => {
    const wire = createRawgWire(pages)
    // Two tries of page 2 fail, the transport's retry with each; the third is answered.
    wire.answerNext(pageOf(2), BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY)

    const { report, rows, pauses, asked } = await run(20, 3, wire)

    expect(asked).toEqual([1, 2, 2, 2, 2, 2, 3])
    expect(pauses).toEqual([5_000, 15_000])
    expect(report).toMatchObject({
      pagesRead: 3,
      skippedPages: [],
      readingEnded: 'pages',
      requests: 7,
    })
    expect(rows.map((row) => row.rawg_id)).toEqual(['11', '12', '13'])
  })

  it('skips a page RAWG fails on every try and reads on', async () => {
    const wire = createRawgWire(pages)
    wire.answerNext(pageOf(2), ...EVERY_TRY)

    const { report, rows, pauses, asked, logs } = await run(20, 4, wire)

    expect(asked).toEqual([1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4])
    expect(pauses).toEqual([5_000, 15_000, 30_000])
    expect(report).toMatchObject({
      pagesRead: 3,
      skippedPages: [2],
      readingEnded: 'pages',
      requests: 11,
    })
    expect(rows.map((row) => row.rawg_id)).toEqual(['11', '13', '14'])
    expect(logs).toContain(
      '::warning::Export: RAWG failed page 2 on every try, so it was skipped; up to 40 games ' +
        'learned by resolve on it may be missing from the file',
    )
  })

  it('ends the reading after five pages failed in a row, and only then', async () => {
    const wire = listOf(14)
    // Four in a row, a page read, then five in a row.
    for (const page of [2, 3, 4, 5, 7, 8, 9, 10, 11]) wire.answerNext(pageOf(page), ...EVERY_TRY)

    const { report, rows, asked, logs } = await run(400, 14, wire)

    expect(report).toMatchObject({
      pagesRead: 2,
      skippedPages: [2, 3, 4, 5, 7, 8, 9, 10, 11],
      readingEnded: 'rawg-down',
      requests: 2 + 9 * 8,
    })
    expect(asked).not.toContain(12)
    expect(rows.map((row) => row.rawg_id)).toEqual(['11', '16'])
    expect(logs).toContain(
      '::warning::Export: RAWG failed 5 pages in a row, up to page 11, so RAWG is down and the ' +
        'reading ended there; games learned by resolve further down are not in the file',
    )
  })

  it.each([
    // Two tries of two requests, a pause, and the third try's request: the retry is refused.
    [5, [5_000, 15_000]],
    // Two tries spend it all: no pause for a try that cannot be sent.
    [4, [5_000]],
  ] as [number, number[]][])(
    'counts every try against a budget of %i and stops at its edge',
    async (budget, expectedPauses) => {
      const wire = createRawgWire(pages)
      wire.answerNext(pageOf(1), ...EVERY_TRY)

      const { report, rows, pauses } = await run(budget, 4, wire)

      expect(wire.requests).toHaveLength(budget)
      expect(pauses).toEqual(expectedPauses)
      expect(report).toMatchObject({
        pagesRead: 0,
        skippedPages: [],
        readingEnded: 'budget',
        requests: budget,
      })
      expect(rows).toEqual([])
    },
  )
})

describe('the summary of an export that skipped pages', () => {
  const base: ExportReport = {
    budget: 300,
    pages: 221,
    pagesRead: 219,
    skippedPages: [112, 140],
    readingEnded: 'pages',
    requests: 237,
    games: { onSite: 3, notOnSite: 1 },
    stores: exportTotals([]),
  }
  const summaryOf = (exported: ExportReport) =>
    formatSummary({
      mode: 'export',
      dryRun: false,
      outcome: null,
      studios: null,
      pricesFetched: 0,
      languagesFetched: 0,
      failures: 0,
      durationMs: 0,
      writes: null,
      export: exported,
    })

  it('names the skipped pages and the games they may have hidden', () => {
    const summary = summaryOf(base)
    expect(summary).toContain(
      '| Result | nothing published; 4 games written to games.csv; the 2 skipped pages may ' +
        'have hidden up to 80 games |',
    )
    expect(summary).toContain('| Pages skipped | 112, 140 |')
    expect(summary).toContain('| Pages read | 219 of at most 221 from page 1;')
    expect(summary).toContain('| RAWG requests | 237 of a budget of 300,')
  })

  it('says when RAWG went down', () => {
    const summary = summaryOf({
      ...base,
      pagesRead: 111,
      skippedPages: [112, 113, 114, 115, 116],
      readingEnded: 'rawg-down',
    })
    expect(summary).toContain('| Pages skipped | 112, 113, 114, 115, 116 |')
    expect(summary).toContain(
      'the reading ended because RAWG failed 5 pages in a row up to page 116, so it is down;',
    )
    expect(summary).toContain('the 5 skipped pages may have hidden up to 200 games |')
  })
})

describe('the export mode on the command line', () => {
  it('takes a budget up to its ceiling and reads 221 pages by default', () => {
    expect(EXPORT_MAX_BUDGET).toBe(400)
    expect(EXPORT_DEFAULT_PAGES).toBe(221)
    expect(parseArgs(['--mode=export'], { INDEX_BUDGET: '400' })).toEqual({
      mode: 'export',
      pages: 221,
      forceUnlock: false,
      budget: 400,
      exportDir: 'games-export',
    })
    expect(
      parseArgs(['--mode=export', '--budget=5', '--pages=3'], { INDEX_EXPORT_DIR: '/tmp/x' }),
    ).toMatchObject({ pages: 3, budget: 5, exportDir: '/tmp/x' })
  })

  it.each([
    ['without a budget', {}, /--mode=export needs a budget/],
    ['with a budget above 400', { INDEX_BUDGET: '401' }, /above the most an export may be given/],
    ['with a budget that is not a number', { INDEX_BUDGET: '4e2' }, /positive whole number/],
    ['with a first page', { INDEX_BUDGET: '10', INDEX_FROM_PAGE: '76' }, /--from-page belongs/],
  ] as [string, Record<string, string>, RegExp][])('refuses to start %s', (_what, env, message) => {
    expect(() => parseArgs(['--mode=export'], env)).toThrow(message)
  })

  it('refuses before anything is asked, exits non-zero and says so under its own mode', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const network = vi.fn(async () => new Response('null'))
    vi.stubGlobal('fetch', network)

    const code = await runCli(['--mode=export', '--budget=401'], {
      INDEX_DRY_RUN: '1',
      RAWG_API_KEY: 'test-key',
    })

    expect(code).toBe(1)
    expect(network).not.toHaveBeenCalled()
    const summary = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string
    expect(summary).toContain('| Mode | export |')
    expect(summary).toContain('| Result | failed in start-up |')
  })

  it('moves to the spare key when RAWG refuses the main one, and says which key in the summary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = vi.fn(async (url: string) => {
      const main = new URL(url).searchParams.get('key') === 'main-secret-key'
      const body = { count: 0, next: null, results: [] }
      return new Response(JSON.stringify(body), { status: main ? 401 : 200 })
    })
    vi.stubGlobal('fetch', network)
    const dir = await mkdtemp(join(tmpdir(), 'export-'))
    try {
      const code = await runCli(['--mode=export', '--budget=5', '--pages=1'], {
        INDEX_DRY_RUN: '1',
        RAWG_API_KEY: 'main-secret-key',
        RAWG_API_KEY_SPARE: 'spare-secret-key',
        INDEX_EXPORT_DIR: dir,
      })

      expect(code).toBe(0)
      expect(network).toHaveBeenCalledTimes(2)
      const said = vi.mocked(console.log).mock.calls.map(([line]) => String(line))
      expect(said).toContain('[upstream] RAWG main key refused (401), switched to the spare key')
      const summary = said.at(-1)!
      expect(summary).toContain('| RAWG key | main, then spare after a 401 |')
      // The request sent again with the spare key is a request of the budget.
      expect(summary).toContain('| RAWG requests | 2 of a budget of 5, retries included;')
      for (const line of said) {
        expect(line).not.toContain('main-secret-key')
        expect(line).not.toContain('spare-secret-key')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes the file on the recorded fixtures with no network, and exits zero', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = vi.fn(async () => new Response('null'))
    vi.stubGlobal('fetch', network)
    const dir = await mkdtemp(join(tmpdir(), 'export-'))
    try {
      const code = await runCli(['--mode=export', '--budget=2', '--pages=1'], {
        INDEX_DRY_RUN: '1',
        RAWG_FIXTURES: '1',
        INDEX_EXPORT_DIR: dir,
      })

      expect(code).toBe(0)
      expect(network).not.toHaveBeenCalled()
      const csv = await readFile(join(dir, 'games.csv'), 'utf8')
      expect(csv).toBe(`${BOM}${EXPORT_COLUMNS.join(',')}\r\n`)
      const summary = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string
      expect(summary).toContain('| Mode | export (dry run) |')
      expect(summary).toContain('| RAWG requests | 1 of a budget of 2, retries included;')
      expect(summary).toContain('| RAWG key | main |')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('an export publishes nothing', () => {
  it('writes nothing to the index and takes no lock', async () => {
    const writer = await indexWith([document(1)], { appIds: [[11, '110']] })
    const versionBefore = await writer.currentVersion()
    const writes = (
      [
        'beginVersion',
        'writeVersion',
        'publish',
        'discardVersion',
        'renewLock',
        'setAppIds',
        'setStoreRefs',
        'setLanguages',
        'setCursor',
        'clearCursor',
      ] as const
    ).map((method) => vi.spyOn(writer, method))
    const wire = createRawgWire({ 1: [listed(11)] })
    const harness = createWireHarness({ start: RUN_AT, wire, writer })
    vi.stubGlobal('fetch', wire.fetch)
    const dir = await mkdtemp(join(tmpdir(), 'export-'))
    try {
      const report = await runJob(harness.deps, {
        mode: 'export',
        pages: 1,
        forceUnlock: false,
        budget: 5,
        exportDir: dir,
      })

      expect(report.outcome).toBeNull()
      expect(report.export).toMatchObject({ games: { onSite: 1, notOnSite: 1 } })
      for (const write of writes) expect(write).not.toHaveBeenCalled()
      expect(await writer.currentVersion()).toBe(versionBefore)
      // Only RAWG's list was asked: no game's store links.
      expect(wire.lookupRequests()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('an export on the index token the workflow gives it', () => {
  /** What Redis may be sent by an export: reads, by the names the fake records them under. */
  const READS = [
    'get',
    'mget',
    'smembers',
    'sunion',
    'zrangeAll',
    'zrangebyscore',
    'hget',
    'hgetall',
  ]

  it('sends Redis read commands only, though its token could write, and runs on a token that cannot', async () => {
    const redis = createFakeRedis()
    // Published by a run that holds the lock, as the nightly run does.
    const seeding = createUpstashIndex(redis, { runId: 'the-full-run' })
    const version = await seeding.beginVersion()
    await seeding.writeVersion(version, [document(1)])
    await seeding.publish(version, {
      version,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: 1,
    })
    await seeding.setAppIds([[11, '110']])
    const before = redis.requests.length
    const keys = redis.keys().sort()

    for (const commands of [redis, redis.readOnly()]) {
      const writer = createUpstashIndex(commands, { runId: 'the-export' })
      const wire = createRawgWire({ 1: [listed(11)] })
      const harness = createWireHarness({ start: RUN_AT, wire, writer })
      vi.stubGlobal('fetch', wire.fetch)
      const dir = await mkdtemp(join(tmpdir(), 'export-'))
      try {
        const report = await runJob(harness.deps, {
          mode: 'export',
          pages: 1,
          forceUnlock: false,
          budget: 5,
          exportDir: dir,
        })
        expect(report.export).toMatchObject({ games: { onSite: 1, notOnSite: 1 } })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    const sent = redis.requests.slice(before).flatMap((request) => request.commands)
    expect(sent.length).toBeGreaterThan(0)
    for (const command of sent) expect(READS, command).toContain(command)
    // No key was added, removed or locked.
    expect(redis.keys().sort()).toEqual(keys)
  })
})

describe('toCsv', () => {
  it('quotes what needs quoting and keeps a name from being read as a formula', () => {
    const row = Object.fromEntries(EXPORT_COLUMNS.map((column) => [column, ''])) as ExportRow
    const csv = toCsv([
      { ...row, rawg_id: '1', name: 'Hello, "World"' },
      { ...row, rawg_id: '2', name: '=HYPERLINK("x")' },
      { ...row, rawg_id: '3', name: 'Тіні\nзабутих предків' },
    ])
    const lines = csv.slice(1).split('\r\n')

    expect(csv.startsWith(BOM)).toBe(true)
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','))
    expect(lines[1]).toMatch(/^1,"Hello, ""World""",/)
    expect(lines[2]).toMatch(/^2,"'=HYPERLINK\(""x""\)",/)
    expect(csv).toContain('3,"Тіні\nзабутих предків",')
  })
})
