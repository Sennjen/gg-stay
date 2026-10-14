import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { appIdsForDocuments, attachAppIds, resolveAppIds, type AppIdMap } from './appIds'
import { carryPublishedForward, collectCandidates, DEFAULT_CANDIDATE_PAGES } from './candidates'
import { isoNow, oneLine, type JobDeps } from './deps'
import { LANGUAGE_BUDGET, refreshLanguages } from './languages'
import {
  OFFER_FLOOR_MIN_CARRIED,
  refreshOffers,
  type OffersResult,
  type RateReport,
  type StoreReadReport,
} from './offers'
import { refreshPrices } from './prices'
import { publishVersion, type PublishOutcome } from './publish'
import { createRequestMeter } from './requestMeter'
import {
  assertResolveOptions,
  requestMeterOf,
  RESOLVE_DEFAULT_FROM_PAGE,
  RESOLVE_DEFAULT_PAGES,
  RESOLVE_MAX_BUDGET,
  resolveMoreGames,
  resolveWarnings,
  type ResolveReadingEnd,
  type ResolveReport,
  type ResolveStop,
} from './resolve'
import { attachSimilar, similarHealthWarning, tagReport, type TagReport } from './similarity'
import { countStoreRefs, sweepStoreRefs, type StoreRefMap, type SweepStop } from './storeRefs'
import { collectStudioGames } from './studios'
import { UKRAINIAN_STUDIO_SLUGS } from '../../shared/ukrainianStudios'
import {
  createJobBank,
  createJobGog,
  createJobMicrosoft,
  createJobRawg,
  createJobSteam,
  systemClock,
} from './upstreams'
import { createWriterFromEnv } from './writer'
import type { IndexedGame } from '../../server/index/document'
import type { IndexWriteStats } from '../../server/index/GameIndex'
import { RedisBatchError } from '../../server/index/upstashIndex'

/**
 * The refresh job's command line.
 *
 * Three cadences, as the design sets them out: `--mode=prices` every six hours (cheap: one
 * batched Steam call over the documents the published version already holds), `--mode=full`
 * nightly (the candidate list, the Ukrainian studios' games, new app ids, prices, and a budgeted
 * slice of the language work),
 * and `--mode=languages` weekly (the rest of the language sweep, at forty requests a minute).
 *
 * One thing keeps a cadence of its own, across all three: what GOG and the Microsoft Store charge
 * is read by whichever run finds the last read more than eleven hours old (`offers.ts`), which
 * is every other prices run, and the National Bank's rate by every run.
 *
 * A fourth mode has no cadence at all: `--mode=resolve` is run by hand, inside a number of RAWG
 * requests it is told, to learn the store pages of games further down the popularity order than
 * the index goes (`resolve.ts`). It holds the writer's lock like the others and publishes
 * nothing: no documents, no version, no pointer, no metadata.
 *
 * Everything that touches the outside world is built here and handed to the stages, so the stages
 * themselves stay testable on fixtures and a fake clock. The run starts with a write probe rather
 * than discovering half way through 3 000 games that it was handed the site's read-only token; it
 * takes the writer's version — and with it the lock, under the Upstash adapter — once, and gives
 * both back on any failure; and it always writes a summary, because a failed workflow run plus its
 * summary is the whole of this project's alerting. Secrets are read from the environment and never
 * logged.
 */

export type JobMode = 'full' | 'prices' | 'languages' | 'resolve'

export const JOB_MODES: readonly JobMode[] = ['full', 'prices', 'languages', 'resolve']

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
  /**
   * RAWG pages of the popularity order: how many `--mode=full` walks from the top, and the most
   * `--mode=resolve` reads from `fromPage` on.
   */
  pages: number
  /** Take the writer lock even when a dead run still holds it. */
  forceUnlock: boolean
  /** `--mode=resolve` only: the most RAWG requests the run may send. It does not start without. */
  budget?: number
  /** `--mode=resolve` only: the first page it reads; `RESOLVE_DEFAULT_FROM_PAGE` when omitted. */
  fromPage?: number
}

/**
 * What the studios stage found and what it cost RAWG, for the job summary. A full run only: the
 * other modes republish the flags the last full run set.
 */
export interface StudioReport {
  /** Games of this run made in Ukraine, and of the version published before it (`null`: none). */
  madeInUkraine: number
  previousMadeInUkraine: number | null
  /** Games added beyond the popularity list, and those the bound left out. */
  appended: number
  dropped: number
  /** Published games kept flagged because tonight could not confirm them. */
  kept: number
  /** Published games of a 404 or empty slug dropped after a week unconfirmed. */
  expired: number
  /** Under half the published count was found, so every published flag was kept. */
  degraded: boolean
  /** Studio slugs that failed and were skipped. */
  failures: number
  /** Slugs RAWG does not know (404), slugs that listed no games, and studios with no game at all. */
  unknownSlugs: string[]
  emptySlugs: string[]
  studiosWithoutGames: string[]
  /** RAWG requests for the studios' game lists, retries included. */
  listRequests: number
  /** RAWG app-id lookups spent on appended games — on their first run only, the mapping is kept. */
  appIdLookups: number
}

/**
 * What a run knows of the stores other than Steam: which games the permanent mapping names a
 * product for, what a full run's sweep of that mapping cost RAWG, and what reading each store and
 * the bank came to. `null` on a run that ended before it had read the mapping.
 */
export interface StoresReport {
  references: {
    /**
     * Games of the run; those of them RAWG lists on GOG or on the Xbox store, which are the ones
     * asked about; and those of the listed that have been asked about already.
     */
    games: number
    listed: number
    asked: number
    /** Games the mapping names a GOG page for, and a Microsoft Store product. */
    gog: number
    microsoft: number
    /** What the sweep did, in a full run; `null` in the modes that ask RAWG nothing. */
    sweep: {
      attempted: number
      failures: number
      remaining: number
      /** Why the sweep ended before its cap, or `null` when it did not. */
      stopped: SweepStop | null
    } | null
  }
  /** `null` on a run that ended before the stores were read. */
  gog: StoreReadReport | null
  microsoft: StoreReadReport | null
  rate: RateReport | null
}

export interface JobReport {
  mode: JobMode
  dryRun: boolean
  outcome: PublishOutcome | null
  studios: StudioReport | null
  /** Optional so that a report built by hand need not name it; `runJob` always does. */
  stores?: StoresReport | null
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
  /** What the store charged this run, when the adapter counts it. */
  writes: IndexWriteStats | null
  /**
   * Set when a full run's similar lists look empty (`similarHealthWarning`) or could not be
   * computed at all: the log carries it as a GitHub `::warning::` and the summary as a row. The
   * run still publishes.
   */
  similarWarning?: string | null
  /** A full run's stored tags, for judging the tag cut on live data (`tagReport`). */
  tags?: TagReport | null
  /**
   * What a resolve run did. The only part of the report such a run fills: it publishes nothing,
   * so `outcome` stays `null` for it, in success as in failure.
   */
  resolve?: ResolveReport | null
  /** The stage that was running when the run failed, and why. */
  failedStage?: string
  error?: string
}

/**
 * A whole number written in digits and in nothing else, or `null`. The numbers of a resolve run
 * are quota, and come from a form somebody filled in: `8e3`, `0x1F40`, `8 000` and `8000.0` are
 * all numbers to `Number`, and none of them is taken for one here.
 */
function wholeNumber(text: string): number | null {
  return /^[0-9]{1,9}$/.test(text) ? Number(text) : null
}

/** An error of the command line that knows which mode it was refused in, for the summary. */
function refusal(mode: JobMode, message: string): Error {
  return Object.assign(new Error(message), { mode })
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): JobOptions {
  let mode: JobMode = 'full'
  // An unset workflow input arrives as an empty string, which is "not given", not "zero pages".
  // What "not given" comes to depends on the mode, which is not known until the loop is done.
  const pagesInput = env.INDEX_PAGES?.trim() ?? ''
  let pages: number | null = pagesInput === '' ? null : Number(pagesInput)
  let forceUnlock = env.INDEX_FORCE_UNLOCK === 'true' || env.INDEX_FORCE_UNLOCK === '1'
  // The two numbers only a resolve run reads, kept as they were typed until that is known.
  let budget = env.INDEX_BUDGET?.trim() ?? ''
  let fromPage = env.INDEX_FROM_PAGE?.trim() ?? ''

  for (const arg of argv) {
    const [name, value = ''] = arg.split('=', 2)
    if (name === '--mode') {
      if (!JOB_MODES.includes(value as JobMode)) {
        throw new Error(`Unknown --mode=${value}. Use one of ${JOB_MODES.join(', ')}.`)
      }
      mode = value as JobMode
    } else if (name === '--pages') {
      pages = Number(value)
    } else if (name === '--budget') {
      budget = value.trim()
    } else if (name === '--from-page') {
      fromPage = value.trim()
    } else if (name === '--force-unlock') {
      forceUnlock = true
    } else {
      throw new Error(
        `Unknown argument ${arg}. Use --mode=<${JOB_MODES.join('|')}> [--pages=N] ` +
          '[--budget=N --from-page=N for resolve].',
      )
    }
  }

  pages ??= mode === 'resolve' ? RESOLVE_DEFAULT_PAGES : DEFAULT_CANDIDATE_PAGES
  if (!Number.isInteger(pages) || pages < 1) {
    throw refusal(mode, `--pages must be a positive whole number, got ${pages}.`)
  }
  if (mode !== 'resolve') {
    // Fail closed. The two numbers are a resolve run's alone, so another mode that is handed one
    // was chosen by mistake in the form, and run as chosen it would ask RAWG for whatever its own
    // stages want, under no budget — a full run with resolve's page count would ask about
    // thousands of games and publish them. Scheduled runs pass both empty and are not touched.
    const given = [
      ...(budget === '' ? [] : ['--budget']),
      ...(fromPage === '' ? [] : ['--from-page']),
    ]
    if (given.length > 0) {
      const tooManyPages =
        pages > DEFAULT_CANDIDATE_PAGES
          ? `, and --pages=${pages} is more than the ${DEFAULT_CANDIDATE_PAGES} the index is made of`
          : ''
      throw refusal(
        mode,
        `${given.join(' and ')} belong to --mode=resolve; a --mode=${mode} run given ` +
          `${given.length === 1 ? 'it' : 'them'} does not start${tooManyPages}.`,
      )
    }
    return { mode, pages, forceUnlock }
  }

  // A resolve run spends what it is told and nothing is assumed for it: no budget, no run.
  if (budget === '') {
    throw refusal(
      mode,
      '--mode=resolve needs a budget: the most RAWG requests the run may send ' +
        `(--budget=N or INDEX_BUDGET, at most ${RESOLVE_MAX_BUDGET}).`,
    )
  }
  const requests = wholeNumber(budget)
  if (requests === null || requests < 1) {
    throw refusal(mode, `--budget must be a positive whole number, got ${oneLine(budget)}.`)
  }
  if (requests > RESOLVE_MAX_BUDGET) {
    throw refusal(
      mode,
      `--budget=${requests} is above the most one run may be given (${RESOLVE_MAX_BUDGET}).`,
    )
  }
  const first = fromPage === '' ? RESOLVE_DEFAULT_FROM_PAGE : wholeNumber(fromPage)
  if (first === null || first < 1) {
    throw refusal(mode, `--from-page must be a positive whole number, got ${oneLine(fromPage)}.`)
  }
  return { mode, pages, forceUnlock, budget: requests, fromPage: first }
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

/**
 * A resolve run, whole: the lock, the stage, the lock given back. It is `runJob` for the one mode
 * that has no version to write.
 *
 * The lock is taken the way every run takes it — `beginVersion`, which is the port's only way —
 * and given back with `discardVersion`, as a run that fails gives it back: the draft that was
 * begun holds no key and is dropped unwritten. So the run leaves the published version, its
 * pointer and its metadata exactly as it found them, and what it does leave — the two mappings —
 * was written under the lock a scheduled run would have had to hold to write them too.
 *
 * It is refused before the lock is asked for when it has no usable budget or no meter to hold it
 * to one: a run that cannot start should not make a scheduled run wait for it.
 */
async function runResolve(
  deps: JobDeps,
  options: JobOptions,
  report: (extra?: Partial<JobReport>) => JobReport,
  stage: ReturnType<typeof runStage>,
): Promise<JobReport> {
  const resolveOptions = {
    budget: options.budget,
    fromPage: options.fromPage ?? RESOLVE_DEFAULT_FROM_PAGE,
    pages: options.pages,
  }
  assertResolveOptions(resolveOptions)
  requestMeterOf(deps)

  let version: number | null = null
  let resolved: ResolveReport | null = null
  try {
    version = await stage('starting the version', () =>
      deps.writer.beginVersion(options.forceUnlock ? { force: true } : undefined),
    )
    resolved = await stage('resolve', () => resolveMoreGames(deps, resolveOptions))
    // RAWG cannot fail this run, so what it cost the run is said here instead.
    for (const warning of resolveWarnings(resolved)) deps.log(`::warning::${warning}`)

    const begun = version
    await stage('releasing the lock', () => deps.writer.discardVersion(begun))
    version = null
    return report({ resolve: resolved })
  } catch (error) {
    if (version !== null) await deps.writer.discardVersion(version).catch(() => {})
    // What the stage had done when the index failed it travels on the error it threw.
    const reached = resolved ?? (error as { resolve?: ResolveReport } | null)?.resolve ?? null
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      report: report({ resolve: reached }),
    })
  }
}

export async function runJob(deps: JobDeps, options: JobOptions): Promise<JobReport> {
  const startedAt = deps.clock.now()
  deps.log(`index refresh: mode=${options.mode}`)

  const report = (extra: Partial<JobReport> = {}): JobReport => ({
    mode: options.mode,
    dryRun: false,
    outcome: null,
    studios: null,
    stores: null,
    pricesFetched: 0,
    languagesFetched: 0,
    failures: 0,
    durationMs: deps.clock.now() - startedAt,
    writes: deps.writer.stats?.() ?? null,
    ...extra,
  })

  const stage = runStage(deps)

  // Nothing below is a resolve run's: it has no documents, and publishes none.
  if (options.mode === 'resolve') return runResolve(deps, options, report, stage)

  // The version — and, under the Upstash adapter, the writer lock — is taken first and given back
  // on every path out of this function. An orphaned draft is never swept, and a lock nobody
  // released blocks the owner's own retry.
  let version: number | null = null
  let pricesFetched = 0
  let languagesFetched = 0
  let failures = 0
  let studios: StudioReport | null = null
  let stores: StoresReport | null = null
  let candidateCount: number | undefined
  let similarWarning: string | null = null
  let tags: TagReport | null = null

  try {
    version = await stage('starting the version', () =>
      deps.writer.beginVersion(options.forceUnlock ? { force: true } : undefined),
    )
    await stage('tidying up', () => dropAbandonedCursors(deps))

    let games: IndexedGame[]
    /** What the price and language stages work from: in a full run, tonight's Steam games. */
    let appIds: AppIdMap
    /** What the documents repeat: the whole mapping for the run's games, in every mode. */
    let documentAppIds: AppIdMap
    /** Which product each game is on GOG and on the Microsoft Store, from the permanent mapping. */
    let storeRefs: StoreRefMap
    let sweep: NonNullable<StoresReport['references']['sweep']> | null = null

    if (options.mode === 'full') {
      games = await stage('candidates', async () => {
        const collected = (await collectCandidates(deps, { pages: options.pages })).games
        await carryPublishedForward(deps, collected)
        return collected
      })
      candidateCount = games.length
      // After the candidates' carry-forward, so nothing it copies can overwrite a flag set here;
      // the games it appends get their own carry-forward, as a candidate would have.
      const found = await stage('studios', async () => {
        // A manual run with a few candidate pages is a smoke test, but the studios are read in
        // full all the same: said here, because the RAWG requests it costs are not small.
        if (options.pages < DEFAULT_CANDIDATE_PAGES) {
          deps.log(
            `studios: reading all ${UKRAINIAN_STUDIO_SLUGS.length} studio slugs although --pages=${options.pages} limits the candidates`,
          )
        }
        const result = await collectStudioGames(deps, games)
        await carryPublishedForward(deps, result.appended, 'studios')
        return result
      })
      failures += found.failures
      studios = {
        madeInUkraine: found.madeInUkraine,
        previousMadeInUkraine: found.previousMadeInUkraine,
        appended: found.appended.length,
        dropped: found.dropped,
        kept: found.kept,
        expired: found.expired,
        degraded: found.degraded,
        failures: found.failures,
        unknownSlugs: found.unknown,
        emptySlugs: found.empty,
        studiosWithoutGames: found.studiosWithoutGames,
        listRequests: found.requests,
        appIdLookups: 0,
      }

      const resolved = await stage('app ids', async () => {
        const answered = await resolveAppIds(deps, games)
        // The stage answers for the games RAWG lists on Steam tonight. The documents repeat the
        // whole mapping, so what it already holds for the others is read here, once.
        return { ...answered, forDocuments: await appIdsForDocuments(deps, games, answered.appIds) }
      })
      appIds = resolved.appIds
      documentAppIds = resolved.forDocuments
      failures += resolved.failures
      const appended = new Set(found.appended.map((game) => game.id))
      studios.appIdLookups = resolved.asked.filter((id) => appended.has(id)).length

      // After the app ids, which have just written the references of every game they looked up:
      // what is left for the sweep is the games RAWG lists on GOG or on the Xbox store that no
      // run has asked about yet, a capped number of them a night. RAWG cannot fail the run here
      // — see `sweepStoreRefs` — but what it would not answer for is an item failure like any
      // other.
      const swept = await stage('store references', () => sweepStoreRefs(deps, games))
      storeRefs = swept.refs
      sweep = {
        attempted: swept.attempted,
        failures: swept.failures,
        remaining: swept.remaining,
        stopped: swept.stopped,
      }
      failures += swept.failures
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
      // Already the mapping for every published game: there is nothing more to read.
      documentAppIds = appIds
      // The other mapping, read the same way: one request, and RAWG is asked nothing.
      storeRefs = await stage('published documents', () =>
        deps.writer.getStoreRefs(games.map((game) => game.id)),
      )
    }
    stores = {
      references: { games: games.length, ...countStoreRefs(games, storeRefs), sweep },
      gog: null,
      microsoft: null,
      rate: null,
    }

    // One rule in every mode: a document carries its game's Steam app id whenever the permanent
    // mapping holds one, so the game page can read it from the document instead of waiting for
    // RAWG's store links — and finds the same thing there whichever run published last. After the
    // studios stage on purpose, so the games it appended are covered too.
    const withAppId = attachAppIds(games, documentAppIds)
    deps.log(`app ids: ${withAppId} of ${games.length} documents carry their Steam app id`)

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
        // the staleness rule. Failing says what happened, and saves a whole republication. It is
        // the price stage's verdict, so it is tagged as one: an operator reading "failed in
        // start-up" would go looking at the credentials.
        throw Object.assign(
          new Error(
            `only ${prices.answered} of ${prices.requested} app ids were priced; ` +
              'this run has nothing new to publish',
          ),
          { stage: 'prices' },
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

    // What GOG and the Microsoft Store charge, and the bank's rate, in every mode: each store
    // decides for itself whether it is due. After the Steam stages on purpose — nothing here can
    // fail the run or move a Steam price, and a run Steam has already failed spends no request on
    // another store.
    const offers: OffersResult = await stage('store prices', () =>
      refreshOffers(deps, games, storeRefs, published),
    )
    stores = { ...stores, gog: offers.gog, microsoft: offers.microsoft, rate: offers.rate }
    // A store that could not be read does not fail the run, so the run has to say so some other
    // way: the summary row is there for whoever opens it, and the annotation is on the run's
    // page for whoever does not.
    for (const warning of storeWarnings(stores)) deps.log(`::warning::${warning}`)

    // Last, over the final set of games — studio games included — so every id a list names is a
    // document of this version. The other modes carry the published lists forward with the
    // documents: their game set is the published one, so the lists still hold.
    //
    // An enrichment, so it cannot cost the run: a ranking that throws leaves every document
    // without a list — the page then asks the index by genre, and no list carried over from the
    // published version can name a game this one no longer holds — and says so, and the run
    // publishes what it collected.
    if (options.mode === 'full') {
      await stage('similar games', async () => {
        try {
          const started = performance.now()
          const { lists, median } = attachSimilar(games)
          deps.log(
            `similar games: ${lists} of ${games.length} games have a list, median length ${median}, ` +
              `in ${Math.round(performance.now() - started)} ms`,
          )
          tags = tagReport(games)
          deps.log(`tags: median ${tags.medianTags} per game`)
          deps.log(`tags, most frequent: ${tagList(tags.mostFrequent)}`)
          deps.log(`tags, rarest: ${tagList(tags.rarest)}`)
          similarWarning = similarHealthWarning(games)
        } catch (error) {
          for (const game of games) delete game.similar
          const reason = error instanceof Error ? error.message : String(error)
          similarWarning = `Similar lists not computed: ${reason}`
        }
        if (similarWarning) deps.log(`::warning::${similarWarning}`)
      })
    }

    const outcome = await stage('publish', () =>
      publishVersion(deps, {
        version: version!,
        games,
        candidateCount,
        pricesUpdatedAt,
        pricesFetched,
        languagesFetched,
        failures,
        durationMs: deps.clock.now() - startedAt,
        exchangeRate: offers.exchangeRate,
        offersReadAt: offers.offersReadAt,
      }),
    )

    return report({
      outcome,
      studios,
      stores,
      pricesFetched,
      languagesFetched,
      failures,
      similarWarning,
      tags,
    })
  } catch (error) {
    // Give the draft and the lock back before the failure leaves this function — but only a
    // version that was actually begun: nothing is discarded that does not exist. `discardVersion`
    // is allowed to fail too, because the original error is what the owner needs to see.
    if (version !== null) await deps.writer.discardVersion(version).catch(() => {})
    // What the run had already done goes out with the failure. The summary of a failed run is the
    // whole of the alert, and one full of zeroes says less than the run knew.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      report: report({
        studios,
        stores,
        pricesFetched,
        languagesFetched,
        failures,
        similarWarning,
        tags,
      }),
    })
  }
}

function tagList(tags: readonly [string, number][]): string {
  return tags.length > 0 ? tags.map(([tag, df]) => `${tag} (${df})`).join(', ') : 'none'
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : 'none'
}

/** The studio rows: what a full run found, kept and paid for, or what the others republished. */
function studioRows(report: JobReport): [string, string][] {
  const studios = report.studios
  if (!studios) {
    const published = report.outcome?.meta.stats?.madeInUkraineCount
    return published === undefined
      ? []
      : [['Studio games', `${published} made in Ukraine (not re-read in this mode)`]]
  }
  const rows: [string, string][] = [
    [
      'Studio games',
      `${studios.madeInUkraine} made in Ukraine (published version: ${
        studios.previousMadeInUkraine ?? 'none'
      }), ` +
        `${studios.appended} added beyond the popularity list, ` +
        `${studios.dropped} dropped by the bound, ` +
        `${studios.kept} kept from the published version, ` +
        `${plural(studios.failures, 'studio', 'studios')} failed; ` +
        `RAWG: ${plural(studios.listRequests, 'list request', 'list requests')}, ` +
        plural(studios.appIdLookups, 'app id lookup', 'app id lookups'),
    ],
  ]
  if (studios.expired > 0) {
    rows.push([
      'Studio games expired',
      `${studios.expired} games of unknown or empty studio slugs, not found for a week, were dropped`,
    ])
  }
  if (studios.degraded) {
    rows.push([
      'Studios stage',
      'degraded — under half the published games made in Ukraine were found, so every published flag was kept',
    ])
  }
  rows.push(
    ['Studios with no games', listOrNone(studios.studiosWithoutGames)],
    ['Studio slugs unknown to RAWG', listOrNone(studios.unknownSlugs)],
    ['Studio slugs with no games', listOrNone(studios.emptySlugs)],
  )
  return rows
}

/**
 * What is said of the offers a store lost in one run for want of a reference, or nothing when it
 * lost none (`StoreReadReport.dropped`).
 */
function droppedNote(dropped: number | undefined): string | null {
  if (!dropped) return null
  return dropped === 1
    ? '1 offer dropped because its game no longer has a store reference'
    : `${dropped} offers dropped because their games no longer have a store reference`
}

/** What a store's read is called in a warning, by what came of it. */
function readWarning(name: string, read: StoreReadReport): string[] {
  const reason = (otherwise: string) => (read.error ?? otherwise).replace(/\s+/g, ' ')
  const stands = 'every offer that was not read stands as it was'
  switch (read.status) {
    case 'failed':
      return [`${name} prices not refreshed: ${reason('a request failed')} — ${stands}`]
    case 'partial':
      return [`${name} prices refreshed only in part: ${reason('a request failed')} — ${stands}`]
    case 'references-lost':
      return [
        `${name} prices not refreshed: ${reason('the store references look lost')} — ` +
          'every offer is kept as it was and the store was not read',
      ]
    default:
      return []
  }
}

/**
 * The warnings one store is owed: what came of its read, if that is worth one, and — whatever
 * came of the read — that the mapping cost it at least `OFFER_FLOOR_MIN_CARRIED` offers in this
 * run. Under that count the summary's row says how many and no more: a reference is lost one
 * game at a time, and one game is no news.
 */
function storeWarning(name: string, read: StoreReadReport | null): string[] {
  if (!read) return []
  const dropped = (read.dropped ?? 0) >= OFFER_FLOOR_MIN_CARRIED ? droppedNote(read.dropped) : null
  return [...readWarning(name, read), ...(dropped ? [`${name}: ${dropped}`] : [])]
}

/**
 * The warnings a run owes about the stores other than Steam: one for each store whose read
 * failed or was only partial, one for each store whose references look lost, one for each store
 * that lost twenty offers or more because the mapping no longer names their games, and one when
 * the run ends with no exchange rate at all. Nothing for a store that was not due, or a rate kept
 * from the published version — those are the design working. Each is one line, written to the
 * log as a GitHub `::warning::` annotation, as the similar-lists warning is.
 *
 * They exist because a store that is down is, by design, invisible in the run's colour: the run
 * is green, the offers are yesterday's, and without an annotation the only trace is a row of a
 * summary nobody has a reason to open. A read that fails the same way on every run — a catalog
 * that changed its shape, a product count that is off by one for good — repeats the warning on
 * every run until somebody looks.
 */
export function storeWarnings(stores: StoresReport): string[] {
  return [
    ...storeWarning('GOG', stores.gog),
    ...storeWarning('Microsoft Store', stores.microsoft),
    ...(stores.rate?.status === 'none'
      ? [
          'No exchange rate: the National Bank could not be read and no rate under seven days ' +
            'old is left, so no hryvnia estimate is published',
        ]
      : []),
  ]
}

/** A value as one cell of the summary's table: on one line, and with no column of its own. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replaceAll('|', '/')
}

/**
 * One store's row: how many references, how many prices read, how many failed — and why — and,
 * whatever came of the read, how many offers went for want of a reference.
 */
function storeReadRow(name: string, read: StoreReadReport): [string, string] {
  const dropped = droppedNote(read.dropped)
  return [name, storeReadCell(read) + (dropped ? `; ${dropped}` : '')]
}

function storeReadCell(read: StoreReadReport): string {
  const references = plural(read.references, 'reference', 'references')
  const counts = `${references}, ${plural(read.pricesRead, 'price', 'prices')} read, ${read.failed} failed`
  const offers = plural(read.offers, 'offer', 'offers')
  const requests = plural(read.requests, 'request', 'requests')
  switch (read.status) {
    case 'no-references':
      return 'no references, nothing to read'
    case 'not-due':
      return (
        `${references}, not read: the last full read (${read.lastReadAt}) is under eleven hours ` +
        `old; ${offers} carried`
      )
    case 'read':
      return `${counts}; ${offers} published, ${requests}`
    case 'partial':
      return (
        `${counts} (${cell(read.error ?? 'a request failed')}); ${offers} published, ${requests}; ` +
        'the next run reads again'
      )
    case 'failed':
      return (
        `${counts} (${cell(read.error ?? 'the read failed')}); ${offers} kept as they were; ` +
        'the next run reads again'
      )
    case 'references-lost':
      return (
        `${references}, not read (${cell(read.error ?? 'the store references look lost')}); ` +
        `${offers} kept as they were; the next run looks again`
      )
  }
}

function rateRow(report: RateReport): [string, string] {
  const rate = report.rate
  if (report.status === 'read' && rate) {
    return ['Exchange rate', `${rate.uah} UAH per USD, the National Bank's for ${rate.date}`]
  }
  if (report.status === 'kept' && rate) {
    return [
      'Exchange rate',
      `not read; ${rate.uah} UAH per USD for ${rate.date} stands (read ${rate.readAt}, kept seven days)`,
    ]
  }
  return ['Exchange rate', 'not read, and no rate under seven days old is left: none published']
}

/** The rows about the stores other than Steam, as far as the run got with them. */
function storeRows(report: JobReport): [string, string][] {
  const stores = report.stores
  if (!stores) return []
  const { references } = stores
  const sweep = references.sweep
  const rows: [string, string][] = [
    [
      'Store references',
      `${references.listed} of ${references.games} games on GOG or the Xbox store at RAWG, ` +
        `${references.asked} asked; ${references.gog} with a GOG page, ` +
        `${references.microsoft} with a Microsoft Store product` +
        (sweep
          ? `; RAWG: ${plural(sweep.attempted, 'lookup', 'lookups')} this run, ${sweep.failures} failed, ` +
            `${sweep.remaining} left for the next full run` +
            (sweep.stopped === 'failures' ? ' (stopped early: too many failed)' : '') +
            (sweep.stopped === 'time' ? ' (stopped early: out of its twenty minutes)' : '')
          : ' (not looked up in this mode)'),
    ],
  ]
  if (stores.gog) rows.push(storeReadRow('GOG prices', stores.gog))
  if (stores.microsoft) rows.push(storeReadRow('Microsoft Store prices', stores.microsoft))
  if (stores.rate) rows.push(rateRow(stores.rate))
  return rows
}

/** What the run cost the index's store: the row before the last of every summary. */
function trafficRow(report: JobReport): [string, string] {
  return [
    'Index traffic',
    report.writes
      ? `${report.writes.requests} requests, ${report.writes.commands} commands, ${Math.round(
          report.writes.bytes / 1024,
        )} KiB`
      : 'not counted',
  ]
}

/** The rows as the Markdown table GitHub shows, under the summary's heading. */
function summaryTable(rows: [string, string][]): string[] {
  return [
    '## Index refresh',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${value} |`),
    '',
  ]
}

/** What to do about a lock another run still holds, under the table of a run that failed. */
const HELD_LOCK_HINT = [
  'If the run failed because another run still holds the writer lock, re-run the workflow',
  'with `force_unlock` set, or delete `idx:lock` in the Upstash console.',
  '',
]

const READING_ENDED: Record<ResolveReadingEnd, (report: ResolveReport) => string> = {
  pages: () => 'every page it was given was read',
  'list-end': () => `RAWG's list ended there`,
  'page-failed': (report) => `RAWG failed page ${report.failedPage}`,
  enough: () => 'the games already waiting needed every request that was left',
  budget: () => 'no request was left to read another with',
  time: () => 'the sixty minutes ran out',
}

const RESOLVE_STOPPED: Record<ResolveStop, (report: ResolveReport) => string> = {
  budget: () => 'the budget was spent',
  done: () => 'nobody was left to ask on the pages read',
  failures: (report) =>
    `RAWG was failing: ${report.failed} of ${report.asked} lookups failed, so the rest were not begun`,
  time: () => 'the run had used its sixty minutes',
}

/**
 * The rows of a resolve run: what it read, whom it left out and why, whom it asked and what came
 * of it, what that cost RAWG against the budget, and why it stopped.
 */
function resolveRows(resolved: ResolveReport): [string, string][] {
  const { skipped, requests } = resolved
  const reading = resolved.readingEnded
    ? `; the reading ended because ${READING_ENDED[resolved.readingEnded](resolved)}`
    : ''
  const span =
    resolved.lastPage === resolved.fromPage
      ? `page ${resolved.fromPage}`
      : `pages ${resolved.fromPage} to ${resolved.lastPage}`
  return [
    [
      'Pages read',
      (resolved.lastPage === null
        ? `none of at most ${resolved.pages} from page ${resolved.fromPage}`
        : `${resolved.pagesRead} of at most ${resolved.pages}: ${span}`) + reading,
    ],
    ['Games seen', String(resolved.seen)],
    [
      'Skipped',
      `${skipped.notReleased} not released, ${skipped.noStore} on none of the four stores, ` +
        `${skipped.known} already known` +
        (resolved.unreadable > 0
          ? `; ${plural(resolved.unreadable, 'entry', 'entries')} of a page could not be read as a game`
          : ''),
    ],
    ['Asked', `${resolved.asked}, ${resolved.failed} failed`],
    ['With a Steam page', String(resolved.steam)],
    ['With a GOG page', String(resolved.gog)],
    ['With a Microsoft Store product', String(resolved.microsoft)],
    [
      'RAWG requests',
      `${requests.total} of a budget of ${resolved.budget}: ` +
        `${plural(requests.pages, 'page', 'pages')}, ` +
        `${plural(requests.lookups, 'lookup', 'lookups')}, ` +
        `${plural(requests.retries, 'retry', 'retries')}; ` +
        'counted as they left for RAWG, so nothing sent is missing',
    ],
    [
      'Left unasked',
      `${resolved.unasked} of the games waiting on the pages read` +
        (resolved.firstUnaskedPage === null
          ? ''
          : `, the first of them on page ${resolved.firstUnaskedPage}`),
    ],
    [
      'Stopped',
      resolved.stopped
        ? `because ${RESOLVE_STOPPED[resolved.stopped](resolved)}`
        : 'by the failure above, not by itself',
    ],
    [
      'Next run',
      resolved.nextPage === null
        ? `nothing further to read: RAWG's list ended at page ${resolved.lastPage}`
        : `begin at page ${resolved.nextPage} (from_page=${resolved.nextPage})`,
    ],
  ]
}

/**
 * The summary of a resolve run. It has a table of its own because nothing in the other one
 * applies: there is no version, no price and no document to report, and the question a reader
 * comes with is what the run spent and what it learned for it.
 */
function formatResolveSummary(report: JobReport): string {
  const resolved = report.resolve ?? null
  const failed = report.error !== undefined || resolved === null
  const rows: [string, string][] = [['Mode', report.mode + (report.dryRun ? ' (dry run)' : '')]]
  if (failed) {
    rows.push(
      ['Result', `failed in ${report.failedStage ?? 'an unknown stage'}`],
      // On one line and in one cell: a refusal quotes what somebody typed into the form.
      ['Error', cell(report.error ?? 'unknown')],
    )
  } else {
    rows.push([
      'Result',
      `nothing published; the store pages of ${resolved.asked - resolved.failed} games were learned`,
    ])
  }
  if (resolved) rows.push(...resolveRows(resolved))
  rows.push(trafficRow(report), ['Duration', duration(report.durationMs)])
  return [...summaryTable(rows), ...(failed ? HELD_LOCK_HINT : [])].join('\n')
}

/** The Markdown GitHub shows on the run's summary page, for a run that reached a verdict. */
export function formatSummary(report: JobReport): string {
  if (report.mode === 'resolve') return formatResolveSummary(report)
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

  rows.push(...studioRows(report))
  rows.push(...storeRows(report))

  const similar = outcome?.meta.stats
  if (similar?.similarCount !== undefined) {
    rows.push([
      'Similar lists',
      `${similar.similarCount} games, median length ${similar.similarMedianLength ?? 0}` +
        (report.mode === 'full' ? '' : ' (carried forward, not recomputed in this mode)'),
    ])
  }
  if (report.tags) {
    rows.push(
      ['Tags per game', `median ${report.tags.medianTags}`],
      ['Most frequent tags', tagList(report.tags.mostFrequent)],
      ['Rarest tags', tagList(report.tags.rarest)],
    )
  }
  if (report.similarWarning) {
    const [title, detail] = report.similarWarning.split(': ', 2)
    rows.push([title!, detail ?? ''])
  }

  rows.push(trafficRow(report))
  rows.push(['Duration', duration(report.durationMs)])

  return [...summaryTable(rows), ...(outcome ? [] : HELD_LOCK_HINT)].join('\n')
}

export async function writeJobSummary(
  markdown: string,
  path = process.env.GITHUB_STEP_SUMMARY,
): Promise<void> {
  if (!path) return
  await appendFile(path, markdown, 'utf8')
}

/**
 * Whether the run did what its mode is for. A version published, for the three that publish; for
 * a resolve run, which publishes nothing, that it ran to its own end — whatever stopped it, RAWG
 * included, since RAWG is not allowed to fail it.
 */
function succeeded(report: JobReport): boolean {
  if (report.mode === 'resolve') return report.error === undefined && report.resolve != null
  return report.outcome?.published === true
}

/** What Upstash's client puts between its error and the whole request body it failed on. */
const UPSTASH_REQUEST_QUOTE = ', command was: '

/**
 * The names of the commands a quoted request body held — `MSET`, `MGET` — and nothing of their
 * arguments, or `null` when the quote is not a body of commands this adapter sends.
 */
function commandNames(quoted: string): string[] | null {
  let body: unknown
  try {
    body = JSON.parse(quoted)
  } catch {
    return null
  }
  if (!Array.isArray(body)) return null
  const commands: unknown[] = body.every(Array.isArray) ? body : [body]
  const names = commands.map((command) =>
    Array.isArray(command) ? String(command[0] ?? '').toUpperCase() : '',
  )
  if (names.length === 0 || names.some((name) => !/^[A-Z]{1,20}$/.test(name))) return null
  return [...new Set(names)]
}

/**
 * An error as the run may print it, in its log and in its summary.
 *
 * `@upstash/redis` answers a request the store refused with an error that ends in the whole
 * request: `ERR max request size exceeded, command was: [["MSET", …]]`. For a batch of store
 * references that is a hundred records with RAWG's links in them — third-party text the job
 * never prints — and the start of a runner command can survive in a link. So such a message is
 * cut to what the store said and the names of the commands the request held. Any other message
 * is printed as it always was.
 */
export function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const quote = message.indexOf(UPSTASH_REQUEST_QUOTE)
  if (quote < 0) return message
  const names = commandNames(message.slice(quote + UPSTASH_REQUEST_QUOTE.length))
  return oneLine(
    `${message.slice(0, quote)} (${names ? `request of ${names.join(', ')}` : 'request not quoted'})`,
  )
}

/**
 * 0 when a version was published — or, for a resolve run, when it ran to its end — and 1 for
 * anything else. The workflow's red/green comes from here.
 */
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
    // Every request the run sends RAWG is counted where it leaves, retries included.
    const rawgRequests = createRequestMeter()
    const deps: JobDeps = {
      rawg: createJobRawg({ apiKey, fixtures, clock, meter: rawgRequests }),
      rawgRequests,
      steam: createJobSteam({ apiKey, fixtures, clock }),
      gog: createJobGog({ fixtures, clock }),
      microsoft: createJobMicrosoft({ fixtures, clock }),
      bank: createJobBank({ fixtures, clock }),
      writer: fromEnv.writer,
      clock,
      log,
    }
    // A failed run is the one whose traffic is most worth knowing; the catch below has no `deps`.
    writerStats = () => fromEnv.writer.stats?.() ?? null

    await writeProbe(deps)
    report = { ...(await runJob(deps, options)), dryRun }
  } catch (error) {
    // The message only: an upstream error object can carry the request it failed on — and the
    // message itself is cut where Upstash's client quotes the request (`errorLine`).
    const message = errorLine(error)
    const named = error as { stage?: unknown; report?: JobReport; mode?: JobMode }
    console.error(message)
    const reached = named.report
    report = {
      // A refusal of the command line names its mode itself: nothing had been parsed to say it.
      mode: reached?.mode ?? named.mode ?? mode,
      dryRun,
      outcome: null,
      studios: reached?.studios ?? null,
      stores: reached?.stores ?? null,
      pricesFetched: reached?.pricesFetched ?? 0,
      languagesFetched: reached?.languagesFetched ?? 0,
      failures: reached?.failures ?? 0,
      durationMs: reached?.durationMs ?? 0,
      writes: reached?.writes ?? writerStats?.() ?? null,
      similarWarning: reached?.similarWarning ?? null,
      tags: reached?.tags ?? null,
      resolve: reached?.resolve ?? null,
      failedStage: typeof named.stage === 'string' ? named.stage : 'start-up',
      error: message,
    }
  }

  // A failed run is the alert; it is worth as much as a successful one, and more.
  const summary = formatSummary(report)
  await writeJobSummary(summary).catch(() => {})
  log(summary)
  return succeeded(report) ? 0 : 1
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
