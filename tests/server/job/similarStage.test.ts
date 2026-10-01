import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatSummary, runJob } from '../../../scripts/index/run'
import { attachSimilar } from '../../../scripts/index/similarity'
import { JOB_PAGE_COUNT, JOB_STUDIO_GAMES } from '../../fixtures/index/jobCatalog'
import { createJobHarness } from './harness'

/**
 * The similar-games stage is an enrichment: a full run that got this far has spent an hour of RAWG
 * quota and read tonight's prices, and must not be thrown away because the ranking failed. The
 * ranking is replaced here so that it can be made to throw.
 */
vi.mock('../../../scripts/index/similarity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scripts/index/similarity')>()
  return { ...actual, attachSimilar: vi.fn(actual.attachSimilar) }
})

const RUN_AT = '2026-09-20T03:00:00.000Z'
const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const

afterEach(() => {
  vi.mocked(attachSimilar).mockClear()
})

describe('a similar-games stage that throws', () => {
  it('still publishes the run, with no list on any document, and says so', async () => {
    const harness = createJobHarness({ start: RUN_AT, studios: JOB_STUDIO_GAMES })
    await runJob(harness.deps, FULL)
    expect((await harness.writer.getOne(101))?.similar).toBeDefined()

    const nextNight = createJobHarness({
      writer: harness.writer,
      start: '2026-09-21T03:00:00.000Z',
      studios: JOB_STUDIO_GAMES,
    })
    vi.mocked(attachSimilar).mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'toLocaleLowerCase')")
    })
    const report = await runJob(nextNight.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(report.outcome?.meta.version).toBe(2)
    // Without a list the page asks by genre; a list carried over from the published version
    // could name games this version no longer holds.
    const documents = await nextNight.writer.allGames()
    expect(documents).toHaveLength(10)
    expect(documents.every((game) => !('similar' in game))).toBe(true)
    expect(report.similarWarning).toBe(
      "Similar lists not computed: Cannot read properties of undefined (reading 'toLocaleLowerCase')",
    )
    expect(nextNight.logs).toContain(`::warning::${report.similarWarning}`)
    expect(formatSummary(report)).toContain(
      "| Similar lists not computed | Cannot read properties of undefined (reading 'toLocaleLowerCase') |",
    )
  })
})
