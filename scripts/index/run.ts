import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolveAppIds, type AppIdMap } from './appIds'
import { collectCandidates, DEFAULT_CANDIDATE_PAGES } from './candidates'
import { isoNow, type JobDeps } from './deps'
import { refreshLanguages } from './languages'
import { refreshPrices } from './prices'
import { publishVersion, type PublishOutcome } from './publish'
import { createJobRawg, createJobSteam, systemClock } from './upstreams'
import { createWriterFromEnv } from './writer'
import type { IndexedGame } from '../../server/index/document'
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../shared/catalog'

/**
 * The refresh job's command line.
 *
 * Three cadences, as the design sets them out: `--mode=prices` every six hours (cheap: one
 * batched Steam call over the documents the published version already holds), `--mode=full`
 * nightly (the candidate list, new app ids, prices, then whatever languages are due), and
 * `--mode=languages` weekly (the slow per-app reads, at forty a minute).
 *
 * Everything that touches the outside world is built here and handed to the stages, so the stages
 * themselves stay testable on fixtures and a fake clock. The run starts with a write probe rather
 * than discovering half way through 3 000 games that it was handed the site's read-only token,
 * and it ends by appending a summary to the workflow run. Secrets are read from the environment
 * and never logged.
 */

export type JobMode = 'full' | 'prices' | 'languages'

export const JOB_MODES: readonly JobMode[] = ['full', 'prices', 'languages']

/** The cursor key the write probe sets and deletes. It never holds anything a reader wants. */
export const PROBE_STAGE = 'probe'

export const READ_ONLY_TOKEN_MESSAGE =
  'The index credentials are read-only: Redis refused the write probe with NOPERM. The refresh job needs the write token (GitHub Secrets), not the token the site uses.'

export interface JobOptions {
  mode: JobMode
  /** RAWG pages of candidates; only `--mode=full` walks them. */
  pages: number
}

export interface JobReport {
  mode: JobMode
  dryRun: boolean
  outcome: PublishOutcome
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): JobOptions {
  let mode: JobMode = 'full'
  // An unset workflow input arrives as an empty string, which is "not given", not "zero pages".
  let pages = Number(env.INDEX_PAGES?.trim() || DEFAULT_CANDIDATE_PAGES)

  for (const arg of argv) {
    const [name, value = ''] = arg.split('=', 2)
    if (name === '--mode') {
      if (!JOB_MODES.includes(value as JobMode)) {
        throw new Error(`Unknown --mode=${value}. Use one of ${JOB_MODES.join(', ')}.`)
      }
      mode = value as JobMode
    } else if (name === '--pages') {
      pages = Number(value)
    } else {
      throw new Error(`Unknown argument ${arg}. Use --mode=<${JOB_MODES.join('|')}> [--pages=N].`)
    }
  }

  if (!Number.isInteger(pages) || pages < 1) {
    throw new Error(`--pages must be a positive whole number, got ${pages}.`)
  }
  return { mode, pages }
}

/**
 * Set and delete one throwaway key before anything expensive starts. A read-only token answers
 * NOPERM, which is worth six seconds here and an hour of wasted RAWG quota otherwise.
 */
export async function writeProbe(deps: JobDeps): Promise<void> {
  try {
    await deps.writer.setCursor(PROBE_STAGE, String(deps.clock.now()))
    await deps.writer.clearCursor(PROBE_STAGE)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      /noperm/i.test(message) ? READ_ONLY_TOKEN_MESSAGE : `Write probe failed: ${message}`,
      { cause: error },
    )
  }
}

/** Every document of the published version, read back through the reader, in popularity order. */
export async function loadPublishedGames(deps: JobDeps): Promise<IndexedGame[]> {
  const games: IndexedGame[] = []
  for (let page = 1; page <= MAX_PAGE; page += 1) {
    const result = await deps.writer.search({
      sort: 'POPULARITY_DESC',
      page,
      pageSize: MAX_PAGE_SIZE,
    })
    games.push(...result.games)
    if (result.ids.length === 0 || games.length >= result.total) break
  }
  return games
}

export async function runJob(deps: JobDeps, options: JobOptions): Promise<JobReport> {
  const startedAt = deps.clock.now()
  deps.log(`index refresh: mode=${options.mode}`)

  let games: IndexedGame[]
  let appIds: AppIdMap
  if (options.mode === 'full') {
    games = (await collectCandidates(deps, { pages: options.pages, collected: [] })).games
    appIds = await resolveAppIds(deps, games)
  } else {
    games = await loadPublishedGames(deps)
    if (games.length === 0) {
      throw new Error(
        `--mode=${options.mode} refreshes a published version; run --mode=full first.`,
      )
    }
    appIds = await deps.writer.getAppIds(games.map((game) => game.id))
  }

  const published = await deps.writer.meta()
  let pricesUpdatedAt = published?.pricesUpdatedAt ?? null
  let pricesFetched = 0
  let languagesFetched = 0
  let failures = 0

  if (options.mode !== 'languages') {
    const prices = await refreshPrices(deps, games, appIds)
    pricesFetched = prices.requested
    pricesUpdatedAt = isoNow(deps.clock)
  }
  if (options.mode !== 'prices') {
    const languages = await refreshLanguages(deps, games, appIds)
    languagesFetched = languages.fetched
    failures = languages.failures
  }

  const version = await deps.writer.beginVersion()
  const outcome = await publishVersion(deps, {
    version,
    games,
    pricesUpdatedAt,
    pricesFetched,
    languagesFetched,
    failures,
    durationMs: deps.clock.now() - startedAt,
  })

  return {
    mode: options.mode,
    dryRun: false,
    outcome,
    pricesFetched,
    languagesFetched,
    failures,
    durationMs: deps.clock.now() - startedAt,
  }
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The Markdown GitHub shows on the run's summary page. */
export function formatSummary(report: JobReport): string {
  const { meta, published, reason } = report.outcome
  const stats = meta.stats ?? {}
  const rows: [string, string][] = [
    [
      'Result',
      published
        ? `published version ${meta.version}`
        : `refused — ${reason ?? 'validation failed'}`,
    ],
    ['Mode', report.mode + (report.dryRun ? ' (dry run, nothing published)' : '')],
    ['Games', String(meta.gameCount)],
    ['Priced', String(stats.pricedCount ?? 0)],
    ['Ukrainian text', String(stats.textCount ?? 0)],
    ['Ukrainian audio', String(stats.audioCount ?? 0)],
    ['Prices read', String(report.pricesFetched)],
    ['Languages read', String(report.languagesFetched)],
    ['Failures', String(report.failures)],
    ['Duration', duration(report.durationMs)],
  ]

  return [
    '## Index refresh',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
    '',
  ].join('\n')
}

export async function writeJobSummary(
  markdown: string,
  path = process.env.GITHUB_STEP_SUMMARY,
): Promise<void> {
  if (!path) return
  await appendFile(path, markdown, 'utf8')
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2), process.env)
  const { writer, dryRun } = createWriterFromEnv(process.env)
  const fixtures = process.env.RAWG_FIXTURES === '1' || process.env.NUXT_RAWG_FIXTURES === '1'
  const apiKey = process.env.RAWG_API_KEY ?? ''
  if (!apiKey && !fixtures) throw new Error('RAWG_API_KEY is required (or RAWG_FIXTURES=1).')

  const clock = systemClock
  const deps: JobDeps = {
    rawg: createJobRawg({ apiKey, fixtures, clock }),
    steam: createJobSteam({ apiKey, fixtures, clock }),
    writer,
    clock,
    log: (message) => console.log(message),
  }

  await writeProbe(deps)
  const report = { ...(await runJob(deps, options)), dryRun }
  const summary = formatSummary(report)
  await writeJobSummary(summary)
  console.log(summary)
  return report.outcome.published ? 0 : 1
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main().catch((error: unknown) => {
    // The message only: an upstream error object can carry the request it failed on.
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  })
}
