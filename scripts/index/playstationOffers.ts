import { isoNow, type JobDeps } from './deps'
import {
  countOffers,
  createLockKeeper,
  OFFER_FLOOR_MIN_CARRIED,
  OFFER_FLOOR_RATIO,
  setOffer,
  titled,
  type ReferenceVerdict,
} from './offers'
import {
  PLAYSTATION_REQUESTS_PER_RUN,
  PlaystationStopped,
  type PlaystationProduct,
  type PlaystationStopReport,
} from './playstation'
import { JOB_TIMESTAMP, usableStoreRefs, type StoreRefMap } from './storeRefs'
import { reasonOf } from './storeUpstream'
import type { IndexedGame, IndexedOffer, IndexedStoreRefs } from '../../server/index/document'
import { PLAYSTATION_OFFER_FRESH_FOR_MS } from '../../server/index/offerRules'

/**
 * The stage that reads what the PlayStation Store charges in Ukraine and puts it on the documents
 * of the version being built. It comes after the stage for the other stores (`offers.ts`), and it
 * is nothing like that one in pace: Sony is asked about one game a request, ten seconds apart, a
 * couple of hundred times a run at the most (`playstation.ts`).
 *
 * **A run that asks maps and prices, in that order of need.** Prices runs and the nightly full
 * run alike (a languages run asks nothing):
 *
 * 1. **The prices that are due**, for the games whose title Sony has named a concept for: the
 *    concept asked about longest ago first, and one never asked about before any other.
 * 2. **Then the titles waiting for a concept**, at most `PLAYSTATION_MAPPINGS_PER_RUN` a run and
 *    only with what the run's requests leave — and a title Sony has just named a concept for is
 *    priced right after, in the same run, at the same ten seconds, so that a game mapped at night
 *    has its price that night and not twenty hours later.
 *
 * The prices come first because they are what a page shows; the mappings take what is left. A
 * nightly run asks at most `PLAYSTATION_NIGHT_REQUESTS`, as it did when it only mapped, so a day
 * is still at most four prices runs of 225 and one night of 200: 1 100 requests.
 *
 * Every kind of run still reports the store: how many games have a title, a concept and an
 * offer, how old the oldest price is, and what the rule about references cost.
 *
 * **Each question is put once a day, by the date of its asking**: `mappedAt` on the game's
 * reference for which concept its title belongs to, `askedAt` for what that concept costs. The
 * date is written to the permanent mapping *before* the request leaves, whatever comes of it — a
 * price, no price, a failure, a refusal — and a question put in the last twenty hours is not put
 * again (`PLAYSTATION_REREAD_AFTER_MS`). The two are separate: mapping a title does not keep its
 * concept from being priced right after.
 * That is what the conditions the store is read on come to for one game, and it is why the date
 * is not the offer's: an offer is dated in a document that is published forty minutes later, or
 * not at all, and a game whose request failed has no new date there to show. So a run that does
 * not publish, and a game Sony fails for every time, are each asked about once a day and no more.
 *
 * **One concept, one request.** RAWG files editions, remasters and standalone parts as games of
 * their own, and Sony gathers them in one concept: the games that share a concept are asked about
 * once, and all of them are given the answer. Two games that link one title are mapped once.
 *
 * **What an answer does to an offer.**
 *
 * - a price anyone can pay — today's offer, under today's date, for every game of the concept;
 * - an answer with no such price, or with no product — the offers those games had are removed;
 * - a request that failed, or was never made — the offers and their dates stay exactly as they
 *   were. Nothing is asked twice in a run.
 *
 * **And the answers are believed only so far.** A change of shape on Sony's side is answered by
 * every request, in a run that ends green. So a run that would take away most of the offers it
 * asked about takes none (`removalsNotBelieved`), a run that asked about twenty games and found a
 * price for none removes nothing either (`nothingPriced`), and a run in which most titles are
 * said to have no concept remembers none of those answers (`noConceptNotBelieved`). Each is the
 * floor the other stores' reads stand on, measured on what one run asked.
 *
 * **A run that is going to be refused publication asks nothing.** Whether a version will be
 * refused is known before the stage starts (`publicationRefusal`), and a ration spent for a
 * version nobody will see is a ration spent for nothing.
 *
 * **After a refusal, a day of silence.** When Sony refuses a request — a 403, a 429, a page where
 * data was expected — the moment is written beside the job's cursors
 * (`PLAYSTATION_REFUSED_CURSOR`), where it outlives the run and its version, and no run of any
 * kind asks Sony anything until `PLAYSTATION_SILENCE_MS` have passed since. The run that was
 * refused says so in a warning, once; the runs that keep silent say it in their row. A refusal is
 * Sony saying no, and knocking again every six hours is not taking that for an answer.
 *
 * **Nothing here can cost the run.** A request that fails is one game left as it was. Sony
 * refusing, or failing three times in a row, ends the stage and not the run, and says so in a
 * warning (`run.ts`). Only the index failing — a lock that will not renew, a reference that will
 * not be written — is thrown, as it is everywhere; and since a reference is written before its
 * request, an index that is down stops the asking at once.
 */

const STORE = 'playstation-store'

/**
 * A question is put again once it was last put this long ago: twenty hours, so once a day. The
 * price and the mapping each by their own date (`askedAt`, `mappedAt`).
 */
export const PLAYSTATION_REREAD_AFTER_MS = 20 * 3_600_000

/**
 * The most titles one run asks Sony to name a concept for: two hundred. They come after the
 * prices that are due, and take only what the run's requests leave; each title mapped is priced
 * right after. The transport's own limits — 225 requests and forty minutes a run
 * (`playstation.ts`) — and a night's `PLAYSTATION_NIGHT_REQUESTS` bound a run whatever this number
 * says.
 */
export const PLAYSTATION_MAPPINGS_PER_RUN = 200

/**
 * How long "Sony has no concept for this title" stands before the title is asked about again:
 * thirty days. A title can come to the store later — a re-release under the same id, a region
 * that opens — and an answer kept for ever would be an answer nobody could take back without
 * editing the mapping by hand.
 */
export const PLAYSTATION_NO_CONCEPT_KEPT_MS = 30 * 86_400_000

/** After Sony refuses a request, no run asks it anything for this long: a day. */
export const PLAYSTATION_SILENCE_MS = 24 * 3_600_000

/**
 * The key, beside the job's cursors, that holds the moment Sony last refused a request. Not the
 * published metadata: a run that is refused may publish nothing, and the next run has to know all
 * the same. Cleared by the first run that finds the day has passed.
 */
export const PLAYSTATION_REFUSED_CURSOR = 'playstation-refused'

/**
 * How long an offer of this store is a price on the site: forty-eight hours. It is the site's own
 * rule (`PLAYSTATION_OFFER_FRESH_FOR_MS`, `server/index/offerRules.ts`) and not a copy of it, for
 * the one thing the job does with it: saying when prices are about to stop being shown.
 */
export const PLAYSTATION_PRICE_SHOWN_MS = PLAYSTATION_OFFER_FRESH_FOR_MS

/**
 * A prices run that ends with a shown price older than this says so in a warning: forty hours,
 * eight short of the moment the price stops being shown, which is one more prices run.
 */
export const PLAYSTATION_PRICE_OLD_MS = 40 * 3_600_000

/**
 * The most prices read in a day: four prices runs (`.github/workflows/index-refresh.yml`) of the
 * transport's requests each. With more concepts than this a game is read less than once a day.
 */
export const PLAYSTATION_PRICE_READS_A_DAY = 4 * PLAYSTATION_REQUESTS_PER_RUN

/**
 * The most requests a nightly full run makes to Sony, prices and mappings together: two hundred,
 * the night's ration from when that run only mapped. The prices runs have the transport's own
 * 225. So a day is at most 4 × 225 + 200 = 1 100 requests, as it was.
 */
export const PLAYSTATION_NIGHT_REQUESTS = 200

/** What a run asks Sony, by its kind: see the module's note. */
export type PlaystationAsks = 'both' | 'nothing'

export interface PlaystationStageOptions {
  asks: PlaystationAsks
  /**
   * The most requests this stage may make; the transport's `PLAYSTATION_REQUESTS_PER_RUN` when
   * left out. It can only lower the transport's cap, never raise it.
   */
  limit?: number
  /** Why the run's version is going to be refused publication, or `null` when it is not. */
  refusal?: string | null
}

export type PlaystationReadStatus =
  /** The stage asked what this kind of run asks, as far as the ration went, and believed it. */
  | 'read'
  /** The answers were not believed: too many removals, no price at all, or too many "no concept". */
  | 'failed'
  /** This kind of run asks Sony nothing. */
  | 'not-in-this-run'
  /** The run's version is going to be refused publication, so nothing was asked. */
  | 'run-refused'
  /** Sony refused a request less than a day ago, so nothing was asked (`refusedAt`). */
  | 'silent'
  /** The mapping names no PlayStation title for any game of the run; no request was made. */
  | 'no-references'
  /**
   * The mapping has forgotten most of the games that carry an offer of this store, and is not
   * believed: no request was made and no offer was dropped.
   */
  | 'references-lost'

/** What the stage came to, for the log and the job summary. */
export interface PlaystationReport {
  status: PlaystationReadStatus
  /** What this kind of run asks Sony. */
  asks: PlaystationAsks
  /** Games of the run the mapping names a PlayStation title for. */
  references: number
  /** Of them, games whose title Sony has named a concept for — after this run. */
  mapped: number
  /** Of them, games Sony has said it has no concept for — after this run. */
  withoutConcept: number
  /** Of them, games Sony has not answered about yet — after this run. */
  unmapped: number
  /**
   * Games whose price was due when the stage began; the titles waiting to be mapped are
   * `mappingsDue`.
   */
  due: number
  /** Games this run's reads gave a price: those that were due, and those mapped this run. */
  pricesRead: number
  /** Games whose title Sony answered about in this run, with a concept or with none. */
  mappingsRead: number
  /** Of them, games whose title Sony said has no concept. */
  noConcept: number
  /** Games whose title was waiting for a concept when the stage began. */
  mappingsDue: number
  /** Of the games mapped to a concept this run, those whose price was read this run too. */
  pricedAfterMapping: number
  /** Offers this run took away because Sony answered with no price anyone can pay. */
  removed: number
  /** Requests of either kind that failed; their games are as they were. */
  failed: number
  /** Requests this run made to Sony, whatever came of them. */
  requests: number
  /** The most requests this run's stage could make (`PlaystationStageOptions.limit`). */
  limit: number
  /** Concepts those titles belong to — after this run. One concept is one price to read. */
  concepts: number
  /** Games the run publishes with an offer of this store, read now or carried. */
  offers: number
  /**
   * How long ago the oldest of those offers was read, when the stage ended; `null` when there is
   * none. With more concepts than a day's price reads, a game is read less than once a day, and
   * this is the number that shows it before an offer is too old for a page to quote.
   */
  oldestPriceAgeMs: number | null
  /**
   * The same of the offers the site still shows as prices, those read no more than
   * `PLAYSTATION_PRICE_SHOWN_MS` ago; `null` when there is none. An offer that has already gone
   * stale — a game Sony fails for, day after day — says nothing of how near the others are.
   */
  oldestShownPriceAgeMs: number | null
  /**
   * Why the stage stopped asking: out of its requests or its time while games were still
   * waiting, or — whatever was still waiting — refused by Sony, or failed three times in a row.
   * `null` when it asked about everything that was due.
   */
  stopped: PlaystationStopReport | null
  /**
   * When Sony refused a request: in this run, or within the day before it, which is why this run
   * asked nothing (`status: 'silent'`). Left out when there is no refusal to keep silent after.
   */
  refusedAt?: string
  /** Until when no run asks Sony anything: a day after `refusedAt`. */
  silentUntil?: string
  /**
   * Titles that were due and that the night's `PLAYSTATION_MAPPINGS_PER_RUN` left for another
   * night. Left out when there were none.
   */
  heldOver?: number
  /**
   * Games that arrived with an offer of this store and lost it in this run for want of a
   * reference, the mapping being believed (`refreshOffers`). Left out when there were none.
   */
  dropped?: number
  /** What a floor saw of the run's answers, what the mapping looks like, or why nothing was asked. */
  error?: string
}

type PlaystationRef = NonNullable<IndexedStoreRefs['playstation']>

/** A game of the run with a PlayStation title, and what its reference says at this moment. */
interface Referenced {
  game: IndexedGame
  ref: PlaystationRef
}

/** Games that are one question to Sony: they share a concept, or a title. */
interface Question {
  games: Referenced[]
  /** When any of them was last asked about, or `null` when none ever was. */
  at: number | null
}

/**
 * Why a run's removals are not believed, or `null` when they are: the run heard about at least
 * `OFFER_FLOOR_MIN_CARRIED` games that carried an offer, and more than half of those answers
 * would take the offer away (`OFFER_FLOOR_RATIO`). The reason says what was seen, in the two
 * numbers that decide it.
 *
 * It is the other stores' floor (`belowOfferFloor`) for a store that is never read in full: what
 * is weighed is what this one run asked, not what the documents carry, because that is all a run
 * hears about. Real churn in a day is a handful of delistings; most of a run's games losing their
 * price together is this job misreading Sony.
 */
export function removalsNotBelieved(asked: number, removals: number): string | null {
  if (asked < OFFER_FLOOR_MIN_CARRIED || removals <= asked * OFFER_FLOOR_RATIO) return null
  return (
    `asked about ${asked} games that carried an offer and ${removals} of the answers would ` +
    'remove it: over half, so the answers are not believed and no offer is removed'
  )
}

/**
 * Why a run that priced nothing is not believed, or `null` when it is: it heard about at least
 * `OFFER_FLOOR_MIN_CARRIED` games and not one answer was a price anyone can pay. The floor above
 * weighs the games that carried an offer, and in the store's first days none does: a run could
 * then read two hundred answers, understand none, and end green without a word.
 */
export function nothingPriced(asked: number, priced: number): string | null {
  if (asked < OFFER_FLOOR_MIN_CARRIED || priced > 0) return null
  return (
    `asked about ${asked} games and not one of the answers is a price anyone can pay, ` +
    'so the answers are not believed and no offer is removed'
  )
}

/**
 * Why a night's answers of "no concept" are not believed, or `null` when they are: Sony answered
 * about at least `OFFER_FLOOR_MIN_CARRIED` titles, and more than half of the answers say the
 * title has none (`OFFER_FLOOR_RATIO`). Of the titles RAWG links, about two in three have a
 * concept; most of a night's titles having none is the catalog answering something else than it
 * used to, and an answer that stands for thirty days is not written on the strength of that.
 */
export function noConceptNotBelieved(answered: number, none: number): string | null {
  if (answered < OFFER_FLOOR_MIN_CARRIED || none <= answered * OFFER_FLOOR_RATIO) return null
  return (
    `asked about ${answered} titles and ${none} of the answers say the title has no concept: ` +
    'over half, so the answers are not believed and none of them is remembered'
  )
}

function offerOf(game: IndexedGame): IndexedOffer | undefined {
  return game.offers?.find((offer) => offer.store === STORE)
}

/** A date on a reference as a moment, or `null` when there is none that can be read. */
function momentOf(iso: string | undefined): number | null {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/** When Sony was last asked what the game's concept costs, or `null`. */
const pricedAtOf = (ref: PlaystationRef): number | null => momentOf(ref.askedAt)

/** When Sony was last asked which concept the game's title belongs to, or `null`. */
const mappedAtOf = (ref: PlaystationRef): number | null => momentOf(ref.mappedAt)

/** The more popular game first, and the lower id between two as popular: an order that is one order. */
function byPopularity(left: IndexedGame, right: IndexedGame): number {
  return right.popularity - left.popularity || left.id - right.id
}

/**
 * The games gathered into the questions they are, by what the question is about: the games of
 * one concept are one price to read, and the games of one title are one title to map. A question
 * was last put when any of its games was last asked it (`stampOf`: the price's date, or the
 * mapping's).
 */
function questionsOf(
  games: readonly Referenced[],
  key: (ref: PlaystationRef) => string | number,
  stampOf: (ref: PlaystationRef) => number | null,
): Question[] {
  const byKey = new Map<string | number, Referenced[]>()
  for (const entry of games) {
    byKey.set(key(entry.ref), [...(byKey.get(key(entry.ref)) ?? []), entry])
  }
  return [...byKey.values()].map((together) => {
    const stamps = together.flatMap(({ ref }) => stampOf(ref) ?? [])
    return {
      games: [...together].sort((left, right) => byPopularity(left.game, right.game)),
      at: stamps.length > 0 ? Math.max(...stamps) : null,
    }
  })
}

/**
 * The order questions are put in: one never put before any other, then the one put longest ago,
 * and between two alike the one about the more popular game — so the pages most opened are the
 * first to have a price.
 */
function byAge(left: Question, right: Question): number {
  if (left.at === null || right.at === null) {
    if (left.at !== right.at) return left.at === null ? -1 : 1
  } else if (left.at !== right.at) {
    return left.at - right.at
  }
  return byPopularity(left.games[0]!.game, right.games[0]!.game)
}

/** The product as a game's offer, read at `readAt`. */
function toOffer(product: PlaystationProduct, readAt: string): IndexedOffer {
  const { saleEndsAt, ...price } = product.price
  return {
    store: STORE,
    ...titled(product.title),
    ...price,
    currency: 'UAH',
    url: product.url,
    updatedAt: readAt,
    // Left out, not written empty: only a discount with a stated end has one.
    ...(saleEndsAt === null ? {} : { saleEndsAt }),
  }
}

/**
 * How long before `now` the oldest of the store's offers was read, or `null` when none can be
 * dated; with `within`, of the offers read no longer ago than that.
 */
function oldestPriceAge(
  games: readonly IndexedGame[],
  now: number,
  within = Number.POSITIVE_INFINITY,
): number | null {
  const ages = games.flatMap((game) => {
    const at = Date.parse(offerOf(game)?.updatedAt ?? '')
    const age = Math.max(0, now - at)
    return Number.isFinite(at) && age <= within ? [age] : []
  })
  return ages.length > 0 ? Math.max(...ages) : null
}

/** What the store's offers look like at this moment: how many, and how old the oldest are. */
function offersNow(
  games: readonly IndexedGame[],
  now: number,
): Pick<PlaystationReport, 'offers' | 'oldestPriceAgeMs' | 'oldestShownPriceAgeMs'> {
  return {
    offers: countOffers(games, STORE),
    oldestPriceAgeMs: oldestPriceAge(games, now),
    oldestShownPriceAgeMs: oldestPriceAge(games, now, PLAYSTATION_PRICE_SHOWN_MS),
  }
}

/**
 * `refs` is the run's mapping, and is brought up to date as the stage goes: when Sony was asked,
 * and what it answered about a title, is written to the permanent mapping (`setStoreRefs`) and to
 * the map the run holds, so whoever counts references after the stage counts what is true.
 * Whatever else a game's record holds is written back as it was.
 *
 * `verdict` is what the rule "an offer needs a reference" came to for this store in the stage
 * before (`refreshOffers`). While the mapping is not believed, Sony is asked nothing: a mapping
 * that has forgotten the games is no list to spend a ration on.
 */
export async function refreshPlaystationOffers(
  deps: JobDeps,
  games: IndexedGame[],
  refs: StoreRefMap,
  verdict: ReferenceVerdict,
  options: PlaystationStageOptions,
): Promise<PlaystationReport> {
  const store = deps.playstation
  const referenced: Referenced[] = games.flatMap((game) => {
    const ref = usableStoreRefs(refs.get(game.id)).playstation
    return ref ? [{ game, ref }] : []
  })

  const report = (extra: Partial<PlaystationReport>): PlaystationReport => ({
    status: 'read',
    asks: options.asks,
    references: referenced.length,
    mapped: referenced.filter(({ ref }) => typeof ref.conceptId === 'number').length,
    withoutConcept: referenced.filter(({ ref }) => ref.conceptId === null).length,
    unmapped: referenced.filter(({ ref }) => ref.conceptId === undefined).length,
    concepts: new Set(
      referenced.flatMap(({ ref }) => (typeof ref.conceptId === 'number' ? [ref.conceptId] : [])),
    ).size,
    due: 0,
    pricesRead: 0,
    mappingsRead: 0,
    noConcept: 0,
    mappingsDue: 0,
    pricedAfterMapping: 0,
    removed: 0,
    failed: 0,
    requests: 0,
    limit: Math.min(options.limit ?? PLAYSTATION_REQUESTS_PER_RUN, PLAYSTATION_REQUESTS_PER_RUN),
    ...offersNow(games, deps.clock.now()),
    stopped: null,
    ...(verdict.dropped > 0 ? { dropped: verdict.dropped } : {}),
    ...extra,
  })

  if (verdict.lost) {
    deps.log(`playstation: ${verdict.lost}; every offer is kept as it was and Sony is not asked`)
    return report({ status: 'references-lost', error: verdict.lost })
  }
  if (referenced.length === 0) return report({ status: 'no-references' })
  if (options.asks === 'nothing') return report({ status: 'not-in-this-run' })
  if (options.refusal) {
    deps.log(
      `playstation: the run is going to be refused publication (${reasonOf(options.refusal)}), ` +
        'so Sony is asked nothing',
    )
    return report({ status: 'run-refused', error: reasonOf(options.refusal) })
  }

  const startedAt = deps.clock.now()
  /** What a refusal at `at` means for a report: when it was, and until when nothing is asked. */
  const silence = (at: number): Pick<PlaystationReport, 'refusedAt' | 'silentUntil'> => ({
    refusedAt: new Date(at).toISOString(),
    silentUntil: new Date(at + PLAYSTATION_SILENCE_MS).toISOString(),
  })

  // A refusal within the last day: nothing is asked, by this run or by any other. What the key
  // holds is not taken on trust any more than a reference is. A moment that cannot be read, or
  // lies ahead of the clock, tells nothing of when Sony refused, and for this store the safe
  // reading is "just now": it is written back as now, and the day is counted from here.
  const recorded = await deps.writer.getCursor(PLAYSTATION_REFUSED_CURSOR)
  if (recorded !== null) {
    const parsed = JOB_TIMESTAMP.test(recorded) ? Date.parse(recorded) : Number.NaN
    const since = Number.isFinite(parsed) && parsed <= startedAt ? parsed : startedAt
    if (startedAt - since < PLAYSTATION_SILENCE_MS) {
      if (since !== parsed) {
        await deps.writer.setCursor(PLAYSTATION_REFUSED_CURSOR, new Date(since).toISOString())
      }
      const { silentUntil } = silence(since)
      deps.log(
        `playstation: Sony refused a request less than a day ago; silent until ${silentUntil}`,
      )
      return report({ status: 'silent', ...silence(since) })
    }
    // The day has passed. A key nobody reads any more is not kept.
    await deps.writer.clearCursor(PLAYSTATION_REFUSED_CURSOR)
  }

  const lock = createLockKeeper(deps)
  const requestsBefore = store.requests()
  let failed = 0
  /** When Sony refused a request in this run, once it has; written down at that moment. */
  let refusedAt: number | null = null
  /** Whether the stage left a question unput that it would have put. */
  let cutShort = false

  /**
   * Changes what the references of these games say, in the run's map and in the permanent one,
   * at once: a request is not sent on the strength of a date that is still to be written.
   */
  async function remember(
    entries: readonly Referenced[],
    change: (ref: PlaystationRef) => PlaystationRef,
  ): Promise<void> {
    if (entries.length === 0) return
    await deps.writer.setStoreRefs(
      entries.map((entry) => {
        entry.ref = change(entry.ref)
        const record: IndexedStoreRefs = { ...refs.get(entry.game.id), playstation: entry.ref }
        refs.set(entry.game.id, record)
        return [entry.game.id, record] as [number, IndexedStoreRefs]
      }),
    )
  }

  /**
   * One question to Sony, and what came of it: the answer, `failed` for a request that was made
   * and brought nothing, `stopped` for one that was never made. The lock is given a sign of life
   * after every one — the adapter lets through one renewal a minute — because forty minutes of
   * waiting on Sony must not cost the run its lock.
   */
  async function ask<T>(
    what: string,
    question: () => Promise<T>,
  ): Promise<{ answer: T } | 'failed' | 'stopped'> {
    try {
      return { answer: await question() }
    } catch (error) {
      if (error instanceof PlaystationStopped) return 'stopped'
      failed += 1
      deps.log(
        `playstation: ${what} could not be read, leaving its game as it was: ${reasonOf(error)}`,
      )
      // A refusal is written down the moment it comes, before anything else can go wrong with
      // the run: it is what keeps the next run, and the one after, from knocking again.
      if (refusedAt === null && store.stopped()?.reason === 'refused') {
        refusedAt = deps.clock.now()
        await deps.writer.setCursor(PLAYSTATION_REFUSED_CURSOR, new Date(refusedAt).toISOString())
      }
      return 'failed'
    } finally {
      await lock.renew()
    }
  }

  /** Whether another question may be put: the lock is held, and the transport will take one. */
  const mayAsk = (): boolean => lock.held() && store.stopped() === null

  /** What the stage reports once its questions are put: its counts, and why it stopped, if it did. */
  function done(extra: Partial<PlaystationReport>, said: string): PlaystationReport {
    // Running out of the ration is worth a word only when something was left waiting. A
    // refusal, or three failures in a row, is worth one whatever was left.
    const stop = store.stopped()
    const stopped =
      stop && (cutShort || stop.reason === 'refused' || stop.reason === 'failures') ? stop : null
    const requests = store.requests() - requestsBefore
    deps.log(
      `playstation: ${referenced.length} references; ${said}, ${failed} failed, in ${requests} requests` +
        (stopped ? ` — stopped: ${stopped.detail}` : '') +
        (refusedAt === null ? '' : `; silent until ${silence(refusedAt).silentUntil}`) +
        (extra.error ? ` — ${extra.error}` : ''),
    )
    return report({
      failed,
      requests,
      stopped,
      ...(refusedAt === null ? {} : silence(refusedAt)),
      ...extra,
    })
  }

  // A date ahead of the clock was not written when it says. Nothing is known of when the game
  // was asked, and for this store the safe reading is "just now": it is written back as now,
  // and the question is put in a day rather than first, by every run, until its date passes.
  const now = new Date(startedAt).toISOString()
  await remember(
    referenced.filter(
      ({ ref }) => (pricedAtOf(ref) ?? 0) > startedAt || (mappedAtOf(ref) ?? 0) > startedAt,
    ),
    (ref) => ({
      ...ref,
      ...((pricedAtOf(ref) ?? 0) > startedAt ? { askedAt: now } : {}),
      ...((mappedAtOf(ref) ?? 0) > startedAt ? { mappedAt: now } : {}),
    }),
  )
  const isDue = ({ at }: Question, after: number): boolean => at === null || startedAt - at >= after
  const limit = Math.min(
    options.limit ?? PLAYSTATION_REQUESTS_PER_RUN,
    PLAYSTATION_REQUESTS_PER_RUN,
  )
  /** Whether the stage's own ration, under the transport's, has a request left. */
  const withinLimit = (): boolean => store.requests() - requestsBefore < limit
  const conceptOf = (ref: PlaystationRef) => ref.conceptId as number
  const hasConcept = ({ ref }: Referenced) => typeof ref.conceptId === 'number'

  let pricesRead = 0
  let answered = 0
  /** Games that carried an offer and were answered about, and those of them left with no price. */
  let answeredCarrying = 0
  const removals: IndexedGame[] = []
  /**
   * What this run heard about each concept it priced, and when, to give a game mapped to it
   * afterwards: the same price, under the date it was read.
   */
  const heardOf = new Map<number, { answer: PlaystationProduct | null; readAt: string }>()

  /** The answer about a concept, given to these games of it. */
  function apply(
    entries: readonly Referenced[],
    answer: PlaystationProduct | null,
    readAt: string,
  ) {
    for (const { game } of entries) {
      answered += 1
      const carried = offerOf(game) !== undefined
      if (carried) answeredCarrying += 1
      if (answer) {
        setOffer(game, STORE, toOffer(answer, readAt))
        pricesRead += 1
        // Held until the run's answers can be weighed together.
      } else if (carried) removals.push(game)
    }
  }

  /** One price question: dated, put, and its answer given to every game of the concept. */
  async function price(question: Question): Promise<'read' | 'failed' | 'stopped'> {
    if (!mayAsk() || !withinLimit()) return 'stopped'
    const conceptId = conceptOf(question.games[0]!.ref)
    const askedAt = isoNow(deps.clock)
    await remember(question.games, (ref) => ({ ...ref, askedAt }))
    const heard = await ask(`the price of concept ${conceptId}`, () => store.price(conceptId))
    if (heard === 'stopped' || heard === 'failed') return heard
    const readAt = isoNow(deps.clock)
    heardOf.set(conceptId, { answer: heard.answer, readAt })
    apply(question.games, heard.answer, readAt)
    return 'read'
  }

  // First the prices that are due.
  const due = questionsOf(referenced.filter(hasConcept), conceptOf, pricedAtOf)
    .filter((question) => isDue(question, PLAYSTATION_REREAD_AFTER_MS))
    .sort(byAge)
  for (const question of due) {
    if ((await price(question)) === 'stopped') {
      cutShort = true
      break
    }
  }

  // Then the titles waiting for a concept: never answered, or answered "no concept" thirty days
  // ago or more — except any asked in the last twenty hours.
  const waiting = questionsOf(
    referenced.filter((entry) => !hasConcept(entry)),
    (ref) => ref.titleId,
    mappedAtOf,
  )
    .filter((question) =>
      question.games.some(({ ref }) => ref.conceptId === undefined)
        ? isDue(question, PLAYSTATION_REREAD_AFTER_MS)
        : isDue(question, PLAYSTATION_NO_CONCEPT_KEPT_MS),
    )
    .sort(byAge)
  const thisRun = waiting.slice(0, PLAYSTATION_MAPPINGS_PER_RUN)

  let mappingsRead = 0
  let pricedAfterMapping = 0
  const none: Referenced[] = []
  for (const question of cutShort ? [] : thisRun) {
    if (!mayAsk() || !withinLimit()) {
      cutShort = true
      break
    }
    const { titleId } = question.games[0]!.ref
    const mappedAt = isoNow(deps.clock)
    // What was known of the title's concept goes with the asking: "none, thirty days ago" is
    // not an answer any more once the question is put again.
    await remember(question.games, () => ({ titleId, mappedAt }))
    const heard = await ask(`the concept of title ${titleId}`, () => store.concept(titleId))
    if (heard === 'stopped') {
      cutShort = true
      break
    }
    if (heard === 'failed') continue

    mappingsRead += question.games.length
    const conceptId = heard.answer
    // A concept is kept as soon as it is named. "No concept" is held until the run's answers
    // can be weighed together: it is the one answer that stands for a month.
    if (conceptId === null) {
      none.push(...question.games)
      continue
    }
    await remember(question.games, (ref) => ({ ...ref, conceptId }))

    // And its price, right after: every game of the concept is one question, as above.
    const before = pricesRead
    const heardBefore = heardOf.get(conceptId)
    if (heardBefore) {
      // Priced earlier in this run, for another game of it: the same answer and the same date
      // of the asking, and no request.
      const askedAt = referenced.find(
        (entry) => entry.ref.conceptId === conceptId && !question.games.includes(entry),
      )?.ref.askedAt
      if (askedAt) await remember(question.games, (ref) => ({ ...ref, askedAt }))
      apply(question.games, heardBefore.answer, heardBefore.readAt)
    } else {
      const [concept] = questionsOf(
        referenced.filter((entry) => entry.ref.conceptId === conceptId),
        conceptOf,
        pricedAtOf,
      )
      if (concept && isDue(concept, PLAYSTATION_REREAD_AFTER_MS)) {
        const priced = await price(concept)
        if (priced === 'stopped') {
          cutShort = true
          break
        }
      }
    }
    if (pricesRead > before) {
      pricedAfterMapping += question.games.filter(({ game }) => offerOf(game) !== undefined).length
    }
  }
  lock.assertHeld()

  const unbelievedPrices =
    removalsNotBelieved(answeredCarrying, removals.length) ?? nothingPriced(answered, pricesRead)
  if (!unbelievedPrices) for (const game of removals) setOffer(game, STORE, null)
  const removed = unbelievedPrices ? 0 : removals.length
  const unbelievedConcepts = noConceptNotBelieved(mappingsRead, none.length)
  if (!unbelievedConcepts) await remember(none, (ref) => ({ ...ref, conceptId: null }))
  const unbelieved = [unbelievedPrices, unbelievedConcepts].filter(Boolean).join('; ')
  const gamesIn = (questions: readonly Question[]) =>
    questions.reduce((count, question) => count + question.games.length, 0)
  const dueGames = gamesIn(due)
  const waitingGames = gamesIn(waiting)

  // The stage's own ration ran out before the transport's: said as the transport says its own.
  const limited =
    cutShort && store.stopped() === null && !withinLimit()
      ? { reason: 'requests' as const, detail: `the run has made its ${limit} requests` }
      : null

  return done(
    {
      status: unbelieved ? 'failed' : 'read',
      due: dueGames,
      pricesRead,
      removed,
      mappingsDue: waitingGames,
      mappingsRead,
      noConcept: none.length,
      pricedAfterMapping,
      ...offersNow(games, deps.clock.now()),
      ...(waiting.length > thisRun.length ? { heldOver: waiting.length - thisRun.length } : {}),
      ...(limited ? { stopped: limited } : {}),
      ...(unbelieved ? { error: unbelieved } : {}),
    },
    `${pricesRead - pricedAfterMapping} prices read of ${dueGames} due, ${removed} offers removed; ` +
      `${mappingsRead} titles answered about of ${waitingGames} due, ${none.length} of them with ` +
      `no concept, ${pricedAfterMapping} of them priced`,
  )
}
