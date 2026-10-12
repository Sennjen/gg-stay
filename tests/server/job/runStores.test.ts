import { describe, expect, it, vi } from 'vitest'
import {
  formatSummary,
  runJob,
  storeWarnings,
  type JobReport,
  type StoresReport,
} from '../../../scripts/index/run'
import type {
  IndexMeta,
  IndexedExchangeRate,
  IndexedGame,
  IndexedOffer,
} from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { JOB_APP_IDS, JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import {
  JOB_BANK_RATE,
  JOB_MICROSOFT_ID,
  gogPrice,
  gogProduct,
} from '../../fixtures/index/jobStores'
import { createFakeRedis } from '../index/fakeRedis'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The whole job with the stores other than Steam in it. Game 101 of the job catalog has a GOG
 * page and game 109 a Microsoft Store product (`tests/fixtures/index/jobStores.ts`); the rules
 * here are about which run reads them, what it publishes, and what a run does when it cannot.
 */

const RUN_AT = '2026-09-20T03:00:00.000Z'
const HOUR = 3_600_000
const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const
const PRICES = { mode: 'prices', pages: 1, forceUnlock: false } as const
const LANGUAGES = { mode: 'languages', pages: 1, forceUnlock: false } as const

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const gogOffer = (updatedAt: string): IndexedOffer => ({
  store: 'gog',
  title: 'Hollow Cradle',
  amount: 999,
  regularAmount: 1999,
  currency: 'USD',
  discountPercent: 50,
  url: 'https://www.gog.com/en/game/hollow_cradle',
  updatedAt,
})

const microsoftOffer = (updatedAt: string): IndexedOffer => ({
  store: 'xbox-store',
  // What the store calls the product; the game is "Lost Canton".
  title: 'Lost Canton: Definitive Edition',
  amount: 38_500,
  regularAmount: 38_500,
  currency: 'UAH',
  discountPercent: 0,
  url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9nlostcant0n',
  updatedAt,
})

const rate = (date: string, readAt: string): IndexedExchangeRate => ({
  currency: 'USD',
  uah: JOB_BANK_RATE,
  date,
  readAt,
})

/** A first full run, published; what every later run of a case starts from. */
async function firstNight(): Promise<JobHarness> {
  const harness = createJobHarness({ start: RUN_AT })
  await runJob(harness.deps, FULL)
  return harness
}

const nextRun = (previous: JobHarness, start: string) =>
  createJobHarness({ writer: previous.writer, start })

describe('runJob and the other stores', () => {
  it('publishes what GOG and the Microsoft Store charge, and the rate, with a full run', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(await harness.writer.getOne(101)).toMatchObject({
      // Steam's price is where it always was; the offer stands beside it.
      priceUah: 675,
      steamAppId: '411000',
      offers: [gogOffer(RUN_AT)],
    })
    expect(await harness.writer.getOne(109)).toMatchObject({
      priceUah: null,
      offers: [microsoftOffer(RUN_AT)],
    })
    expect('offers' in (await harness.writer.getOne(102))!).toBe(false)

    const meta = await harness.writer.meta()
    expect(meta?.exchangeRate).toEqual(rate('2026-09-20', RUN_AT))
    expect(meta?.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    expect(meta?.stats).toMatchObject({ gogOfferCount: 1, microsoftOfferCount: 1 })

    expect(report.stores).toMatchObject({
      // RAWG lists two of the nine on GOG or the Xbox store. One was asked about with its app
      // id; the sweep asked about the other, and about nobody else.
      references: {
        games: 9,
        listed: 2,
        asked: 2,
        gog: 1,
        microsoft: 1,
        sweep: { attempted: 1, failures: 0, remaining: 0, stopped: null },
      },
      gog: { status: 'read', references: 1, pricesRead: 1, failed: 0 },
      microsoft: { status: 'read', references: 1, pricesRead: 1, failed: 0 },
      rate: { status: 'read' },
    })
    // Seven lookups for the app ids, which brought 101's GOG page with them, and one of the
    // sweep's, for 109: the game on no store at all cost RAWG nothing.
    expect(harness.storeCalls()).toHaveLength(8)
    expect(harness.storeCalls().at(-1)?.path).toBe('games/lost-canton/stores')
    expect(harness.storeCalls().map((call) => call.path)).not.toContain(
      'games/paper-harbour/stores',
    )
  })

  it('reads the stores twice a day, with whichever run finds them due', async () => {
    const night = await firstNight()

    // Six hours on, the prices run: Steam is read, and the other stores are not.
    const morning = nextRun(night, later(RUN_AT, 6 * HOUR))
    const first = await runJob(morning.deps, PRICES)

    expect(morning.calls).toHaveLength(0)
    expect(morning.priceBatches).toHaveLength(1)
    expect(morning.gogPages).toHaveLength(0)
    expect(morning.microsoftBatches).toHaveLength(0)
    expect(first.stores).toMatchObject({
      references: { listed: 2, asked: 2, gog: 1, microsoft: 1, sweep: null },
      gog: { status: 'not-due', offers: 1 },
      microsoft: { status: 'not-due', offers: 1 },
    })
    // A new version, the same offers under the same dates, and the stamps where they were.
    expect((await morning.writer.getOne(101))?.offers).toEqual([gogOffer(RUN_AT)])
    expect((await morning.writer.getOne(109))?.offers).toEqual([microsoftOffer(RUN_AT)])
    expect((await morning.writer.meta())?.offersReadAt).toEqual({
      gog: RUN_AT,
      'xbox-store': RUN_AT,
    })
    // The bank is asked by every run.
    expect((await morning.writer.meta())?.exchangeRate).toEqual(
      rate('2026-09-20', later(RUN_AT, 6 * HOUR)),
    )

    // Twelve hours on, the next prices run reads them again.
    const noon = later(RUN_AT, 12 * HOUR)
    const midday = nextRun(night, noon)
    midday.gogCatalog.products = [gogProduct('hollow_cradle', gogPrice('19.99', '19.99'))]
    const second = await runJob(midday.deps, PRICES)

    expect(midday.calls).toHaveLength(0)
    expect(midday.gogPages).toEqual([1])
    expect(midday.microsoftBatches).toEqual([[JOB_MICROSOFT_ID]])
    expect(second.stores).toMatchObject({ gog: { status: 'read' }, microsoft: { status: 'read' } })
    expect((await midday.writer.getOne(101))?.offers).toEqual([
      { ...gogOffer(noon), amount: 1999, regularAmount: 1999, discountPercent: 0 },
    ])
    expect((await midday.writer.meta())?.offersReadAt).toEqual({ gog: noon, 'xbox-store': noon })
  })

  it('carries the offers through a full run that finds the stores read already', async () => {
    const night = await firstNight()
    const noon = later(RUN_AT, 12 * HOUR)
    await runJob(nextRun(night, noon).deps, PRICES)

    // The next night's full run, three hours after that read: every document is mapped afresh
    // from RAWG, and the offers are carried onto them like the Steam prices.
    const nextNight = nextRun(night, later(noon, 3 * HOUR))
    const report = await runJob(nextNight.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(nextNight.gogPages).toHaveLength(0)
    expect(nextNight.microsoftBatches).toHaveLength(0)
    expect(nextNight.storeCalls()).toHaveLength(0)
    expect((await nextNight.writer.getOne(101))?.offers).toEqual([gogOffer(noon)])
    expect((await nextNight.writer.getOne(109))?.offers).toEqual([microsoftOffer(noon)])
    expect((await nextNight.writer.meta())?.offersReadAt).toEqual({ gog: noon, 'xbox-store': noon })
    expect(report.stores?.references.sweep).toEqual({
      attempted: 0,
      failures: 0,
      remaining: 0,
      stopped: null,
    })
  })

  it('reads them in a languages run too, when that is the run that finds them due', async () => {
    const night = await firstNight()
    const at = later(RUN_AT, 25 * HOUR)
    const weekly = nextRun(night, at)

    const report = await runJob(weekly.deps, LANGUAGES)

    expect(report.outcome?.published).toBe(true)
    expect(weekly.calls).toHaveLength(0)
    expect(weekly.priceBatches).toHaveLength(0)
    expect(weekly.gogPages).toEqual([1])
    expect((await weekly.writer.getOne(101))?.offers).toEqual([gogOffer(at)])
    // The Steam prices' stamp is the price stage's alone: another store's read does not move it.
    expect((await weekly.writer.meta())?.pricesUpdatedAt).toBe(RUN_AT)
  })
})

/** A document without what this build added, as a run would see it whichever store is down. */
function steamSide(games: IndexedGame[]) {
  return games.map(({ offers: _offers, ...game }) => game).sort((left, right) => left.id - right.id)
}

function steamSideOfMeta(meta: IndexMeta | null) {
  if (!meta) return null
  const { exchangeRate: _rate, offersReadAt: _stamps, stats, ...rest } = meta
  const { gogOfferCount: _gog, microsoftOfferCount: _microsoft, ...steamStats } = stats ?? {}
  return { ...rest, stats: steamStats }
}

describe('runJob when a store is down', () => {
  const noon = later(RUN_AT, 12 * HOUR)

  it('does everything it would have done, and only the refresh is missing', async () => {
    // Two worlds from the same night; at noon one of them finds every other store down.
    const up = nextRun(await firstNight(), noon)
    const down = nextRun(await firstNight(), noon)
    down.failGogPage(1)
    down.failMicrosoftBatchWith(JOB_MICROSOFT_ID)
    down.bankState.down = true

    const withStores = await runJob(up.deps, PRICES)
    const without = await runJob(down.deps, PRICES)

    expect(without.outcome?.published).toBe(true)
    // The Steam side of the run is the same run: documents, counts, stamps, failures.
    expect(steamSide(await down.writer.allGames())).toEqual(steamSide(await up.writer.allGames()))
    expect(steamSideOfMeta(await down.writer.meta())).toEqual(
      steamSideOfMeta(await up.writer.meta()),
    )
    expect(without.pricesFetched).toBe(withStores.pricesFetched)
    expect(without.failures).toBe(0)
    expect(withStores.failures).toBe(0)
    expect(down.priceBatches).toEqual(up.priceBatches)

    // What is missing is the refresh: last night's offers, under last night's dates.
    expect((await up.writer.getOne(101))?.offers).toEqual([gogOffer(noon)])
    expect((await down.writer.getOne(101))?.offers).toEqual([gogOffer(RUN_AT)])
    expect((await down.writer.getOne(109))?.offers).toEqual([microsoftOffer(RUN_AT)])
    const meta = await down.writer.meta()
    expect(meta?.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    expect(meta?.exchangeRate).toEqual(rate('2026-09-20', RUN_AT))
    expect(meta?.stats).toMatchObject({ gogOfferCount: 1, microsoftOfferCount: 1 })
    expect(without.stores).toMatchObject({
      gog: { status: 'failed', failed: 1 },
      microsoft: { status: 'failed', failed: 1 },
      rate: { status: 'kept' },
    })
  })

  it('tries again with the very next run, six hours on, not twelve', async () => {
    const night = await firstNight()
    const failed = nextRun(night, noon)
    failed.failGogPage(1)
    await runJob(failed.deps, PRICES)

    const evening = later(noon, 6 * HOUR)
    const retry = nextRun(night, evening)
    await runJob(retry.deps, PRICES)

    // GOG's stamp never moved, so it is due; the Microsoft Store was read at noon, and is not.
    expect(retry.gogPages).toEqual([1])
    expect(retry.microsoftBatches).toHaveLength(0)
    expect((await retry.writer.getOne(101))?.offers).toEqual([gogOffer(evening)])
    expect((await retry.writer.meta())?.offersReadAt).toEqual({ gog: evening, 'xbox-store': noon })
  })

  it('publishes a full run whose sweep RAWG would not answer, and counts what failed', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    harness.failNext((call) => call.path === 'games/lost-canton/stores')

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(report.failures).toBe(1)
    expect(report.stores?.references).toMatchObject({
      listed: 2,
      asked: 1,
      microsoft: 0,
      sweep: { attempted: 1, failures: 1, remaining: 1 },
    })
    expect('offers' in (await harness.writer.getOne(109))!).toBe(false)

    // The next night asks about that one game again, and nothing else.
    const nextNight = nextRun(harness, later(RUN_AT, 24 * HOUR))
    await runJob(nextNight.deps, FULL)
    expect(nextNight.storeCalls().map((call) => call.path)).toEqual(['games/lost-canton/stores'])
    expect((await nextNight.writer.getOne(109))?.offers).toHaveLength(1)
  })

  it('carries what it knew of the stores out with a run that failed later', async () => {
    const night = await firstNight()
    const failing = nextRun(night, noon)
    // Steam prices nothing, so the prices run has nothing to publish and fails in its own stage.
    for (const appId of Object.values(JOB_APP_IDS)) failing.failPriceChunkWith(appId)

    const error = await runJob(failing.deps, PRICES).catch((caught: unknown) => caught)

    const report = (error as { report: JobReport }).report
    expect((error as { stage: string }).stage).toBe('prices')
    expect(report.stores).toEqual({
      references: { games: 9, listed: 2, asked: 2, gog: 1, microsoft: 1, sweep: null },
      gog: null,
      microsoft: null,
      rate: null,
    })
    // A run Steam has already failed asks no other store anything.
    expect(failing.gogPages).toHaveLength(0)
    expect(failing.bankDays).toHaveLength(0)
  })
})

/**
 * A store that is down does not turn a run red, by design — so a run has to say it some other
 * way, or the only trace is a row of a summary nobody has a reason to open. It writes a GitHub
 * `::warning::` annotation, as the similar-lists warning does.
 */
describe('runJob and its warnings about the other stores', () => {
  const noon = later(RUN_AT, 12 * HOUR)
  const warnings = (harness: JobHarness) =>
    harness.logs.filter((line) => /^::warning::(GOG|Microsoft Store|No exchange rate)/.test(line))

  it('writes none in a run that read everything, or had nothing due', async () => {
    const night = createJobHarness({ start: RUN_AT })
    await runJob(night.deps, FULL)
    expect(warnings(night)).toEqual([])

    // Not due is the design working, not a store failing.
    const morning = nextRun(night, later(RUN_AT, 6 * HOUR))
    await runJob(morning.deps, PRICES)
    expect(warnings(morning)).toEqual([])
  })

  it('writes one for a GOG walk that failed, with the reason', async () => {
    const down = nextRun(await firstNight(), noon)
    down.failGogPage(1)

    const report = await runJob(down.deps, PRICES)

    expect(report.outcome?.published).toBe(true)
    expect(warnings(down)).toEqual([
      '::warning::GOG prices not refreshed: GOG upstream failure (page 1) — every offer that was not read stands as it was',
    ])
  })

  it('writes one for a Microsoft read that failed', async () => {
    const down = nextRun(await firstNight(), noon)
    down.failMicrosoftBatchWith(JOB_MICROSOFT_ID)

    await runJob(down.deps, PRICES)

    expect(warnings(down)).toEqual([
      '::warning::Microsoft Store prices not refreshed: MICROSOFT upstream failure (batch) — every offer that was not read stands as it was',
    ])
  })

  it('writes one when the run ends with no rate, and none while an old one stands', async () => {
    // A first run with the bank down: nothing to keep.
    const first = createJobHarness({ start: RUN_AT })
    first.bankState.down = true
    const report = await runJob(first.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(warnings(first)).toEqual([
      '::warning::No exchange rate: the National Bank could not be read and no rate under seven days old is left, so no hryvnia estimate is published',
    ])

    // The bank down for a day, after a run that read it: yesterday's rate stands, and that is
    // what the seven days are for.
    const kept = nextRun(await firstNight(), later(RUN_AT, 6 * HOUR))
    kept.bankState.down = true
    await runJob(kept.deps, PRICES)
    expect(warnings(kept)).toEqual([])
  })

  it('writes all three when everything is down, and still publishes', async () => {
    const down = nextRun(await firstNight(), later(RUN_AT, 8 * 24 * HOUR))
    down.failGogPage(1)
    down.failMicrosoftBatchWith(JOB_MICROSOFT_ID)
    down.bankState.down = true

    const report = await runJob(down.deps, PRICES)

    expect(report.outcome?.published).toBe(true)
    expect(warnings(down).map((line) => line.split(':')[4])).toEqual([
      'GOG prices not refreshed',
      'Microsoft Store prices not refreshed',
      'No exchange rate',
    ])
  })

  const read = {
    status: 'read' as const,
    references: 999,
    pricesRead: 240,
    failed: 0,
    requests: 10,
    offers: 240,
    lastReadAt: RUN_AT,
  }
  const stores = (extra: Partial<StoresReport>): StoresReport => ({
    references: {
      games: 3_400,
      listed: 1_700,
      asked: 1_700,
      gog: 410,
      microsoft: 380,
      sweep: null,
    },
    gog: read,
    microsoft: read,
    rate: { status: 'read', rate: rate('2026-09-20', RUN_AT) },
    ...extra,
  })

  it('names a read in part as one, and a read the floor refused by what it saw', () => {
    expect(
      storeWarnings(
        stores({
          microsoft: {
            ...read,
            status: 'partial',
            failed: 100,
            error: 'MICROSOFT upstream failure: TIMEOUT',
          },
          gog: {
            ...read,
            status: 'failed',
            pricesRead: 0,
            failed: 1_093,
            error: 'carried 870, the read priced 12: under half of the offers the store had',
          },
        }),
      ),
    ).toEqual([
      'GOG prices not refreshed: carried 870, the read priced 12: under half of the offers the store had — every offer that was not read stands as it was',
      'Microsoft Store prices refreshed only in part: MICROSOFT upstream failure: TIMEOUT — every offer that was not read stands as it was',
    ])
  })

  it('has nothing to say of a store that was read, was not due, or has no references', () => {
    expect(storeWarnings(stores({}))).toEqual([])
    expect(
      storeWarnings(
        stores({
          gog: { ...read, status: 'not-due' },
          microsoft: { ...read, status: 'no-references' },
          rate: { status: 'kept', rate: rate('2026-09-19', RUN_AT) },
        }),
      ),
    ).toEqual([])
    // A run that never reached the stores has no verdict on them.
    expect(storeWarnings(stores({ gog: null, microsoft: null, rate: null }))).toEqual([])
  })

  it('writes every warning on one line, whatever a reason holds', () => {
    const [warning] = storeWarnings(
      stores({ gog: { ...read, status: 'failed', error: 'a\n::error::b\r\n\tc' } }),
    )

    expect(warning).toBe(
      'GOG prices not refreshed: a ::error::b c — every offer that was not read stands as it was',
    )
  })
})

describe('runJob over what the previous build published', () => {
  /**
   * A version as the build before this one left it: documents with no `offers`, metadata with no
   * rate and no stamps, the app ids resolved — and no game ever asked about its other stores.
   */
  async function publishedByThePreviousBuild(): Promise<JobHarness> {
    const built = await firstNight()
    const games = (await built.writer.allGames()).map(({ offers: _offers, ...game }) => game)
    const { exchangeRate: _rate, offersReadAt: _stamps, ...meta } = (await built.writer.meta())!
    delete meta.stats?.gogOfferCount
    delete meta.stats?.microsoftOfferCount

    const writer = createMemoryGameIndex()
    await writer.setAppIds(Object.entries(JOB_APP_IDS).map(([id, appId]) => [Number(id), appId]))
    const version = await writer.beginVersion()
    await writer.writeVersion(version, games)
    await writer.publish(version, { ...meta, version })
    return createJobHarness({ writer, start: RUN_AT })
  }

  it('refreshes prices over it without a store reference to its name', async () => {
    const old = await publishedByThePreviousBuild()
    const morning = nextRun(old, later(RUN_AT, 6 * HOUR))

    const report = await runJob(morning.deps, PRICES)

    expect(report.outcome?.published).toBe(true)
    expect(morning.calls).toHaveLength(0)
    expect(morning.gogPages).toHaveLength(0)
    expect(report.stores).toMatchObject({
      references: { games: 9, listed: 2, asked: 0, gog: 0, microsoft: 0, sweep: null },
      gog: { status: 'no-references' },
      microsoft: { status: 'no-references' },
      rate: { status: 'read' },
    })
    const meta = await morning.writer.meta()
    expect(meta?.exchangeRate).toEqual(rate('2026-09-20', later(RUN_AT, 6 * HOUR)))
    expect(meta?.offersReadAt).toBeUndefined()
    expect((await morning.writer.getOne(101))?.priceUah).toBe(675)
  })

  it('sweeps it on the next full run, and prices what the sweep found', async () => {
    const old = await publishedByThePreviousBuild()
    const at = later(RUN_AT, 24 * HOUR)
    const nextNight = nextRun(old, at)

    const report = await runJob(nextNight.deps, FULL)

    // Every app id was known, so the app id stage asks nothing. The sweep asks about the two
    // games RAWG lists on GOG or the Xbox store — not about the seven it lists on neither.
    expect(report.stores?.references).toEqual({
      games: 9,
      listed: 2,
      asked: 2,
      gog: 1,
      microsoft: 1,
      sweep: { attempted: 2, failures: 0, remaining: 0, stopped: null },
    })
    expect(nextNight.storeCalls().map((call) => call.path)).toEqual([
      'games/hollow-cradle/stores',
      'games/lost-canton/stores',
    ])
    expect((await nextNight.writer.getOne(101))?.offers).toEqual([gogOffer(at)])
    expect((await nextNight.writer.getOne(109))?.offers).toEqual([microsoftOffer(at)])
  })
})

describe('runJob and the other stores, through the Upstash adapter', () => {
  it('publishes offers, the rate and the stamps a read-only reader finds', async () => {
    const redis = createFakeRedis()
    const reader = createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 })
    const night = createJobHarness({
      start: RUN_AT,
      writer: createUpstashIndex(redis, { runId: 'the-full-run' }),
    })

    await runJob(night.deps, FULL)

    expect((await reader.getOne(101))?.offers).toEqual([gogOffer(RUN_AT)])
    expect((await reader.getOne(109))?.offers).toEqual([microsoftOffer(RUN_AT)])
    expect(await reader.meta()).toMatchObject({
      version: 1,
      exchangeRate: rate('2026-09-20', RUN_AT),
      offersReadAt: { gog: RUN_AT, 'xbox-store': RUN_AT },
    })
    // The mapping is outside the version, beside the app ids: one key for each game RAWG lists
    // on one of the two stores, and none for the seven it lists on neither.
    expect(
      redis
        .keys()
        .filter((key) => key.startsWith('storeref:'))
        .sort(),
    ).toEqual(['storeref:101', 'storeref:109'])
    // The sweep is done, and its cursor with it.
    expect(redis.keys()).not.toContain('job:cursor:storerefs')

    const morning = createJobHarness({
      start: later(RUN_AT, 6 * HOUR),
      writer: createUpstashIndex(redis, { runId: 'the-prices-run' }),
    })
    const prices = await runJob(morning.deps, PRICES)

    // The next version carries them on, and the mapping is read, never rewritten.
    expect(prices.outcome?.meta.version).toBe(2)
    expect((await reader.getOne(101))?.offers).toEqual([gogOffer(RUN_AT)])
    expect((await reader.meta())?.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
  })

  it('counts every command it adds in the traffic the run reports', async () => {
    const redis = createFakeRedis()
    const sent = () => redis.requests.flatMap((request) => request.commands)
    const night = createJobHarness({
      start: RUN_AT,
      writer: createUpstashIndex(redis, { runId: 'the-full-run' }),
    })

    const full = await runJob(night.deps, FULL)

    expect(full.writes).toMatchObject({ requests: redis.requests.length, commands: sent().length })
    const before = { requests: redis.requests.length, commands: sent().length }

    const morning = createJobHarness({
      start: later(RUN_AT, 6 * HOUR),
      writer: createUpstashIndex(redis, { runId: 'the-prices-run' }),
    })
    const prices = await runJob(morning.deps, PRICES)

    expect(prices.writes).toMatchObject({
      requests: redis.requests.length - before.requests,
      commands: sent().length - before.commands,
    })
  })
})

/**
 * A decision, pinned so that it stays one: a `storeref:` record that cannot be read is a game
 * with no reference, and a game with no reference keeps no offer — not even a good one it carried
 * — until a full run has asked RAWG about it again. The other way round the job would go on
 * publishing a price for a product it can no longer name.
 */
describe('runJob and a store reference record that cannot be read', () => {
  it('drops the game’s offers until the next full run, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const redis = createFakeRedis()
    const reader = createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 })
    const run = (runId: string, start: string) =>
      createJobHarness({ start, writer: createUpstashIndex(redis, { runId }) })
    await runJob(run('the-first-night', RUN_AT).deps, FULL)
    expect((await reader.getOne(101))?.offers).toEqual([gogOffer(RUN_AT)])

    // The record of game 101 is damaged where it lies.
    const damage = redis.pipeline()
    damage.mset({ 'storeref:101': '{"gog":"hollow_cradle",' })
    await damage.exec()

    const noon = later(RUN_AT, 12 * HOUR)
    const prices = run('the-prices-run', noon)
    const report = await runJob(prices.deps, PRICES)

    // Published, with the game's Steam price and without its GOG offer; nobody asked GOG, for no
    // game names a page there any more. The other game's offer is refreshed as on any day.
    expect(report.outcome?.published).toBe(true)
    expect(await reader.getOne(101)).toMatchObject({ priceUah: 675, steamAppId: '411000' })
    expect('offers' in (await reader.getOne(101))!).toBe(false)
    expect(report.stores).toMatchObject({
      references: { listed: 2, asked: 1, gog: 0, microsoft: 1 },
      gog: { status: 'no-references' },
      microsoft: { status: 'read' },
    })
    expect(prices.calls).toHaveLength(0)
    expect((await reader.getOne(109))?.offers).toEqual([microsoftOffer(noon)])
    expect(warn).toHaveBeenCalledWith(
      '[index] the store references of game 101 are unreadable: its GOG and Microsoft offers are dropped until a full run has asked RAWG about it again',
    )

    // The next full run asks RAWG about that game alone, rewrites the record, and the offer is
    // back with the read that follows.
    const nextNight = later(RUN_AT, 24 * HOUR)
    const full = run('the-next-night', nextNight)
    await runJob(full.deps, FULL)

    expect(full.storeCalls().map((call) => call.path)).toEqual(['games/hollow-cradle/stores'])
    expect((await reader.getOne(101))?.offers).toEqual([gogOffer(nextNight)])
    warn.mockRestore()
  })
})

describe('formatSummary and the other stores', () => {
  it('gains a line for the references, one for each store and one for the rate', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const summary = formatSummary(await runJob(harness.deps, FULL))

    expect(summary).toContain(
      '| Store references | 2 of 9 games on GOG or the Xbox store at RAWG, 2 asked; 1 with a GOG page, 1 with a Microsoft Store product; RAWG: 1 lookup this run, 0 failed, 0 left for the next full run |',
    )
    expect(summary).toContain(
      '| GOG prices | 1 reference, 1 price read, 0 failed; 1 offer published, 1 request |',
    )
    expect(summary).toContain(
      '| Microsoft Store prices | 1 reference, 1 price read, 0 failed; 1 offer published, 1 request |',
    )
    expect(summary).toContain(
      "| Exchange rate | 44.9567 UAH per USD, the National Bank's for 2026-09-20 |",
    )
  })

  it('says when a store was not due, and what the run did not look up', async () => {
    const night = await firstNight()

    const summary = formatSummary(
      await runJob(nextRun(night, later(RUN_AT, 6 * HOUR)).deps, PRICES),
    )

    expect(summary).toContain(
      '| Store references | 2 of 9 games on GOG or the Xbox store at RAWG, 2 asked; 1 with a GOG page, 1 with a Microsoft Store product (not looked up in this mode) |',
    )
    expect(summary).toContain(
      `| GOG prices | 1 reference, not read: the last full read (${RUN_AT}) is under eleven hours old; 1 offer carried |`,
    )
  })

  it('says what failed, how many references it cost, and that the offers stand', async () => {
    const down = nextRun(await firstNight(), later(RUN_AT, 12 * HOUR))
    down.failGogPage(1)
    down.failMicrosoftBatchWith(JOB_MICROSOFT_ID)
    down.bankState.down = true

    const summary = formatSummary(await runJob(down.deps, PRICES))

    expect(summary).toContain('| Result | published version 2 |')
    expect(summary).toContain(
      '| GOG prices | 1 reference, 0 prices read, 1 failed (GOG upstream failure (page 1)); 1 offer kept as they were; the next run reads again |',
    )
    expect(summary).toContain(
      '| Microsoft Store prices | 1 reference, 0 prices read, 1 failed (MICROSOFT upstream failure (batch)); 1 offer kept as they were; the next run reads again |',
    )
    expect(summary).toContain(
      `| Exchange rate | not read; 44.9567 UAH per USD for 2026-09-20 stands (read ${RUN_AT}, kept seven days) |`,
    )
    expect(summary).toContain('| Item failures | 0 |')
  })

  const base: JobReport = {
    mode: 'prices',
    dryRun: false,
    outcome: null,
    studios: null,
    pricesFetched: 0,
    languagesFetched: 0,
    failures: 0,
    durationMs: 1_000,
    writes: null,
  }
  const read = {
    status: 'read' as const,
    references: 999,
    pricesRead: 240,
    failed: 0,
    requests: 10,
    offers: 240,
    lastReadAt: RUN_AT,
  }
  const references = {
    games: 3_400,
    listed: 1_700,
    asked: 1_186,
    gog: 410,
    microsoft: 380,
    sweep: null,
  }

  it('reports a store read in part, and a sweep that stopped early', () => {
    const summary = formatSummary({
      ...base,
      mode: 'full',
      stores: {
        references: {
          ...references,
          sweep: { attempted: 1_200, failures: 14, remaining: 514, stopped: 'failures' },
        },
        gog: { ...read, references: 1_093, pricesRead: 870, requests: 83, offers: 870 },
        microsoft: {
          ...read,
          status: 'partial',
          pricesRead: 216,
          failed: 100,
          offers: 238,
          error: 'MICROSOFT upstream failure: TIMEOUT',
        },
        rate: { status: 'none', rate: null },
      },
    })

    expect(summary).toContain(
      '| Store references | 1700 of 3400 games on GOG or the Xbox store at RAWG, 1186 asked; 410 with a GOG page, 380 with a Microsoft Store product; RAWG: 1200 lookups this run, 14 failed, 514 left for the next full run (stopped early: too many failed) |',
    )
    expect(summary).toContain(
      '| GOG prices | 1093 references, 870 prices read, 0 failed; 870 offers published, 83 requests |',
    )
    expect(summary).toContain(
      '| Microsoft Store prices | 999 references, 216 prices read, 100 failed (MICROSOFT upstream failure: TIMEOUT); 238 offers published, 10 requests; the next run reads again |',
    )
    expect(summary).toContain(
      '| Exchange rate | not read, and no rate under seven days old is left: none published |',
    )
  })

  it('says when the sweep stopped because its time ran out', () => {
    const summary = formatSummary({
      ...base,
      mode: 'full',
      stores: {
        references: {
          ...references,
          sweep: { attempted: 231, failures: 0, remaining: 1_469, stopped: 'time' },
        },
        gog: null,
        microsoft: null,
        rate: null,
      },
    })

    expect(summary).toContain(
      'RAWG: 231 lookups this run, 0 failed, 1469 left for the next full run (stopped early: out of its twenty minutes) |',
    )
  })

  it('keeps an error from breaking the table', () => {
    const summary = formatSummary({
      ...base,
      stores: {
        references,
        gog: { ...read, status: 'failed', pricesRead: 0, failed: 999, error: 'a | b\nc' },
        microsoft: { ...read, status: 'no-references', references: 0, offers: 0 },
        rate: null,
      },
    })

    expect(summary).toContain('failed (a / b c); 240 offers kept as they were')
    expect(summary).toContain('| Microsoft Store prices | no references, nothing to read |')
    expect(summary).not.toContain('Exchange rate')
  })

  it('has no line about the stores for a run that never reached them', () => {
    expect(formatSummary({ ...base, stores: null })).not.toMatch(/Store references|GOG prices/)
    expect(formatSummary(base)).not.toMatch(/Store references|GOG prices/)
  })
})
