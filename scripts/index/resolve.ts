import { APP_ID_BATCH_SIZE, steamAppIdFromLinks } from './appIds'
import {
  DEFAULT_CANDIDATE_PAGES,
  fetchCandidatePage,
  PAGES_PER_LOCK_RENEWAL,
  toIndexedGame,
  type RawgGamesPage,
} from './candidates'
import { isoNow, oneLine, type JobDeps } from './deps'
import type { RequestMeter } from './requestMeter'
import {
  isFailingWholesale,
  storeLinksOf,
  storeRecordFromLinks,
  usableStoreRefs,
} from './storeRefs'
import { OFFER_STORES, type IndexedStoreRefs } from '../../server/index/document'
import type { RawgGameListItem } from '../../server/rawg/types'
import type { STORE_OPTIONS } from '../../shared/catalog'

/**
 * `--mode=resolve`: learn the store pages of the next most popular games, inside a fixed number
 * of RAWG requests, and publish nothing.
 *
 * The index covers the top of RAWG's most-added order (`candidates.ts`). To price a game the job
 * needs its Steam app id and its references on the other stores, and RAWG gives those one game a
 * request (`games/{slug}/stores`). What is learned is kept for the life of the index
 * (`appid:{id}`, `storeref:{id}`), so it can be learned ahead of time: this mode reads the order
 * further down than the index goes and asks about the games it finds there, so that widening the
 * index later costs RAWG's quota nothing. It is run by hand, when there is quota to spare, and
 * told how much of it to spend.
 *
 * **The budget is a number of requests, counted where they leave** (`requestMeter.ts`): list
 * pages, lookups and the transport's own retries alike. The run sets it as a limit on the
 * transport before it asks anything, so nothing it does — no retry, no second ask for a page
 * that came back without a list — can send one request more. It also looks at what is left
 * before it starts a page or a lookup, which is how it stops in good order instead of on a
 * refusal.
 *
 * **Who is asked**, most popular first — the order of the pages, and of the games on a page:
 *
 * - a game that is out: RAWG's `released` is a day on or before the run's, and the game is not
 *   `tba`. A game with no date, a date to come or `tba` has no price to find yet;
 * - that RAWG lists on a store the job reads or is about to read (`RESOLVE_STORES`);
 * - and that nothing is known about: it has neither an `appid:` entry, of any value, nor a
 *   `storeref:` record. Either means a run has asked RAWG about it already.
 *
 * **Pages are read only while they can still be used.** A page costs a request, and the games on
 * it stand behind every game of the pages before it. So the reading stops as soon as the games
 * already waiting are as many as the requests that are left: another page could only take a
 * request from one of them. It stops, too, at the last page it was given, at the end of RAWG's
 * list, and at a page RAWG fails — after the transport's retry — which ends the reading and not
 * the run: the games of the pages before it are asked about.
 *
 * **What an answer leaves behind.** A store-reference record, always — the two references, the
 * marks of the stores the game is listed on and RAWG's links (`storeRecordFromLinks`) — and the
 * game's Steam app id when a link names one. The empty app id, "this game has no Steam page", is
 * written only for a game RAWG lists on Steam, which is all it has ever meant: written for a game
 * RAWG does not list there, it would stop the nightly run from asking on the day the game comes
 * to Steam (`resolveAppIds` skips a game it has an entry for). Such a game is known by its record
 * instead. A lookup that fails writes nothing, and the game is asked about by another run.
 *
 * **It cannot fail the run for RAWG's sake, and it cannot run on.** It stops when the budget is
 * spent, when nobody is left to ask, when RAWG is failing wholesale (`isFailingWholesale`, the
 * sweep's rule) or after `RESOLVE_BUDGET_MS` on the job's clock, whichever comes first. Whatever
 * it had learned by then is written: it is quota already spent.
 *
 * Nothing here publishes. The stage reads two mappings and writes two mappings, both outside any
 * version; `run.ts` holds the writer's lock around it and gives it back without a version having
 * been written.
 */

/** The most requests one run may be given. A whole period of RAWG's free plan is 20 000. */
export const RESOLVE_MAX_BUDGET = 8000

/** The first page read when none is named: the pages before it are the nightly run's. */
export const RESOLVE_DEFAULT_FROM_PAGE = DEFAULT_CANDIDATE_PAGES + 1

/** The most pages read when no number is given. */
export const RESOLVE_DEFAULT_PAGES = 250

/**
 * How long the run may take, reading and asking together: sixty minutes on the job's clock. A
 * RAWG that answers every request, slowly, trips neither the budget nor the failure rule, and
 * the workflow's own ceiling ends a run without a summary and with its lock held.
 */
export const RESOLVE_BUDGET_MS = 60 * 60_000

type CatalogStoreSlug = (typeof STORE_OPTIONS)[number]['slug']

/**
 * The stores a game has to be listed on, one of them, to be asked about: the three the job reads
 * — Steam, and the two of `OFFER_STORES` — and the PlayStation Store, which it is about to. The
 * slugs are the catalog's (`STORE_OPTIONS`), which are the ones a document's `stores` carries
 * (`toIndexedGame`); the type holds them to it.
 */
export const RESOLVE_STORES = [
  'steam',
  ...OFFER_STORES,
  'playstation-store',
] as const satisfies readonly CatalogStoreSlug[]

export interface ResolveOptions {
  /** The most RAWG requests the run may send, of any kind, retries included. */
  budget: number
  /** The first page of the most-added order to read. */
  fromPage: number
  /** The most pages to read from there. */
  pages: number
  /** How many answers to accumulate before one round of writes; `APP_ID_BATCH_SIZE` when omitted. */
  batchSize?: number
}

/** Why the run stopped asking. */
export type ResolveStop =
  /** Every request it was given has been sent. */
  | 'budget'
  /** Every game waiting on the pages it read has been asked about. */
  | 'done'
  /** Too many lookups failed: RAWG is refusing, and the rest would fail too. */
  | 'failures'
  /** Its sixty minutes ran out: RAWG is answering, slowly. */
  | 'time'

/** Why the run stopped reading pages. */
export type ResolveReadingEnd =
  /** It read every page it was given. */
  | 'pages'
  /** RAWG's list has no page after the last one read. */
  | 'list-end'
  /** RAWG failed a page, after the transport's retry. */
  | 'page-failed'
  /** The games already waiting needed every request that was left. */
  | 'enough'
  /** No request was left to read a page with. */
  | 'budget'
  /** The run's sixty minutes ran out while it was still reading. */
  | 'time'

/** What a resolve run did, for its summary. */
export interface ResolveReport {
  budget: number
  fromPage: number
  /** The most pages it was given to read. */
  pages: number
  pagesRead: number
  /** The last page read, or `null` when none was. */
  lastPage: number | null
  /** The page RAWG failed, when that is what ended the reading. */
  failedPage: number | null
  /** `null` only in the report of a run that failed before it had finished reading. */
  readingEnded: ResolveReadingEnd | null
  /** Games on the pages read, each counted once. */
  seen: number
  /** Games not asked about, each under the first rule that left it out, in this order. */
  skipped: { notReleased: number; noStore: number; known: number }
  /**
   * Entries of a page that could not be read as a game — no id, no slug, or a shape the card
   * mapping cannot take. Skipped and counted: one bad entry costs that entry, not the run.
   */
  unreadable: number
  /** Games asked about: lookups begun, whatever came of them. */
  asked: number
  /** Of the games RAWG answered for: those with a Steam app id, a GOG page, a Microsoft product. */
  steam: number
  gog: number
  microsoft: number
  /** Games RAWG would not answer for. Nothing is written about them. */
  failed: number
  /**
   * RAWG requests sent, as the transport's meter counted them. `pages` and `lookups` are the
   * first request of each page and of each game; `retries` is every request after it for the
   * same page or game — the transport's retry of a timeout or a 5xx, and the second ask for a
   * page that came back without a list. `total` is the three together, and is what the budget
   * is held against.
   */
  requests: { pages: number; lookups: number; retries: number; total: number }
  /** Games waiting on the pages read that were not asked about. */
  unasked: number
  /**
   * The page the first of them is on, or `null` when none was left: where a later run can begin
   * without reading again the pages this one has finished with.
   */
  firstUnaskedPage: number | null
  /** `null` only in the report of a run that failed before it stopped by itself. */
  stopped: ResolveStop | null
  /**
   * The page a follow-up run should begin at (`from_page`): the page of the first game left
   * unasked, else the page after the last one read — which is the page RAWG failed, when one
   * ended the reading. `null` when RAWG's list ended and nobody on it was left: there is nothing
   * further down to read.
   */
  nextPage: number | null
}

/** Where a follow-up run should begin, by the rule `ResolveReport.nextPage` gives. */
function nextPageOf(report: ResolveReport): number | null {
  if (report.firstUnaskedPage !== null) return report.firstUnaskedPage
  if (report.readingEnded === 'list-end') return null
  return report.lastPage === null ? report.fromPage : report.lastPage + 1
}

/**
 * Refuses a run it cannot keep inside a budget: no budget, one that is not a positive whole
 * number, or one above `RESOLVE_MAX_BUDGET`; and a first page or a page count that is not one.
 * Checked on the command line (`parseArgs`) and again here, because a run is started by code as
 * well as by a person, and this is the one mode in which a wrong number is spent quota.
 */
export function assertResolveOptions(options: {
  budget?: number
  fromPage?: number
  pages?: number
}): asserts options is ResolveOptions {
  const { budget, fromPage, pages } = options
  if (budget === undefined) {
    throw new Error(
      '--mode=resolve needs a budget: the most RAWG requests the run may send ' +
        `(--budget=N, at most ${RESOLVE_MAX_BUDGET}).`,
    )
  }
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`--budget must be a positive whole number, got ${budget}.`)
  }
  if (budget > RESOLVE_MAX_BUDGET) {
    throw new Error(
      `--budget=${budget} is above the most one run may be given (${RESOLVE_MAX_BUDGET}).`,
    )
  }
  if (fromPage === undefined || !Number.isSafeInteger(fromPage) || fromPage < 1) {
    throw new Error(`--from-page must be a positive whole number, got ${fromPage}.`)
  }
  if (pages === undefined || !Number.isSafeInteger(pages) || pages < 1) {
    throw new Error(`--pages must be a positive whole number, got ${pages}.`)
  }
}

/**
 * The meter of the run's RAWG transport, without which the mode does not start: a budget nobody
 * counts is no budget. `runCli` always builds one; a caller that hands in a transport of its own
 * has to hand in the meter that transport reports to.
 */
export function requestMeterOf(deps: Pick<JobDeps, 'rawgRequests'>): RequestMeter {
  if (!deps.rawgRequests) {
    throw new Error(
      '--mode=resolve cannot run without the RAWG request meter: nothing else can hold it to its budget.',
    )
  }
  return deps.rawgRequests
}

/** A day as RAWG and the job's clock both write one. Two of them compare as text. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a game is out on `today` (`YYYY-MM-DD`): RAWG gives it a release day, that day has
 * come, and the game is not marked "to be announced". The mark is read as well as the date: a
 * game still to be announced has no price to find, whatever date stands beside the mark.
 */
export function isReleased(
  game: Pick<RawgGameListItem, 'released' | 'tba'>,
  today: string,
): boolean {
  if (game.tba === true) return false
  const released = game.released
  return typeof released === 'string' && ISO_DAY.test(released) && released <= today
}

/** What the run keeps of a game it means to ask about. */
interface Waiting {
  id: number
  slug: string
  stores: string[]
  /** The page of the order the game was on. */
  page: number
}

export async function resolveMoreGames(
  deps: JobDeps,
  options: ResolveOptions,
): Promise<ResolveReport> {
  assertResolveOptions(options)
  const meter = requestMeterOf(deps)
  const { budget, fromPage, pages } = options
  const batchSize = options.batchSize ?? APP_ID_BATCH_SIZE

  // Before anything is asked: from here the transport itself sends `budget` requests and no more.
  meter.limitTo(budget)
  const issuedBefore = meter.issued()
  const startedAt = deps.clock.now()
  const today = isoNow(deps.clock).slice(0, 10)
  const outOfTime = () => deps.clock.now() - startedAt >= RESOLVE_BUDGET_MS

  const report: ResolveReport = {
    budget,
    fromPage,
    pages,
    pagesRead: 0,
    lastPage: null,
    failedPage: null,
    readingEnded: null,
    seen: 0,
    skipped: { notReleased: 0, noStore: 0, known: 0 },
    unreadable: 0,
    asked: 0,
    steam: 0,
    gog: 0,
    microsoft: 0,
    failed: 0,
    requests: { pages: 0, lookups: 0, retries: 0, total: 0 },
    unasked: 0,
    firstUnaskedPage: null,
    stopped: null,
    nextPage: null,
  }

  /** The games to ask about, most popular first. */
  const waiting: Waiting[] = []
  /** The report as it stands: what the summary of a run that fails here is made of. */
  const snapshot = (): ResolveReport => {
    const now: ResolveReport = {
      ...report,
      skipped: { ...report.skipped },
      requests: { ...report.requests, total: meter.issued() - issuedBefore },
      // Asked in order, so whoever was not asked is the tail of the list.
      unasked: Math.max(0, waiting.length - report.asked),
      firstUnaskedPage: waiting[report.asked]?.page ?? null,
    }
    return { ...now, nextPage: nextPageOf(now) }
  }

  /**
   * Runs one page read or one lookup and files what it sent: its first request under its kind,
   * and every request after that as a retry. The meter is read on either side of the call, so
   * the split is of what was sent, and a call the transport's cache answered counts as nothing.
   */
  async function spend<T>(kind: 'pages' | 'lookups', call: () => Promise<T>): Promise<T> {
    const before = meter.issued()
    try {
      return await call()
    } finally {
      const sent = meter.issued() - before
      if (sent > 0) {
        report.requests[kind] += 1
        report.requests.retries += sent - 1
      }
    }
  }

  try {
    /** Games that pass the rules a page can answer, not yet looked up in the two mappings. */
    let unchecked: Waiting[] = []
    const seen = new Set<number>()

    /**
     * Moves the games nothing is known about from `unchecked` to `waiting`, in their order. Two
     * reads of the index, however many games — which is why it is done when the answer is
     * needed and not a page at a time.
     */
    async function settle(): Promise<void> {
      if (unchecked.length === 0) return
      const ids = unchecked.map((game) => game.id)
      const appIds = await deps.writer.getAppIds(ids)
      const refs = await deps.writer.getStoreRefs(ids)
      for (const game of unchecked) {
        if (appIds.has(game.id) || refs.has(game.id)) report.skipped.known += 1
        else waiting.push(game)
      }
      unchecked = []
    }

    let readingEnded: ResolveReadingEnd = 'pages'
    for (let page = fromPage; page < fromPage + pages; page += 1) {
      if (meter.remaining() === 0) {
        readingEnded = 'budget'
        break
      }
      // A page is worth its request only while a request could still go to a game on it. Once
      // the games ahead of it are as many as the requests left, it is not read. The mappings are
      // consulted only when the count could have got there.
      if (waiting.length + unchecked.length >= meter.remaining()) {
        await settle()
        if (waiting.length >= meter.remaining()) {
          readingEnded = 'enough'
          break
        }
      }
      if (outOfTime()) {
        readingEnded = 'time'
        break
      }

      const refusedBefore = meter.refused()
      let response: RawgGamesPage
      try {
        response = await spend('pages', () => fetchCandidatePage(deps, page))
      } catch {
        if (meter.refused() > refusedBefore) {
          // Not RAWG's failure alone: the page needed a request the budget did not have.
          readingEnded = 'budget'
        } else {
          readingEnded = 'page-failed'
          report.failedPage = page
          deps.log(`resolve: page ${page} could not be read; the reading ends there`)
        }
        break
      }
      report.pagesRead += 1
      report.lastPage = page

      for (const raw of response.results) {
        // The pages are paid for by now, and these are games no run has mapped before: an entry
        // the card mapping chokes on — a `null` among its tags — is skipped and counted, and the
        // run goes on with the others.
        let game: ReturnType<typeof toIndexedGame>
        try {
          game = toIndexedGame(raw)
        } catch {
          game = null
        }
        if (!game) {
          report.unreadable += 1
          continue
        }
        // RAWG's pages shift under a run, so the same game can arrive twice.
        if (seen.has(game.id)) continue
        seen.add(game.id)
        report.seen += 1
        if (!isReleased(raw, today)) report.skipped.notReleased += 1
        else if (!RESOLVE_STORES.some((store) => game.stores.includes(store))) {
          report.skipped.noStore += 1
        } else unchecked.push({ id: game.id, slug: game.slug, stores: game.stores, page })
      }

      if (report.pagesRead % PAGES_PER_LOCK_RENEWAL === 0) await deps.writer.renewLock()
      if (!response.next) {
        readingEnded = 'list-end'
        break
      }
    }
    await settle()
    report.readingEnded = readingEnded

    let appIds: [number, string][] = []
    let records: [number, IndexedStoreRefs][] = []

    async function flush(): Promise<void> {
      // The records first. A run cut off between the two writes leaves games with a record and
      // no app id: this mode does not ask about them again, and the app-id stage does when they
      // reach the index, so nothing is lost for good. The other way round they would be known
      // by an app id alone, and their links would be gone with nobody left to ask for them.
      if (records.length > 0) await deps.writer.setStoreRefs(records)
      records = []
      if (appIds.length > 0) await deps.writer.setAppIds(appIds)
      appIds = []
      // A batch is the longest stretch between two signs of life the lock is given here.
      await deps.writer.renewLock()
    }

    let stopped: ResolveStop | null = null
    try {
      for (const game of waiting) {
        // Looked at before a lookup is started, never in the middle of one.
        if (meter.remaining() === 0) {
          stopped = 'budget'
          break
        }
        if (outOfTime()) {
          stopped = 'time'
          break
        }
        report.asked += 1
        const refusedBefore = meter.refused()
        try {
          // By slug, as the app-id stage asks, and for the reason it gives.
          const links = storeLinksOf(
            await spend('lookups', () => deps.rawg(`games/${game.slug}/stores`)),
          )
          // An answer that is no list of links says nothing about the game: remembered, it
          // would be "no Steam page, no link to read" for good.
          if (!links) throw new Error('RAWG answered without a list of store links')

          const appId = steamAppIdFromLinks(links)
          const record = storeRecordFromLinks(links, game.stores)
          // Always a record: it is what says the game has been asked about, whatever else is
          // written. The empty app id only for a game RAWG lists on Steam (see the file's note).
          records.push([game.id, record])
          if (appId !== '' || game.stores.includes('steam')) appIds.push([game.id, appId])

          const usable = usableStoreRefs(record)
          if (appId !== '') report.steam += 1
          if (usable.gog) report.gog += 1
          if (usable.microsoft) report.microsoft += 1
        } catch {
          report.failed += 1
          deps.log(`resolve: ${oneLine(game.slug)} could not be read, leaving it for another run`)
          // The lookup's last request failed and its retry was refused at the limit: the budget
          // ended the run here, and that is what it says — not that RAWG is failing.
          if (meter.refused() > refusedBefore) {
            stopped = 'budget'
            break
          }
          if (isFailingWholesale(report.failed, report.asked)) {
            stopped = 'failures'
            break
          }
        }
        if (report.asked % batchSize === 0) await flush()
      }
    } finally {
      // Whatever was learned before the run stopped is quota already spent, and worth keeping.
      await flush()
    }
    // The list ran out before anything stopped the asking. Nobody is left to ask — unless that
    // is only because the reading was cut short by the budget or by the clock, which is then
    // the reason worth giving: there is more to do, and a run with more of either would do it.
    report.stopped =
      stopped ?? (meter.remaining() === 0 ? 'budget' : readingEnded === 'time' ? 'time' : 'done')

    const result = snapshot()
    deps.log(
      `resolve: ${result.asked - result.failed} games read, ${result.failed} failed, ` +
        `${result.unasked} left unasked; ${result.requests.total} of ${budget} RAWG requests sent`,
    )
    return result
  } catch (error) {
    // The index failing, not RAWG. What the run had done goes out with the failure: how much
    // quota it had spent is the first thing whoever reads the summary needs to know.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      resolve: snapshot(),
    })
  }
}

/**
 * The warnings a resolve run owes: one when it stopped because RAWG was failing its lookups, and
 * one when RAWG failed a page and so cut the reading short. Nothing RAWG does turns this run
 * red, so the annotation is how a run that did less than it was given to do says so on the run's
 * page, where the summary's rows are a click further away.
 */
export function resolveWarnings(report: ResolveReport): string[] {
  const spent = `${report.requests.total} of ${report.budget} requests were sent`
  return [
    ...(report.readingEnded === 'page-failed'
      ? [
          `Resolve read ${report.pagesRead} of at most ${report.pages} pages: RAWG failed page ` +
            `${report.failedPage}, and the reading ended there; ${spent}`,
        ]
      : []),
    ...(report.stopped === 'failures'
      ? [
          `Resolve stopped early because RAWG was failing: ${report.failed} of ${report.asked} ` +
            `lookups failed and ${report.unasked} games were left unasked; ${spent}`,
        ]
      : []),
  ]
}
