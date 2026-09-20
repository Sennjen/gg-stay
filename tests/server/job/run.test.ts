import { describe, expect, it, vi } from 'vitest'
import type { JobDeps } from '../../../scripts/index/deps'
import {
  formatSummary,
  parseArgs,
  PROBE_STAGE,
  READ_ONLY_TOKEN_MESSAGE,
  runJob,
  writeProbe,
  type JobReport,
} from '../../../scripts/index/run'
import { createWriterFromEnv, UPSTASH_ADAPTER_MISSING } from '../../../scripts/index/writer'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'

describe('parseArgs', () => {
  it('runs a full refresh over the default page count', () => {
    expect(parseArgs([])).toEqual({ mode: 'full', pages: 75 })
  })

  it('takes the mode and the page count from the command line', () => {
    expect(parseArgs(['--mode=prices'])).toEqual({ mode: 'prices', pages: 75 })
    expect(parseArgs(['--mode=full', '--pages=3'])).toEqual({ mode: 'full', pages: 3 })
  })

  it('takes a small page count from INDEX_PAGES', () => {
    expect(parseArgs([], { INDEX_PAGES: '2' })).toEqual({ mode: 'full', pages: 2 })
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

  it('says the token is read-only when Redis answers NOPERM', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    vi.spyOn(harness.writer, 'setCursor').mockRejectedValue(
      new Error("NOPERM this user has no permissions to run the 'set' command"),
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

    const report = await runJob(harness.deps, { mode: 'full', pages: JOB_PAGE_COUNT })

    expect(report.outcome.published).toBe(true)
    expect(report.outcome.meta).toMatchObject({ version: 1, gameCount: 9, pricesUpdatedAt: RUN_AT })
    expect((await harness.writer.search({ free: true })).ids).toEqual([105])
    expect((await harness.writer.search({ ukrainianLocalisation: 'TEXT' })).total).toBe(4)
  })

  it('refreshes prices only, carrying documents and languages forward', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, { mode: 'full', pages: JOB_PAGE_COUNT })

    const later = createJobHarness({ writer: harness.writer, start: '2026-09-20T09:00:00.000Z' })
    const report = await runJob(later.deps, { mode: 'prices', pages: JOB_PAGE_COUNT })

    expect(later.calls).toHaveLength(0)
    expect(later.languageCalls).toHaveLength(0)
    expect(later.priceBatches).toHaveLength(1)
    expect(report.outcome.meta).toMatchObject({
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

  it('refreshes languages only, keeping the published price timestamp', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await runJob(harness.deps, { mode: 'full', pages: JOB_PAGE_COUNT })

    const weekLater = createJobHarness({
      writer: harness.writer,
      start: '2026-09-28T03:00:00.000Z',
    })
    const report = await runJob(weekLater.deps, { mode: 'languages', pages: JOB_PAGE_COUNT })

    expect(weekLater.priceBatches).toHaveLength(0)
    expect(weekLater.languageCalls).toHaveLength(6)
    expect(report.outcome.meta.pricesUpdatedAt).toBe(RUN_AT)
    expect((await weekLater.writer.getOne(101))?.priceUah).toBe(675)
  })

  it('will not refresh a version that was never published', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await expect(runJob(harness.deps, { mode: 'prices', pages: 1 })).rejects.toThrow(
      /run --mode=full first/,
    )
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
    expect(summary).toContain('| Failures | 1 |')
    expect(summary).toContain('| Duration | 2m 5s |')
  })

  it('reports a refusal with its reason', () => {
    const summary = formatSummary({
      ...report,
      outcome: { ...report.outcome, published: false, reason: 'the run priced no games' },
    })

    expect(summary).toContain('| Result | refused — the run priced no games |')
  })

  it('says so when nothing was published for real', () => {
    expect(formatSummary({ ...report, dryRun: true })).toContain(
      '| Mode | full (dry run, nothing published) |',
    )
  })
})

describe('createWriterFromEnv', () => {
  it('uses the in-memory index for a dry run', () => {
    expect(createWriterFromEnv({ INDEX_DRY_RUN: '1' }).dryRun).toBe(true)
  })

  it('asks for the Upstash credentials before anything else', () => {
    expect(() => createWriterFromEnv({})).toThrow(/UPSTASH_REDIS_REST_URL/)
  })

  it('says the adapter is still missing when the credentials are there', () => {
    expect(() =>
      createWriterFromEnv({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'token',
      }),
    ).toThrow(UPSTASH_ADAPTER_MISSING)
  })
})

describe('job deps', () => {
  it('hands every stage the same five dependencies', () => {
    const harness = createJobHarness()
    const deps: JobDeps = harness.deps

    expect(Object.keys(deps).sort()).toEqual(['clock', 'log', 'rawg', 'steam', 'writer'])
  })
})
