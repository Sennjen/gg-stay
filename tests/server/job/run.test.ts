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
import { createWriterFromEnv, INDEX_LOCK_TTL_SECONDS } from '../../../scripts/index/writer'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
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

  it('leaves the price stamp where it was when too few prices came back', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, FULL)

    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    // Half the ids answer with nothing at all, which is what a soft Steam failure looks like.
    for (const appId of ['411000', '412000', '416000']) {
      later.steamPrices[appId] = { success: false }
    }
    const report = await runJob(later.deps, { mode: 'prices', pages: 1, forceUnlock: false })

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

  it('names the stage a failure came out of', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    for (const appId of ['411000', '412000', '415000']) harness.failLanguagesOnce(appId)

    await expect(runJob(harness.deps, FULL)).rejects.toMatchObject({ stage: 'languages' })
  })
})

describe('formatSummary', () => {
  const report: JobReport = {
    mode: 'full',
    dryRun: false,
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

  it('reports a refusal with its reason', () => {
    const summary = formatSummary({
      ...report,
      outcome: { ...report.outcome!, published: false, reason: 'the run priced no games' },
    })

    expect(summary).toContain('| Result | refused — the run priced no games |')
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

  it('exits non-zero when the index has no credentials and no dry run', async () => {
    quiet()

    expect(await runCli([], { RAWG_FIXTURES: '1' })).toBe(1)
    vi.restoreAllMocks()
  })
})
