import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolveAppIds, type AppIdMap } from './appIds'
import { carryPublishedForward, collectCandidates, DEFAULT_CANDIDATE_PAGES } from './candidates'
import { isoNow, type JobDeps } from './deps'
import { LANGUAGE_BUDGET, refreshLanguages } from './languages'
import { refreshPrices } from './prices'
import { publishVersion, type PublishOutcome } from './publish'
import { createJobRawg, createJobSteam, systemClock } from './upstreams'
import { createWriterFromEnv } from './writer'
import type { IndexedGame } from '../../server/index/document'
import type { IndexWriteStats } from '../../server/index/GameIndex'
import { RedisBatchError } from '../../server/index/upstashIndex'

/**
 * The refresh job's command line.
 *
 * Three cadences, as the design sets them out: `--mode=prices` every six hours (cheap: one
 * batched Steam call over the documents the published version already holds), `--mode=full`
 * nightly (the candidate list, new app ids, prices, and a budgeted slice of the language work),
 * and `--mode=languages` weekly (the rest of the language sweep, at forty requests a minute).
 *
 * Everything that touches the outside world is built here and handed to the stages, so the stages
 * themselves stay testable on fixtures and a fake clock. The run starts with a write probe rather
 * than discovering half way through 3 000 games that it was handed the site's read-only token; it
 * takes the writer's version — and with it the lock, under the Upstash adapter — once, and gives
 * both back on any failure; and it always writes a summary, because a failed workflow run plus its
 * summary is the whole of this project's alerting. Secrets are read from the environment and never
 * logged.
 */

export type JobMode = 'full' | 'prices' | 'languages'

export const JOB_MODES: readonly JobMode[] = ['full', 'prices', 'languages']

/** The cursor key the write probe sets and deletes. It never holds anything a reader wants. */
export const PROBE_STAGE = 'probe'

export const READ_ONLY_TOKEN_MESSAGE =
  'The index credentials cannot write (Redis refused the write probe). The refresh job needs the write token from GitHub Secrets, not the token the site uses.'

/** What a refused write looks like when the token is a reader, whatever the store calls it. */
const CREDENTIAL_REFUSALS = /noperm|wrongpass|unauthorized|forbidden|\b40[13]\b/i

/**
 * Cursor keys earlier builds of this job wrote. Progress lives in the data now — the permanent
 * app-id mapping and the per-app language records — so nothing reads these, and a run deletes
 * them once on its way past. Two commands, idempotent, and the key space is tidy afterwards.
 */
const ABANDONED_CURSOR_STAGES = ['candidates', 'languages', 'appids', 'prices']

/**
 * Whether a failed write probe means "this token may not write" rather than "the store is down".
 * A `RedisBatchError` with a command position is the store answering and refusing a named command,
 * and the probe only ever asks it to `SET` and `DEL` one throwaway key — there is no other reason
 * to refuse those. Anything else is judged by what it says.
 */
function isCredentialRefusal(error: unknown): boolean {
  if (error instanceof RedisBatchError && error.commandIndex !== null) return true
  return CREDENTIAL_REFUSALS.test(error instanceof Error ? error.message : String(error))
}

export interface JobOptions {
  mode: JobMode
  /** RAWG pages of candidates; only `--mode=full` walks them. */
  pages: number
  /** Take the writer lock even when a dead run still holds it. */
  forceUnlock: boolean
}

export interface JobReport {
  mode: JobMode
  dryRun: boolean
  outcome: PublishOutcome | null
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
  /** What the store charged this run, when the adapter counts it. */
  writes: IndexWriteStats | null
  /** The stage that was running when the run failed, and why. */
  failedStage?: string
  error?: string
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): JobOptions {
  let mode: JobMode = 'full'
  // An unset workflow input arrives as an empty string, which is "not given", not "zero pages".
  let pages = Number(env.INDEX_PAGES?.trim() || DEFAULT_CANDIDATE_PAGES)
  let forceUnlock = env.INDEX_FORCE_UNLOCK === 'true' || env.INDEX_FORCE_UNLOCK === '1'

  for (const arg of argv) {
    const [name, value = ''] = arg.split('=', 2)
    if (name === '--mode') {
      if (!JOB_MODES.includes(value as JobMode)) {
        throw new Error(`Unknown --mode=${value}. Use one of ${JOB_MODES.join(', ')}.`)
      }
      mode = value as JobMode
    } else if (name === '--pages') {
      pages = Number(value)
    } else if (name === '--force-unlock') {
      forceUnlock = true
    } else {
      throw new Error(`Unknown argument ${arg}. Use --mode=<${JOB_MODES.join('|')}> [--pages=N].`)
    }
  }

  if (!Number.isInteger(pages) || pages < 1) {
    throw new Error(`--pages must be a positive whole number, got ${pages}.`)
  }
  return { mode, pages, forceUnlock }
}

/**
 * Set and delete one throwaway key before anything expensive starts. A token that may only read
 * refuses it, which is worth a second here and an hour of wasted RAWG quota otherwise.
 */
export async function writeProbe(deps: JobDeps): Promise<void> {
  try {
    await deps.writer.setCursor(PROBE_STAGE, String(deps.clock.now()))
    await deps.writer.clearCursor(PROBE_STAGE)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      isCredentialRefusal(error) ? READ_ONLY_TOKEN_MESSAGE : `Write probe failed: ${message}`,
      { cause: error },
    )
  }
}

/** Deletes the cursor keys older builds of this job left behind. Cheap, idempotent, once a run. */
export async function dropAbandonedCursors(deps: JobDeps): Promise<void> {
  for (const abandoned of ABANDONED_CURSOR_STAGES) {
    await deps.writer.clearCursor(abandoned)
  }
}

/**
 * Names the stage a failure came out of, so the summary can say where the run stopped, and gives
 * the write lock a sign of life once the stage is done — a stage can be an hour long and the lock
 * is deliberately shorter than that (`INDEX_LOCK_TTL_SECONDS`).
 */
function runStage(deps: JobDeps) {
  return async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run()
      await deps.writer.renewLock()
      return result
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        stage: name,
      })
    }
  }
}

export async function runJob(deps: JobDeps, options: JobOptions): Promise<JobReport> {
  const startedAt = deps.clock.now()
  deps.log(`index refresh: mode=${options.mode}`)

  const report = (extra: Partial<JobReport> = {}): JobReport => ({
    mode: options.mode,
    dryRun: false,
    outcome: null,
    pricesFetched: 0,
    languagesFetched: 0,
    failures: 0,
    durationMs: deps.clock.now() - startedAt,
    writes: deps.writer.stats?.() ?? null,
    ...extra,
  })

  const stage = runStage(deps)

  // The version — and, under the Upstash adapter, the writer lock — is taken first and given back
  // on every path out of this function. An orphaned draft is never swept, and a lock nobody
  // released blocks the owner's own retry.
  let version: number | null = null
  let pricesFetched = 0
  let languagesFetched = 0
  let failures = 0

  try {
    version = await stage('starting the version', () =>
      deps.writer.beginVersion(options.forceUnlock ? { force: true } : undefined),
    )
    await stage('tidying up', () => dropAbandonedCursors(deps))

    let games: IndexedGame[]
    let appIds: AppIdMap

    if (options.mode === 'full') {
      games = await stage('candidates', async () => {
        const collected = (await collectCandidates(deps, { pages: options.pages })).games
        await carryPublishedForward(deps, collected)
        return collected
      })
      const resolved = await stage('app ids', () => resolveAppIds(deps, games))
      appIds = resolved.appIds
      failures += resolved.failures
    } else {
      games = await stage('published documents', async () => {
        const documents = await deps.writer.allGames()
        if (documents.length === 0) {
          throw new Error(
            `--mode=${options.mode} refreshes a published version; run --mode=full first.`,
          )
        }
        return documents
      })
      appIds = await stage('published documents', () =>
        deps.writer.getAppIds(games.map((game) => game.id)),
      )
    }

    const published = await deps.writer.meta()
    let pricesUpdatedAt = published?.pricesUpdatedAt ?? null

    if (options.mode !== 'languages') {
      const prices = await stage('prices', () => refreshPrices(deps, games, appIds))
      pricesFetched = prices.answered
      failures += prices.failures
      // Only a run that heard back about nearly everything may claim its prices are fresh: the
      // staleness banner the design relies on is only as truthful as this stamp.
      if (prices.fresh) pricesUpdatedAt = isoNow(deps.clock)
      else if (options.mode === 'prices') {
        // A price run that confirmed almost nothing has nothing to publish: every document would
        // be the one already live, only with a newer `updatedAt` that would hide the outage from
        // the staleness rule. Failing says what happened, and saves a whole republication.
        throw new Error(
          `only ${prices.answered} of ${prices.requested} app ids were priced; ` +
            'this run has nothing new to publish',
        )
      }
    }

    if (options.mode !== 'prices') {
      const languages = await stage('languages', () =>
        refreshLanguages(deps, games, appIds, {
          budget: options.mode === 'full' ? LANGUAGE_BUDGET : undefined,
        }),
      )
      languagesFetched = languages.fetched
      failures += languages.failures
      // A language read can zero a price (a free game) or drop one (a game that stopped being
      // free), so the price stamp has to move with it or the meta would claim to be older than
      // the documents under it.
      if (languages.pricesTouched > 0 && options.mode === 'languages') {
        pricesUpdatedAt = isoNow(deps.clock)
      }
    }

    const outcome = await stage('publish', () =>
      publishVersion(deps, {
        version: version!,
        games,
        pricesUpdatedAt,
        pricesFetched,
        languagesFetched,
        failures,
        durationMs: deps.clock.now() - startedAt,
      }),
    )

    return report({ outcome, pricesFetched, languagesFetched, failures })
  } catch (error) {
    // Give the draft and the lock back before the failure leaves this function — but only a
    // version that was actually begun: nothing is discarded that does not exist. `discardVersion`
    // is allowed to fail too, because the original error is what the owner needs to see.
    if (version !== null) await deps.writer.discardVersion(version).catch(() => {})
    throw error
  }
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The Markdown GitHub shows on the run's summary page, for a run that reached a verdict. */
export function formatSummary(report: JobReport): string {
  const outcome = report.outcome
  const rows: [string, string][] = [['Mode', report.mode + (report.dryRun ? ' (dry run)' : '')]]

  if (!outcome) {
    rows.push(
      ['Result', `failed in ${report.failedStage ?? 'an unknown stage'}`],
      ['Error', report.error ?? 'unknown'],
      ['Prices read', String(report.pricesFetched)],
      ['Languages read', String(report.languagesFetched)],
      ['Item failures', String(report.failures)],
    )
  } else {
    const stats = outcome.meta.stats ?? {}
    rows.push(
      [
        'Result',
        outcome.published
          ? `published version ${outcome.meta.version}`
          : `refused — ${outcome.reason ?? 'validation failed'}`,
      ],
      ['Games', String(outcome.meta.gameCount)],
      ['Priced', String(stats.pricedCount ?? 0)],
      ['Prices stamped', outcome.meta.pricesUpdatedAt ?? 'never'],
      ['Ukrainian text', String(stats.textCount ?? 0)],
      ['Ukrainian audio', String(stats.audioCount ?? 0)],
      ['Prices read', String(report.pricesFetched)],
      ['Languages read', String(report.languagesFetched)],
      ['Item failures', String(report.failures)],
    )
  }

  rows.push([
    'Index traffic',
    report.writes
      ? `${report.writes.requests} requests, ${report.writes.commands} commands, ${Math.round(
          report.writes.bytes / 1024,
        )} KiB`
      : 'not counted',
  ])
  rows.push(['Duration', duration(report.durationMs)])

  const lines = [
    '## Index refresh',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
    '',
  ]
  if (!outcome) {
    lines.push(
      'If the run failed because another run still holds the writer lock, re-run the workflow',
      'with `force_unlock` set, or delete `idx:lock` in the Upstash console.',
      '',
    )
  }
  return lines.join('\n')
}

export async function writeJobSummary(
  markdown: string,
  path = process.env.GITHUB_STEP_SUMMARY,
): Promise<void> {
  if (!path) return
  await appendFile(path, markdown, 'utf8')
}

/** 0 when a version was published, 1 for anything else. The workflow's red/green comes from here. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const log = (message: string) => console.log(message)
  let mode: JobMode = 'full'
  let dryRun = false
  let writerStats: (() => IndexWriteStats | null) | null = null
  let report: JobReport

  try {
    const options = parseArgs(argv, env)
    mode = options.mode
    const fromEnv = createWriterFromEnv(env)
    dryRun = fromEnv.dryRun
    const fixtures = env.RAWG_FIXTURES === '1' || env.NUXT_RAWG_FIXTURES === '1'
    const apiKey = env.RAWG_API_KEY ?? ''
    if (!apiKey && !fixtures) throw new Error('RAWG_API_KEY is required (or RAWG_FIXTURES=1).')

    const clock = systemClock
    const deps: JobDeps = {
      rawg: createJobRawg({ apiKey, fixtures, clock }),
      steam: createJobSteam({ apiKey, fixtures, clock }),
      writer: fromEnv.writer,
      clock,
      log,
    }
    // A failed run is the one whose traffic is most worth knowing; the catch below has no `deps`.
    writerStats = () => fromEnv.writer.stats?.() ?? null

    await writeProbe(deps)
    report = { ...(await runJob(deps, options)), dryRun }
  } catch (error) {
    // The message only: an upstream error object can carry the request it failed on.
    const message = error instanceof Error ? error.message : String(error)
    const named = error as { stage?: unknown }
    console.error(message)
    report = {
      mode,
      dryRun,
      outcome: null,
      pricesFetched: 0,
      languagesFetched: 0,
      failures: 0,
      durationMs: 0,
      writes: writerStats?.() ?? null,
      failedStage: typeof named.stage === 'string' ? named.stage : 'start-up',
      error: message,
    }
  }

  // A failed run is the alert; it is worth as much as a successful one, and more.
  const summary = formatSummary(report)
  await writeJobSummary(summary).catch(() => {})
  log(summary)
  return report.outcome?.published ? 0 : 1
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
