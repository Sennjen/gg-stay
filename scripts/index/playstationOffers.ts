import { isoNow, type JobDeps } from './deps'
import {
  countOffers,
  createLockKeeper,
  OFFER_FLOOR_MIN_CARRIED,
  OFFER_FLOOR_RATIO,
  setOffer,
  stampOf,
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
 * of the version being built. It comes after the stage for the other stores (`offers.ts`), in
 * every kind of run, and it is nothing like that one in pace: Sony is asked about one game a
 * request, ten seconds apart, a couple of hundred times a run at the most (`playstation.ts`).
 *
 * **A run has a ration, and spends it in this order.**
 *
 * 1. **Prices**, for the games whose title Sony has named a concept for: the game whose price was
 *    read longest ago first, and one never read before any other. A game read in the last twenty
 *    hours is not asked about (`PLAYSTATION_REREAD_AFTER_MS`): a price is read once a day, and
 *    the job's five runs a day each take the portion that has come due.
 * 2. **Mappings**, for the games that have a title and have not been asked about yet — which
 *    concept the title belongs to — the most popular first, at most
 *    `PLAYSTATION_MAPPINGS_PER_RUN` a run, and only with what the prices left of the run's
 *    requests. A game mapped by one run is priced by the next. Mapping a thousand games takes
 *    three or four days, and that is intended.
 *
 * The ration itself is the transport's and is not counted here: the stage asks while the
 * transport will take a question (`PlaystationStore.stopped`), and stops when it will not.
 *
 * **What an answer does to an offer**, a game at a time, since a request is about one game:
 *
 * - a price anyone can pay — today's offer, under today's date;
 * - an answer with no such price, or with no product — the offer the game had is removed, and
 *   the day is remembered on the game's reference (`unpricedAt`), so that the game is asked about
 *   again in a day and not at the head of the very next run, where a game with no offer to date
 *   it would otherwise stand for ever;
 * - a request that failed, or was never made — the offer and its date stay exactly as they were.
 *   Nothing is asked twice in a run; the game is simply among the oldest when the next one comes.
 *
 * **And the answers are believed only so far** (`removalsNotBelieved`). A change of shape on
 * Sony's side is answered by every request and read as "no price" for every game, in a run that
 * ends green. When a run has heard about twenty games that carried an offer and more than half of
 * those answers would take it away, none of the run's removals is applied: it is the floor the
 * other stores' reads stand on, measured on what one run asked.
 *
 * **Nothing here can cost the run.** A request that fails is one game left as it was. Sony
 * refusing, or failing three times in a row, ends the stage and not the run, and says so in a
 * warning (`run.ts`). Only the index failing — a lock that will not renew, a reference that will
 * not be written — is thrown, as it is everywhere.
 */

const STORE = 'playstation-store'

/** A price is read again once its last read is this old: twenty hours, so once a day. */
export const PLAYSTATION_REREAD_AFTER_MS = 20 * 3_600_000

/** The most titles one run asks Sony to name a concept for. */
export const PLAYSTATION_MAPPINGS_PER_RUN = 60

/**
 * How many references to accumulate before one `setStoreRefs` round trip. Small on purpose: what
 * is in a batch cost a request to Sony each, and a run that dies loses the batch it had not
 * written — a hundred seconds of asking, at this size.
 */
export const PLAYSTATION_REF_BATCH_SIZE = 10

export type PlaystationReadStatus =
  /** The stage asked what the run's ration allowed, and believed what it heard. */
  | 'read'
  /** The answers would have removed too many offers at once, and no removal was applied. */
  | 'failed'
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
  /** Games of the run the mapping names a PlayStation title for. */
  references: number
  /** Of them, games whose title Sony has named a concept for — after this run. */
  mapped: number
  /** Of them, games Sony has not been asked about yet — after this run. */
  unmapped: number
  /** Games whose price was due when the stage began: mapped, and not read in the last twenty hours. */
  due: number
  /** Games this run's read gave a price. */
  pricesRead: number
  /** Titles Sony answered about in this run, with a concept or with none. */
  mappingsRead: number
  /** Offers this run took away because Sony answered with no price anyone can pay. */
  removed: number
  /** Requests of either kind that failed; their games are as they were. */
  failed: number
  /** Requests this run made to Sony, of either kind, whatever came of them. */
  requests: number
  /** Games the run publishes with an offer of this store, read now or carried. */
  offers: number
  /**
   * Why the stage stopped asking: out of its requests or its time while games were still
   * waiting, or — whatever was still waiting — refused by Sony, or failed three times in a row.
   * `null` when it asked about everything that was due.
   */
  stopped: PlaystationStopReport | null
  /**
   * Games that arrived with an offer of this store and lost it in this run for want of a
   * reference, the mapping being believed (`refreshOffers`). Left out when there were none.
   */
  dropped?: number
  /** What the floor saw of the run's answers, or what it saw of the mapping. */
  error?: string
}

type PlaystationRef = NonNullable<IndexedStoreRefs['playstation']>

/** A game of the run with a PlayStation title, and what its reference says at this moment. */
interface Referenced {
  game: IndexedGame
  ref: PlaystationRef
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

function offerOf(game: IndexedGame): IndexedOffer | undefined {
  return game.offers?.find((offer) => offer.store === STORE)
}

/**
 * When Sony last answered about the game's price, as epoch milliseconds: the date of the offer it
 * gave, or of the answer that there is none, whichever is later. `null` for a game never answered
 * about, and for dates that cannot be read or lie in the future — nothing is known of such a
 * read, so the game is asked about as one never read.
 */
function lastReadAt({ game, ref }: Referenced, now: number): number | null {
  const priced = stampOf(offerOf(game)?.updatedAt, now)
  const unpriced = stampOf(ref.unpricedAt, now)
  if (priced === null || unpriced === null) return priced ?? unpriced
  return Math.max(priced, unpriced)
}

/** The more popular game first, and the lower id between two as popular: an order that is one order. */
function byPopularity(left: IndexedGame, right: IndexedGame): number {
  return right.popularity - left.popularity || left.id - right.id
}

/** The product as the game's offer, read at `readAt`. */
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
 * `refs` is the run's mapping, and is brought up to date as the stage goes: what Sony answers
 * about a title or a concept is written to the permanent mapping (`setStoreRefs`) and to the map
 * the run holds, so whoever counts references after the stage counts what is true.
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
): Promise<PlaystationReport> {
  const store = deps.playstation
  const referenced: Referenced[] = games.flatMap((game) => {
    const ref = usableStoreRefs(refs.get(game.id)).playstation
    return ref ? [{ game, ref }] : []
  })

  const report = (extra: Partial<PlaystationReport>): PlaystationReport => ({
    status: 'read',
    references: referenced.length,
    mapped: referenced.filter(({ ref }) => typeof ref.conceptId === 'number').length,
    unmapped: referenced.filter(({ ref }) => ref.conceptId === undefined).length,
    due: 0,
    pricesRead: 0,
    mappingsRead: 0,
    removed: 0,
    failed: 0,
    requests: 0,
    offers: countOffers(games, STORE),
    stopped: null,
    ...(verdict.dropped > 0 ? { dropped: verdict.dropped } : {}),
    ...extra,
  })

  if (verdict.lost) {
    deps.log(`playstation: ${verdict.lost}; every offer is kept as it was and Sony is not asked`)
    return report({ status: 'references-lost', error: verdict.lost })
  }
  if (referenced.length === 0) return report({ status: 'no-references' })

  const now = deps.clock.now()
  const due = referenced
    .filter(({ ref }) => typeof ref.conceptId === 'number')
    .map((entry) => ({ entry, at: lastReadAt(entry, now) }))
    .filter(({ at }) => at === null || now - at >= PLAYSTATION_REREAD_AFTER_MS)
    .sort((left, right) => {
      // Never read before any other, then the oldest read first.
      if (left.at === null || right.at === null) {
        if (left.at !== right.at) return left.at === null ? -1 : 1
      } else if (left.at !== right.at) {
        return left.at - right.at
      }
      return byPopularity(left.entry.game, right.entry.game)
    })
    .map(({ entry }) => entry)
  const unmapped = referenced
    .filter(({ ref }) => ref.conceptId === undefined)
    .sort((left, right) => byPopularity(left.game, right.game))

  const lock = createLockKeeper(deps)
  const requestsBefore = store.requests()
  let pricesRead = 0
  let mappingsRead = 0
  let failed = 0
  /** Games that carried an offer and were answered about, and those of them left with no price. */
  let answeredCarrying = 0
  const removals: IndexedGame[] = []
  /** Whether the stage left a game unasked that it would have asked about. */
  let cutShort = false
  let batch: [number, IndexedStoreRefs][] = []

  /** What Sony said about the game's title or its concept, kept: in the run's map, and for good. */
  function remember(entry: Referenced, ref: PlaystationRef): void {
    entry.ref = ref
    const record: IndexedStoreRefs = { ...refs.get(entry.game.id), playstation: ref }
    refs.set(entry.game.id, record)
    batch.push([entry.game.id, record])
  }

  async function flush(): Promise<void> {
    if (batch.length === 0) return
    const writing = batch
    batch = []
    await deps.writer.setStoreRefs(writing)
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

  try {
    for (const entry of due) {
      if (!mayAsk()) {
        cutShort = true
        break
      }
      const conceptId = entry.ref.conceptId as number
      const heard = await ask(`the price of concept ${conceptId}`, () => store.price(conceptId))
      if (heard === 'stopped') {
        cutShort = true
        break
      }
      if (heard === 'failed') continue

      const carried = offerOf(entry.game) !== undefined
      if (carried) answeredCarrying += 1
      if (heard.answer) {
        setOffer(entry.game, STORE, toOffer(heard.answer, isoNow(deps.clock)))
        pricesRead += 1
      } else {
        // Held until the run's answers can be weighed together; the day is remembered at once.
        if (carried) removals.push(entry.game)
        remember(entry, { ...entry.ref, unpricedAt: isoNow(deps.clock) })
      }
      if (batch.length >= PLAYSTATION_REF_BATCH_SIZE) await flush()
    }

    // After a stage cut short above this asks nothing: whatever stopped the prices stops it too.
    let mappings = 0
    for (const entry of unmapped) {
      if (mappings >= PLAYSTATION_MAPPINGS_PER_RUN) break
      if (!mayAsk()) {
        cutShort = true
        break
      }
      const { titleId } = entry.ref
      const heard = await ask(`the concept of title ${titleId}`, () => store.concept(titleId))
      if (heard === 'stopped') {
        cutShort = true
        break
      }
      mappings += 1
      if (heard === 'failed') continue

      mappingsRead += 1
      remember(entry, { ...entry.ref, conceptId: heard.answer })
      if (batch.length >= PLAYSTATION_REF_BATCH_SIZE) await flush()
    }
  } finally {
    // Whatever Sony said before the stage ended cost a request each, and is worth keeping.
    await flush()
  }
  lock.assertHeld()

  const unbelieved = removalsNotBelieved(answeredCarrying, removals.length)
  if (!unbelieved) for (const game of removals) setOffer(game, STORE, null)
  const removed = unbelieved ? 0 : removals.length

  // Running out of the ration is worth a word only when something was left waiting. A refusal,
  // or three failures in a row, is worth one whatever was left.
  const stop = store.stopped()
  const stopped =
    stop && (cutShort || stop.reason === 'refused' || stop.reason === 'failures') ? stop : null

  const requests = store.requests() - requestsBefore
  deps.log(
    `playstation: ${referenced.length} references; ${pricesRead} prices read of ${due.length} due, ` +
      `${removed} offers removed, ${mappingsRead} titles mapped, ${failed} failed, in ${requests} requests` +
      (stopped ? ` — stopped: ${stopped.detail}` : '') +
      (unbelieved ? ` — ${unbelieved}` : ''),
  )
  return report({
    status: unbelieved ? 'failed' : 'read',
    due: due.length,
    pricesRead,
    mappingsRead,
    removed,
    failed,
    requests,
    offers: countOffers(games, STORE),
    stopped,
    ...(unbelieved ? { error: unbelieved } : {}),
  })
}
