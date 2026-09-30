import { describe, expect, it, vi } from 'vitest'
import { LANGUAGE_BUDGET } from '../../../scripts/index/languages'
import {
  formatSummary,
  parseArgs,
  PROBE_STAGE,
  READ_ONLY_TOKEN_MESSAGE,
  runCli,
  runJob,
  writeProbe,
  type JobReport,
} from '../../../scripts/index/run'
import {
  createWriterFromEnv,
  INDEX_FORCE_AFTER_MS,
  INDEX_LOCK_TTL_SECONDS,
} from '../../../scripts/index/writer'
import { JOB_PAGE_COUNT, JOB_STUDIO_GAMES } from '../../fixtures/index/jobCatalog'
import { UKRAINIAN_STUDIO_SLUGS } from '../../../shared/ukrainianStudios'
import { RedisBatchError } from '../../../server/index/upstashIndex'
import { createJobHarness, type RawgCall } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'
const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const

describe('parseArgs', () => {
  it('runs a full refresh over the default page count', () => {
    expect(parseArgs([])).toEqual({ mode: 'full', pages: 75, forceUnlock: false })
  })

  it('takes the mode and the page count from the command line', () => {
    expect(parseArgs(['--mode=prices'])).toMatchObject({ mode: 'prices', pages: 75 })
    expect(parseArgs(['--mode=full', '--pages=3'])).toMatchObject({ mode: 'full', pages: 3 })
  })

  it('takes a small page count from INDEX_PAGES and ignores an empty one', () => {
    expect(parseArgs([], { INDEX_PAGES: '2' })).toMatchObject({ pages: 2 })
    expect(parseArgs([], { INDEX_PAGES: '' })).toMatchObject({ pages: 75 })
  })

  it('takes the forced unlock from either the flag or the workflow input', () => {
    expect(parseArgs(['--force-unlock']).forceUnlock).toBe(true)
    expect(parseArgs([], { INDEX_FORCE_UNLOCK: 'true' }).forceUnlock).toBe(true)
    expect(parseArgs([], { INDEX_FORCE_UNLOCK: 'false' }).forceUnlock).toBe(false)
  })

  it('refuses a mode or a page count it cannot run', () => {
    expect(() => parseArgs(['--mode=everything'])).toThrow(/Unknown --mode/)
    expect(() => parseArgs(['--pages=0'])).toThrow(/positive whole number/)
    expect(() => parseArgs(['--verbose'])).toThrow(/Unknown argument/)
  })
})

describe('writeProbe', () => {
  it('leaves nothing behind when the token may write', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await writeProbe(harness.deps)

    expect(await harness.writer.getCursor(PROBE_STAGE)).toBeNull()
  })

  it.each(['NOPERM this user has no permissions', 'WRONGPASS invalid password', 'HTTP 403'])(
    'says the token cannot write when Redis answers %s',
    async (message) => {
      const harness = createJobHarness({ start: RUN_AT })
      vi.spyOn(harness.writer, 'setCursor').mockRejectedValue(new Error(message))

      await expect(writeProbe(harness.deps)).rejects.toThrow(READ_ONLY_TOKEN_MESSAGE)
    },
  )

  it('blames the token when the store answers but refuses the command', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    vi.spyOn(harness.writer, 'setCursor').mockRejectedValue(
      new RedisBatchError('Command 1 [ SET ] failed: something', 'pipeline', 0, 'SET'),
    )

    await expect(writeProbe(harness.deps)).rejects.toThrow(READ_ONLY_TOKEN_MESSAGE)
  })

  it('reports any other write failure as such', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    vi.spyOn(harness.writer, 'setCursor').mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(writeProbe(harness.deps)).rejects.toThrow(/Write probe failed: ECONNREFUSED/)
  })
})

describe('runJob', () => {
  it('publishes a full run that a reader can query', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(report.outcome?.meta).toMatchObject({
      version: 1,
      gameCount: 9,
      pricesUpdatedAt: RUN_AT,
    })
    expect((await harness.writer.search({ free: true })).ids).toEqual([105])
    expect((await harness.writer.search({ ukrainianLocalisation: 'TEXT' })).total).toBe(4)
  })

  it('refreshes prices only, without asking RAWG anything at all', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, FULL)

    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    const report = await runJob(later.deps, { mode: 'prices', pages: 1, forceUnlock: false })

    expect(later.calls).toHaveLength(0)
    expect(later.languageCalls).toHaveLength(0)
    expect(later.priceBatches).toHaveLength(1)
    expect(report.outcome?.meta).toMatchObject({
      version: 2,
      gameCount: 9,
      pricesUpdatedAt: '2026-09-20T09:00:00.000Z',
    })
    expect(await later.writer.getOne(101)).toMatchObject({
      priceUah: 675,
      priceUpdatedAt: '2026-09-20T09:00:00.000Z',
      localisation: { text: true, audio: true, source: 'steam', updatedAt: RUN_AT },
    })
  })

  it('publishes nothing when a price run confirmed too few prices', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, FULL)

    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    // Half the ids answer with nothing at all, which is what a soft Steam failure looks like.
    for (const appId of ['411000', '412000', '416000']) {
      later.steamPrices[appId] = { success: false }
    }

    const refusal = await runJob(later.deps, {
      mode: 'prices',
      pages: 1,
      forceUnlock: false,
    }).catch((error: Error) => error)

    expect(refusal).toMatchObject({ stage: 'prices' })

    // The published version is untouched, prices and stamp alike.
    expect(await later.writer.currentVersion()).toBe(1)
    expect((await later.writer.meta())?.pricesUpdatedAt).toBe(RUN_AT)
    expect(await later.writer.getOne(101)).toMatchObject({ priceUah: 675, priceUpdatedAt: RUN_AT })
  })

  it('still publishes a full run that priced too little, keeping the price stamp', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, FULL)

    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    for (const appId of ['411000', '412000', '416000']) {
      later.steamPrices[appId] = { success: false }
    }
    const report = await runJob(later.deps, { ...FULL })

    // A full run brings a new candidate list with it, so it is worth publishing; only the claim
    // that its prices are fresh is withheld.
    expect(report.outcome?.published).toBe(true)
    expect(report.outcome?.meta.pricesUpdatedAt).toBe(RUN_AT)
    expect(await later.writer.getOne(101)).toMatchObject({ priceUah: 675, priceUpdatedAt: RUN_AT })
  })

  it('refreshes languages only, keeping the published price timestamp', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, FULL)

    const weekLater = createJobHarness({
      writer: harness.writer,
      start: '2026-09-28T03:00:00.000Z',
    })
    const report = await runJob(weekLater.deps, {
      mode: 'languages',
      pages: 1,
      forceUnlock: false,
    })

    expect(weekLater.priceBatches).toHaveLength(0)
    expect(weekLater.languageCalls).toHaveLength(6)
    expect(report.outcome?.meta.pricesUpdatedAt).toBe(RUN_AT)
    expect((await weekLater.writer.getOne(101))?.priceUah).toBe(675)
  })

  it('budgets the nightly language work and leaves the sweep to the weekly run', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const refresh = vi.spyOn(await import('../../../scripts/index/languages'), 'refreshLanguages')

    await runJob(harness.deps, FULL)
    await runJob(harness.deps, { mode: 'languages', pages: 1, forceUnlock: false })

    expect(refresh.mock.calls[0]![3]).toEqual({ budget: LANGUAGE_BUDGET })
    expect(refresh.mock.calls[1]![3]).toEqual({ budget: undefined })
    refresh.mockRestore()
  })

  it('renews the write lock between the stages and inside the long ones', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    await runJob(harness.deps, FULL)

    // Five stages plus the app-id and language batch flushes and one renewal per price chunk.
    expect(renewLock.mock.calls.length).toBeGreaterThanOrEqual(7)
  })

  it('deletes the cursor keys older builds of the job left behind', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await harness.writer.setCursor('candidates', '30')
    await harness.writer.setCursor('languages', '1234')

    await runJob(harness.deps, FULL)

    expect(await harness.writer.getCursor('candidates')).toBeNull()
    expect(await harness.writer.getCursor('languages')).toBeNull()
  })

  it('will not refresh a version that was never published', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await expect(
      runJob(harness.deps, { mode: 'prices', pages: 1, forceUnlock: false }),
    ).rejects.toThrow(/run --mode=full first/)
  })

  it('asks for a forced unlock only when it was told to', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const beginVersion = vi.spyOn(harness.writer, 'beginVersion')

    await runJob(harness.deps, FULL)
    await runJob(harness.deps, { ...FULL, forceUnlock: true })

    expect(beginVersion.mock.calls[0]![0]).toBeUndefined()
    expect(beginVersion.mock.calls[1]![0]).toEqual({ force: true })
  })

  it.each([
    ['the candidate walk', (call: RawgCall) => call.path === 'games'],
    ['the app id lookups', (call: RawgCall) => call.path.endsWith('/stores')],
  ])('gives the draft back when %s brings the run down', async (_name, match) => {
    const harness = createJobHarness({ start: RUN_AT })
    const discardVersion = vi.spyOn(harness.writer, 'discardVersion')
    for (let i = 0; i < 10; i += 1) harness.failNext(match)

    await expect(runJob(harness.deps, FULL)).rejects.toThrow()

    expect(discardVersion).toHaveBeenCalledWith(1)
    expect(await harness.writer.currentVersion()).toBeNull()
  })

  it('carries what it had already done out with a failure', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    for (const appId of ['411000', '412000', '415000']) harness.failLanguagesOnce(appId)

    const failure = await runJob(harness.deps, FULL).catch(
      (error: Error & { report?: JobReport }) => error,
    )

    expect(failure.report).toMatchObject({
      mode: 'full',
      outcome: null,
      pricesFetched: 6,
      failures: 0,
    })
  })

  it('names the stage a failure came out of', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    for (const appId of ['411000', '412000', '415000']) harness.failLanguagesOnce(appId)

    await expect(runJob(harness.deps, FULL)).rejects.toMatchObject({ stage: 'languages' })
  })
})

describe('runJob with the studios stage', () => {
  const STUDIO_SLUGS = UKRAINIAN_STUDIO_SLUGS.length

  it('flags the studio games and prices and localises the appended one like a candidate', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.meta).toMatchObject({ gameCount: 10 })
    expect(report.outcome?.meta.stats).toMatchObject({ candidateCount: 9, madeInUkraineCount: 2 })
    expect((await harness.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])
    expect(await harness.writer.getAppIds([110])).toEqual(new Map([[110, '420000']]))
    expect(await harness.writer.getOne(110)).toMatchObject({
      madeInUkraine: true,
      priceUah: 239,
      discountPercent: 40,
      localisation: { text: true, audio: true, source: 'steam' },
    })
  })

  it('reports what the stage cost RAWG on a first run and on a steady one', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    const first = await runJob(harness.deps, FULL)

    const nextNight = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
      studios: JOB_STUDIO_GAMES,
    })
    const steady = await runJob(nextNight.deps, FULL)

    // One list page per studio slug every night; the appended game's app id is looked up once.
    expect(first.studios).toMatchObject({
      madeInUkraine: 2,
      previousMadeInUkraine: null,
      appended: 1,
      dropped: 0,
      kept: 0,
      degraded: false,
      failures: 0,
      unknownSlugs: [],
      listRequests: STUDIO_SLUGS,
      appIdLookups: 1,
    })
    expect(steady.studios).toMatchObject({
      madeInUkraine: 2,
      previousMadeInUkraine: 2,
      listRequests: STUDIO_SLUGS,
      appIdLookups: 0,
    })
    expect(nextNight.studioCalls()).toHaveLength(STUDIO_SLUGS)
    expect(nextNight.storeCalls()).toHaveLength(0)
  })

  it('keeps the flag and the appended games through a price run and a language run', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)

    const prices = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    prices.steamPrices['420000'] = {
      success: true,
      data: {
        price_overview: { currency: 'UAH', initial: 39900, final: 39900, discount_percent: 0 },
      },
    }
    await runJob(prices.deps, { mode: 'prices', pages: 1, forceUnlock: false })

    expect(prices.calls).toHaveLength(0)
    expect(await prices.writer.getOne(110)).toMatchObject({ madeInUkraine: true, priceUah: 399 })
    expect((await prices.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])

    const weekLater = createJobHarness({
      writer: harness.writer,
      start: '2026-09-28T03:00:00.000Z',
    })
    const languages = await runJob(weekLater.deps, {
      mode: 'languages',
      pages: 1,
      forceUnlock: false,
    })

    expect(weekLater.languageCalls.map((call) => call.appId)).toContain('420000')
    expect(languages.outcome?.meta.stats).toMatchObject({ madeInUkraineCount: 2 })
    expect((await weekLater.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])
  })

  it('keeps the flags on the next full run and carries the appended game price forward', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)

    const nextNight = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
      studios: JOB_STUDIO_GAMES,
    })
    // Steam says nothing about the appended game tonight; yesterday's price must survive that.
    nextNight.steamPrices['420000'] = { success: false }
    await runJob(nextNight.deps, FULL)

    expect((await nextNight.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])
    expect(await nextNight.writer.getOne(110)).toMatchObject({
      priceUah: 239,
      priceUpdatedAt: RUN_AT,
    })
  })

  it('keeps the published games of a studio that listed nothing tonight', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)

    const nextNight = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
      studios: { 'gsc-game-world': JOB_STUDIO_GAMES['gsc-game-world']! },
    })
    const report = await runJob(nextNight.deps, FULL)

    expect((await nextNight.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])
    expect(report.studios).toMatchObject({ kept: 1, degraded: false })
  })

  it('publishes a degraded studios stage rather than failing, keeping every published flag', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)
    // Published by a build that did not note studio slugs, so nothing can be kept per slug.
    const legacy = (await harness.writer.allGames()).map(({ studioSlugs: _slugs, ...game }) => game)
    const version = await harness.writer.beginVersion()
    await harness.writer.writeVersion(version, legacy)
    await harness.writer.publish(version, { ...(await harness.writer.meta())!, version })

    // Tonight RAWG lists nothing for any studio.
    const nextNight = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
    })
    const report = await runJob(nextNight.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(report.studios).toMatchObject({ degraded: true, madeInUkraine: 2 })
    expect((await nextNight.writer.search({ madeInUkraine: true })).ids).toEqual([106, 110])
    expect(formatSummary(report)).toContain('| Studios stage | degraded')
  })

  it('refuses a run whose candidate walk collapsed, however many studio games it added', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)

    // One page of three candidates, plus the two studio games: five games against the ten
    // published, which a gate counted on the total would let through.
    const collapsed = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
      studios: JOB_STUDIO_GAMES,
    })
    const report = await runJob(collapsed.deps, { ...FULL, pages: 1 })

    expect(report.outcome?.meta.gameCount).toBe(5)
    expect(report.outcome?.published).toBe(false)
    expect(report.outcome?.reason).toMatch(/3 candidates, fewer than half of the published 9/)
    expect(await collapsed.writer.currentVersion()).toBe(1)
  })

  it('says so when it reads every studio for a candidate walk cut short by --pages', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await runJob(harness.deps, FULL)

    expect(harness.logs).toContain(
      `studios: reading all ${STUDIO_SLUGS} studio slugs although --pages=${JOB_PAGE_COUNT} limits the candidates`,
    )
  })

  it('names the studios stage when it fails the run', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    for (const slug of ['4a-games', 'best-way']) {
      harness.failNext((call) => call.params.developers === slug)
    }

    const failure = await runJob(harness.deps, FULL).catch(
      (error: Error & { stage?: string }) => error,
    )

    expect(failure).toMatchObject({ stage: 'studios' })
    expect(await harness.writer.currentVersion()).toBeNull()
  })

  it('adds the failures of a studio it skipped to the item failures', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    harness.failNext((call) => call.params.developers === '4a-games')

    const report = await runJob(harness.deps, FULL)

    expect(report.failures).toBe(1)
    expect(report.studios?.failures).toBe(1)
  })
})

describe('formatSummary', () => {
  const report: JobReport = {
    mode: 'full',
    dryRun: false,
    studios: null,
    pricesFetched: 6,
    languagesFetched: 6,
    failures: 1,
    durationMs: 125_000,
    writes: { requests: 31, commands: 412, bytes: 1_048_576 },
    outcome: {
      published: true,
      reason: null,
      previous: null,
      meta: {
        version: 3,
        updatedAt: RUN_AT,
        pricesUpdatedAt: RUN_AT,
        gameCount: 2_980,
        stats: { pricedCount: 2_711, textCount: 402, audioCount: 96 },
      },
    },
  }

  it('reports what was published, in counts a reader can check', () => {
    const summary = formatSummary(report)

    expect(summary).toContain('| Result | published version 3 |')
    expect(summary).toContain('| Games | 2980 |')
    expect(summary).toContain('| Priced | 2711 |')
    expect(summary).toContain('| Ukrainian audio | 96 |')
    expect(summary).toContain('| Item failures | 1 |')
    expect(summary).toContain('| Index traffic | 31 requests, 412 commands, 1024 KiB |')
    expect(summary).toContain('| Duration | 2m 5s |')
  })

  it('reports the studio games a full run found, kept and paid for, and what went missing', () => {
    const summary = formatSummary({
      ...report,
      studios: {
        madeInUkraine: 57,
        previousMadeInUkraine: 60,
        appended: 41,
        dropped: 0,
        kept: 3,
        expired: 2,
        degraded: false,
        failures: 1,
        unknownSlugs: ['brenntkopf', 'mokus-games'],
        emptySlugs: ['cyberlight'],
        studiosWithoutGames: ['Cyberlight Game Studio'],
        listRequests: 35,
        appIdLookups: 41,
      },
    })

    expect(summary).toContain(
      '| Studio games | 57 made in Ukraine (published version: 60), 41 added beyond the popularity list, 0 dropped by the bound, 3 kept from the published version, 1 studio failed; RAWG: 35 list requests, 41 app id lookups |',
    )
    expect(summary).toContain(
      '| Studio games expired | 2 games of unknown or empty studio slugs, not found for a week, were dropped |',
    )
    expect(summary).toContain('| Studios with no games | Cyberlight Game Studio |')
    expect(summary).toContain('| Studio slugs unknown to RAWG | brenntkopf, mokus-games |')
    expect(summary).toContain('| Studio slugs with no games | cyberlight |')
    expect(summary).not.toContain('| Studios stage |')
  })

  it('reports the published count of studio games for a run that does not read the studios', () => {
    const summary = formatSummary({
      ...report,
      mode: 'prices',
      outcome: {
        ...report.outcome!,
        meta: {
          ...report.outcome!.meta,
          stats: { ...report.outcome!.meta.stats, madeInUkraineCount: 57 },
        },
      },
    })

    expect(summary).toContain('| Studio games | 57 made in Ukraine (not re-read in this mode) |')
  })

  it('reports a refusal with its reason', () => {
    const summary = formatSummary({
      ...report,
      outcome: { ...report.outcome!, published: false, reason: 'the run priced no games' },
    })

    expect(summary).toContain('| Result | refused — the run priced no games |')
  })

  it('names the prices stage and the counts a refused price run reached', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false })
    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    for (const appId of ['411000', '412000', '416000']) {
      later.steamPrices[appId] = { success: false }
    }

    const failure = await runJob(later.deps, {
      mode: 'prices',
      pages: 1,
      forceUnlock: false,
    }).catch((error: Error & { stage?: string; report?: JobReport }) => error)

    // What `runCli` builds out of a failure, and what the operator reads in the job summary.
    const summary = formatSummary({
      ...failure.report!,
      failedStage: failure.stage,
      error: failure.message,
    })
    expect(summary).toContain('| Result | failed in prices |')
    expect(summary).toContain('| Error | only 3 of 6 app ids were priced')
    expect(summary).toContain('| Prices read | 3 |')
  })

  it('reports a failure with the stage, the error and the way out of a held lock', () => {
    const summary = formatSummary({
      ...report,
      outcome: null,
      failedStage: 'prices',
      error: 'STEAM upstream failure',
    })

    expect(summary).toContain('| Result | failed in prices |')
    expect(summary).toContain('| Error | STEAM upstream failure |')
    expect(summary).toContain('force_unlock')
  })

  it('says so when nothing was published for real', () => {
    expect(formatSummary({ ...report, dryRun: true })).toContain('| Mode | full (dry run) |')
  })
})

describe('createWriterFromEnv', () => {
  it('uses the in-memory index for a dry run', () => {
    expect(createWriterFromEnv({ INDEX_DRY_RUN: '1' }).dryRun).toBe(true)
  })

  it('asks for the Upstash credentials before anything else', () => {
    expect(() => createWriterFromEnv({})).toThrow(/UPSTASH_REDIS_REST_URL/)
  })

  it('builds the Upstash adapter from the write credentials', () => {
    const { writer, dryRun } = createWriterFromEnv({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    })

    expect(dryRun).toBe(false)
    expect(typeof writer.allGames).toBe('function')
    expect(typeof writer.renewLock).toBe('function')
  })

  it('gives the lock a life shorter than the gap between two scheduled runs', () => {
    // The six-hourly price run is the next one along; a dead run must not block it.
    expect(INDEX_LOCK_TTL_SECONDS).toBeLessThan(6 * 60 * 60)
    // And long enough to cover the longest gap between two renewals with room to spare.
    expect(INDEX_LOCK_TTL_SECONDS).toBeGreaterThanOrEqual(10 * 60)
  })

  it('lets a forced run act well before the lock would have lapsed on its own', () => {
    // If these were the same number, forcing could only work where a plain retry already did,
    // and the workflow's force_unlock input would be a no-op at every moment it is needed.
    expect(INDEX_FORCE_AFTER_MS).toBeLessThan(INDEX_LOCK_TTL_SECONDS * 1000)
    expect(INDEX_FORCE_AFTER_MS * 3).toBeLessThan(INDEX_LOCK_TTL_SECONDS * 1000)
  })
})

describe('runCli', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('exits zero after publishing a version', async () => {
    quiet()

    const code = await runCli(['--mode=full', '--pages=1'], {
      INDEX_DRY_RUN: '1',
      RAWG_FIXTURES: '1',
    })

    expect(code).toBe(0)
    // The recorded studio lists (`tests/fixtures/rawg/games-developers-*.json`) flag one game of
    // the popularity fixture and add one more; every other studio has no fixture and no games.
    const summary = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string
    expect(summary).toContain(
      `| Studio games | 2 made in Ukraine (published version: none), 1 added beyond the popularity list, 0 dropped by the bound, 0 kept from the published version, 0 studios failed; RAWG: ${UKRAINIAN_STUDIO_SLUGS.length} list requests, 0 app id lookups |`,
    )
    expect(summary).toMatch(
      /\| Studio slugs with no games \| 4a-games, action-forms, .*whale-rock-games-2 \|/,
    )
    expect(summary).toContain('| Studio slugs unknown to RAWG | none |')
    vi.restoreAllMocks()
  })

  it('exits non-zero, and says why, when it cannot even start', async () => {
    quiet()

    const code = await runCli(['--mode=everything'], { INDEX_DRY_RUN: '1', RAWG_FIXTURES: '1' })

    expect(code).toBe(1)
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toMatch(/Unknown --mode/)
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain(
      '| Result | failed in start-up |',
    )
    vi.restoreAllMocks()
  })

  it('names the stage in the summary it writes for a failed run', async () => {
    quiet()

    const code = await runCli(['--mode=prices'], { INDEX_DRY_RUN: '1', RAWG_FIXTURES: '1' })

    expect(code).toBe(1)
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain(
      '| Result | failed in published documents |',
    )
    vi.restoreAllMocks()
  })

  it('exits non-zero when the index has no credentials and no dry run', async () => {
    quiet()

    expect(await runCli([], { RAWG_FIXTURES: '1' })).toBe(1)
    vi.restoreAllMocks()
  })
})
