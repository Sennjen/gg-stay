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
  PlaystationStopped,
  type PlaystationProduct,
  type PlaystationStopReport,
} from './playstation'
import { usableStoreRefs, type StoreRefMap } from './storeRefs'
import { reasonOf } from './storeUpstream'
import type { IndexedGame, IndexedOffer, IndexedStoreRefs } from '../../server/index/document'

/**
 * The stage that reads what the PlayStation Store charges in Ukraine and puts it on the documents
 * of the version being built. It comes after the stage for the other stores (`offers.ts`), and it
 * is nothing like that one in pace: Sony is asked about one game a request, ten seconds apart, a
 * couple of hundred times a run at the most (`playstation.ts`).
 *
 * **Each kind of run asks one kind of question, or none.**
 *
 * - **A prices run reads prices**, for the games whose title Sony has named a concept for: the
 *   concept asked about longest ago first, and one never asked about before any other. Four runs
 *   a day at 225 requests each are 900 price reads a day.
 * - **The nightly full run maps titles** — which concept a title belongs to — for the games that
 *   have a title and no answer yet, at most `PLAYSTATION_MAPPINGS_PER_RUN` a night, right after
 *   the sweep that finds the titles. Mapping a thousand titles takes five nights. It has a run
 *   of its own because a ration shared with the prices is a ration the prices take whole.
 * - **A languages run asks nothing.**
 *
 * Every kind of run still reports the store: how many games have a title, a concept and an
 * offer, how old the oldest price is, and what the rule about references cost.
 *
 * **A game is asked about once a day, by the date of the asking** (`askedAt` on the game's
 * reference). The date is written to the permanent mapping *before* the request leaves, whichever
 * question it is and whatever comes of it — a price, no price, a failure, a refusal — and a game
 * asked about in the last twenty hours is not asked about again (`PLAYSTATION_REREAD_AFTER_MS`).
 * That is what the conditions the store is read on come to for one game, and it is why the date
 * is not the offer's: an offer is dated in a document that is published forty minutes later, or
 * not at all, and a game whose request failed has no new date there to show. So a run that does
 * not publish, and a game Sony fails for every time, are each asked about once a day and no more;
 * and a title the nightly run has mapped is first priced by the prices run twenty hours on.
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
 * price for none removes nothing either (`nothingPriced`), and a night on which most titles are
 * said to have no concept remembers none of those answers (`noConceptNotBelieved`). Each is the
 * floor the other stores' reads stand on, measured on what one run asked.
 *
 * **A run that is going to be refused publication asks nothing.** Whether a version will be
 * refused is known before the stage starts (`publicationRefusal`), and a ration spent for a
 * version nobody will see is a ration spent for nothing.
 *
 * **Nothing here can cost the run.** A request that fails is one game left as it was. Sony
 * refusing, or failing three times in a row, ends the stage and not the run, and says so in a
 * warning (`run.ts`). Only the index failing — a lock that will not renew, a reference that will
 * not be written — is thrown, as it is everywhere; and since a reference is written before its
 * request, an index that is down stops the asking at once.
 */

const STORE = 'playstation-store'

/** A game is asked about again once its last asking is this old: twenty hours, so once a day. */
export const PLAYSTATION_REREAD_AFTER_MS = 20 * 3_600_000

/**
 * The most titles one nightly run asks Sony to name a concept for: two hundred, about thirty-five
 * minutes of requests ten seconds apart, so that a catalog of a thousand titles is mapped in five
 * nights. It is under the transport's own limits on purpose — 225 requests and forty minutes a
 * run (`playstation.ts`) — and those bound a night whatever this number says: a slow Sony ends
 * the mapping at the forty minutes with fewer.
 */
export const PLAYSTATION_MAPPINGS_PER_RUN = 200

/**
 * How long "Sony has no concept for this title" stands before the title is asked about again:
 * thirty days. A title can come to the store later — a re-release under the same id, a region
 * that opens — and an answer kept for ever would be an answer nobody could take back without
 * editing the mapping by hand.
 */
export const PLAYSTATION_NO_CONCEPT_KEPT_MS = 30 * 86_400_000

/** What a run asks Sony, by its kind: see the module's note. */
export type PlaystationAsks = 'prices' | 'mappings' | 'nothing'

export interface PlaystationStageOptions {
  asks: PlaystationAsks
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
   * What was due when the stage began, in games: those whose price was to be read, in a prices
   * run; those whose title was to be mapped, in a full run.
   */
  due: number
  /** Games this run's read gave a price. */
  pricesRead: number
  /** Games whose title Sony answered about in this run, with a concept or with none. */
  mappingsRead: number
  /** Of them, games whose title Sony said has no concept. */
  noConcept: number
  /** Offers this run took away because Sony answered with no price anyone can pay. */
  removed: number
  /** Requests of either kind that failed; their games are as they were. */
  failed: number
  /** Requests this run made to Sony, whatever came of them. */
  requests: number
  /** Games the run publishes with an offer of this store, read now or carried. */
  offers: number
  /**
   * How long ago the oldest of those offers was read, when the stage ended; `null` when there is
   * none. With more concepts than a day's price reads, a game is read less than once a day, and
   * this is the number that shows it before an offer is too old for a page to quote.
   */
  oldestPriceAgeMs: number | null
  /**
   * Why the stage stopped asking: out of its requests or its time while games were still
   * waiting, or — whatever was still waiting — refused by Sony, or failed three times in a row.
   * `null` when it asked about everything that was due.
   */
  stopped: PlaystationStopReport | null
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

/** When the reference says Sony was last asked about the game, as it stands; `null` when it does not. */
function stampOf(ref: PlaystationRef): number | null {
  const at = typeof ref.askedAt === 'string' ? Date.parse(ref.askedAt) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/** The more popular game first, and the lower id between two as popular: an order that is one order. */
function byPopularity(left: IndexedGame, right: IndexedGame): number {
  return right.popularity - left.popularity || left.id - right.id
}

/**
 * The games gathered into the questions they are, by what the question is about: the games of
 * one concept are one price to read, and the games of one title are one title to map. A question
 * was last put when any of its games was last asked about.
 */
function questionsOf(
  games: readonly Referenced[],
  key: (ref: PlaystationRef) => string | number,
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

/** How long before `now` the oldest of the store's offers was read, or `null` when none can be dated. */
function oldestPriceAge(games: readonly IndexedGame[], now: number): number | null {
  const dates = games.flatMap((game) => {
    const at = Date.parse(offerOf(game)?.updatedAt ?? '')
    return Number.isFinite(at) ? [at] : []
  })
  return dates.length > 0 ? Math.max(0, now - Math.min(...dates)) : null
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
    due: 0,
    pricesRead: 0,
    mappingsRead: 0,
    noConcept: 0,
    removed: 0,
    failed: 0,
    requests: 0,
    offers: countOffers(games, STORE),
    oldestPriceAgeMs: oldestPriceAge(games, deps.clock.now()),
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

  const lock = createLockKeeper(deps)
  const requestsBefore = store.requests()
  const startedAt = deps.clock.now()
  let failed = 0
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
        (extra.error ? ` — ${extra.error}` : ''),
    )
    return report({ failed, requests, stopped, ...extra })
  }

  // A date ahead of the clock was not written when it says. Nothing is known of when the game
  // was asked, and for this store the safe reading is "just now": it is written back as now,
  // and the game is asked about in a day rather than first, by every run, until its date passes.
  await remember(
    referenced.filter(({ ref }) => (stampOf(ref) ?? 0) > startedAt),
    (ref) => ({ ...ref, askedAt: new Date(startedAt).toISOString() }),
  )
  const isDue = ({ at }: Question, after: number): boolean => at === null || startedAt - at >= after

  if (options.asks === 'prices') {
    const due = questionsOf(
      referenced.filter(({ ref }) => typeof ref.conceptId === 'number'),
      (ref) => ref.conceptId as number,
    )
      .filter((question) => isDue(question, PLAYSTATION_REREAD_AFTER_MS))
      .sort(byAge)

    let pricesRead = 0
    let answered = 0
    /** Games that carried an offer and were answered about, and those of them left with no price. */
    let answeredCarrying = 0
    const removals: IndexedGame[] = []

    for (const question of due) {
      if (!mayAsk()) {
        cutShort = true
        break
      }
      const conceptId = question.games[0]!.ref.conceptId as number
      const askedAt = isoNow(deps.clock)
      await remember(question.games, (ref) => ({ ...ref, askedAt }))
      const heard = await ask(`the price of concept ${conceptId}`, () => store.price(conceptId))
      if (heard === 'stopped') {
        cutShort = true
        break
      }
      if (heard === 'failed') continue

      const readAt = isoNow(deps.clock)
      for (const { game } of question.games) {
        answered += 1
        const carried = offerOf(game) !== undefined
        if (carried) answeredCarrying += 1
        if (heard.answer) {
          setOffer(game, STORE, toOffer(heard.answer, readAt))
          pricesRead += 1
          // Held until the run's answers can be weighed together.
        } else if (carried) removals.push(game)
      }
    }
    lock.assertHeld()

    const unbelieved =
      removalsNotBelieved(answeredCarrying, removals.length) ?? nothingPriced(answered, pricesRead)
    if (!unbelieved) for (const game of removals) setOffer(game, STORE, null)
    const removed = unbelieved ? 0 : removals.length
    const dueGames = due.reduce((count, question) => count + question.games.length, 0)

    return done(
      {
        status: unbelieved ? 'failed' : 'read',
        due: dueGames,
        pricesRead,
        removed,
        offers: countOffers(games, STORE),
        oldestPriceAgeMs: oldestPriceAge(games, deps.clock.now()),
        ...(unbelieved ? { error: unbelieved } : {}),
      },
      `${pricesRead} prices read of ${dueGames} due, ${removed} offers removed`,
    )
  }

  // The nightly run: titles Sony has not answered about, and titles it said "no concept" about
  // thirty days ago or more — except any asked about in the last twenty hours.
  const due = questionsOf(
    referenced.filter(({ ref }) => typeof ref.conceptId !== 'number'),
    (ref) => ref.titleId,
  )
    .filter((question) =>
      question.games.some(({ ref }) => ref.conceptId === undefined)
        ? isDue(question, PLAYSTATION_REREAD_AFTER_MS)
        : isDue(question, PLAYSTATION_NO_CONCEPT_KEPT_MS),
    )
    .sort(byAge)

  let mappingsRead = 0
  const none: Referenced[] = []
  const tonight = due.slice(0, PLAYSTATION_MAPPINGS_PER_RUN)

  for (const question of tonight) {
    if (!mayAsk()) {
      cutShort = true
      break
    }
    const { titleId } = question.games[0]!.ref
    const askedAt = isoNow(deps.clock)
    // What was known of the title's concept goes with the asking: "none, thirty days ago" is
    // not an answer any more once the question is put again.
    await remember(question.games, () => ({ titleId, askedAt }))
    const heard = await ask(`the concept of title ${titleId}`, () => store.concept(titleId))
    if (heard === 'stopped') {
      cutShort = true
      break
    }
    if (heard === 'failed') continue

    mappingsRead += question.games.length
    const conceptId = heard.answer
    // A concept is kept as soon as it is named. "No concept" is held until the night's answers
    // can be weighed together: it is the one answer that stands for a month.
    if (conceptId === null) none.push(...question.games)
    else await remember(question.games, (ref) => ({ ...ref, conceptId }))
  }
  lock.assertHeld()

  const unbelieved = noConceptNotBelieved(mappingsRead, none.length)
  if (!unbelieved) await remember(none, (ref) => ({ ...ref, conceptId: null }))
  const dueGames = due.reduce((count, question) => count + question.games.length, 0)

  return done(
    {
      status: unbelieved ? 'failed' : 'read',
      due: dueGames,
      mappingsRead,
      noConcept: none.length,
      ...(due.length > tonight.length ? { heldOver: due.length - tonight.length } : {}),
      ...(unbelieved ? { error: unbelieved } : {}),
    },
    `${mappingsRead} titles answered about of ${dueGames} due, ${none.length} of them with no concept`,
  )
}
