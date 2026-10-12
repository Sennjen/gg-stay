import { kyivDate, parseUsdRate } from './bank'
import { isoNow, type JobDeps } from './deps'
import { walkGogCatalog } from './gog'
import { MICROSOFT_IDS_PER_REQUEST, microsoftProductUrl, parseMicrosoftProducts } from './microsoft'
import { usableStoreRefs, type StoreRefMap } from './storeRefs'
import { reasonOf } from './storeUpstream'
import {
  OFFER_STORES,
  type IndexMeta,
  type IndexedExchangeRate,
  type IndexedGame,
  type IndexedOffer,
  type IndexedStoreRefs,
  type OfferStore,
} from '../../server/index/document'
import { safeExternalUrl } from '../../shared/url'

/**
 * The stage that reads what GOG and the Microsoft Store charge in Ukraine, and the National
 * Bank's dollar rate, and puts them on the documents and in the metadata of the version being
 * built. The site reads none of these three itself: this is the only place they are asked.
 *
 * **Twice a day, whatever the run.** A store is read when its last read *in full* is more than
 * eleven hours old (`OFFERS_MAX_AGE_MS`), and that is the whole schedule: with a prices run every
 * six hours, every other one reads the stores, and a nightly or a weekly run that comes round
 * inside the eleven hours publishes the offers the documents already carry. The stamp of a store
 * moves only when it was read in full, so a read that failed is tried again by the very next run
 * — six hours on, not twelve.
 *
 * **A store that is down changes nothing else.** These prices are an addition to a catalog that
 * is whole without them. Nothing a store or the bank does can fail the run, hold back the
 * publication, or touch a Steam price or its stamp; nothing here is counted in the run's item
 * failures or weighed by the publication's gates. A read that fails leaves every offer it would
 * have refreshed exactly as it was, date included — and an old date is an old price: the site
 * shows no offer it cannot call fresh.
 *
 * **What a full read settles.** A game whose product the store answered for gets today's offer.
 * A game the store did not have, or had without a price anyone can pay, loses the offer it had:
 * the store has said it is not selling it. **Only a full read takes an offer away.** A read with
 * a failed request in it publishes the prices it was given and removes nothing, because a store
 * that is failing some of its requests is the store most likely to answer others with half of
 * what it has.
 *
 * **And a full read is believed only so far** (`OFFER_FLOOR_MIN_CARRIED`). Every check above is
 * about whether the store answered; none is about whether this job still understands the answer.
 * A read that would take most of a store's offers away at once is far more likely a store that
 * changed the shape of what it says than a store that stopped selling, so it is reported as
 * failed and nothing is taken from it.
 *
 * **An offer needs a reference.** A document keeps an offer of a store only while the permanent
 * mapping (`storeRefs.ts`) names the game's product there, as it keeps a Steam app id only while
 * the mapping holds one: what the documents of a run arrived carrying is never an authority.
 */

/** A store's prices are read again once its last full read is older than this: eleven hours. */
export const OFFERS_MAX_AGE_MS = 11 * 3_600_000

/** How long a rate that could not be read again goes on being published: seven days. */
export const RATE_KEPT_MS = 7 * 86_400_000

/**
 * How many offers of a store the documents must arrive carrying before a read is held to the
 * floor below. Under twenty, halves are noise: a store with eight offers that prices three of
 * them tonight has not broken, it has had three delistings or a small first sweep.
 */
export const OFFER_FLOOR_MIN_CARRIED = 20

/**
 * A full read must leave at least this share of the offers the documents carried, or it is not
 * believed.
 *
 * It is `MIN_PRICED_RATIO` of `publish.ts`, for the same shape of failure and by the same
 * reasoning: prices silently gone are worse than yesterday's prices. A read counts as full when
 * every request was answered — and a store that renames one field, or answers 200 with an empty
 * list, answers every request. Read at face value such an answer says "this store sells none of
 * these any more", every offer is removed in a run that ends green, and nothing but a zero in a
 * summary row says so. Real churn between two reads twelve hours apart is a handful of products;
 * losing more than half of them at once is the job misreading the store.
 *
 * It is a floor inside the stage and not a gate on the publication: the run publishes as it would
 * have, this store's offers, their dates and its stamp stay exactly as they were, and the next
 * run reads again. If the store really has stopped selling, the offers go stale on the site after
 * thirty-six hours and are shown as links without a price, and the warning repeats on every run
 * until somebody looks.
 */
export const OFFER_FLOOR_RATIO = 0.5

export type StoreReadStatus =
  /** Every request was answered; the store's stamp moved. */
  | 'read'
  /** Some requests failed; what was answered was published, and the stamp stayed. */
  | 'partial'
  /** Nothing was read; every offer is as it was. */
  | 'failed'
  /** The last full read is under eleven hours old; no request was made. */
  | 'not-due'
  /** The mapping names no product of this store for any game of the run; no request was made. */
  | 'no-references'

/** What one store's read came to, for the log and the job summary. */
export interface StoreReadReport {
  status: StoreReadStatus
  /** Games of the run the mapping names a product of in this store. */
  references: number
  /** Of them, games this run's read gave a price. */
  pricesRead: number
  /** Of them, games whose request failed in this run; their offers are as they were. */
  failed: number
  /** Requests this run made to the store, a retry inside the transport not counted. */
  requests: number
  /** Games the run publishes with an offer of this store, read now or carried. */
  offers: number
  /** When the store was last read in full, after this run. */
  lastReadAt: string | null
  /** Why a read failed: the upstream's own words on one line, or what the floor saw. */
  error?: string
}

export interface RateReport {
  /** `read` now; `kept` from the published version; `none` when there is nothing to keep. */
  status: 'read' | 'kept' | 'none'
  rate: IndexedExchangeRate | null
}

export interface OffersResult {
  gog: StoreReadReport
  microsoft: StoreReadReport
  rate: RateReport
  /** The two fields of the metadata this stage owns, as the publication should write them. */
  offersReadAt: Partial<Record<OfferStore, string>>
  exchangeRate: IndexedExchangeRate | undefined
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Why a full read is not believed, or `null` when it is: the documents carried enough offers of
 * the store for a half to mean something, and the read would leave fewer than half of them
 * (`OFFER_FLOOR_RATIO`). The reason says what was seen, in the two numbers that decide it.
 */
export function belowOfferFloor(carried: number, priced: number): string | null {
  if (carried < OFFER_FLOOR_MIN_CARRIED || priced >= carried * OFFER_FLOOR_RATIO) return null
  return (
    `carried ${carried}, the read priced ${priced}: under half of the offers the store had, ` +
    'so the read is not believed and nothing is taken from it'
  )
}

/** A stamp as epoch milliseconds, or `null` when it is missing, unreadable or in the future. */
function stampOf(iso: string | undefined | null, now: number): number | null {
  if (typeof iso !== 'string') return null
  const at = Date.parse(iso)
  return Number.isFinite(at) && at <= now ? at : null
}

/** Whether a store is due: never read in full, or last read more than eleven hours ago. */
export function isOffersReadDue(lastReadAt: string | undefined | null, now: number): boolean {
  const at = stampOf(lastReadAt, now)
  return at === null || now - at > OFFERS_MAX_AGE_MS
}

/** The store's own title as an offer carries it: the field, or no field when there is none. */
function titled(title: string | null): { title?: string } {
  return title === null ? {} : { title }
}

/** Whether the mapping names the game's product in a store. */
function hasReference(refs: IndexedStoreRefs, store: OfferStore): boolean {
  return store === 'gog' ? typeof refs.gog === 'string' : Boolean(refs.microsoft)
}

/** The game's offers in the order of `OFFER_STORES`, or no field at all when it has none. */
function writeOffers(game: IndexedGame, offers: readonly IndexedOffer[]): void {
  const ordered = OFFER_STORES.flatMap((store) => {
    const offer = offers.find((candidate) => candidate.store === store)
    return offer ? [offer] : []
  })
  if (ordered.length > 0) game.offers = ordered
  else delete game.offers
}

/** Gives the game this store's offer, or takes away the one it had. */
function setOffer(game: IndexedGame, store: OfferStore, offer: IndexedOffer | null): void {
  const others = (game.offers ?? []).filter((candidate) => candidate.store !== store)
  writeOffers(game, offer ? [...others, offer] : others)
}

function countOffers(games: readonly IndexedGame[], store: OfferStore): number {
  return games.filter((game) => game.offers?.some((offer) => offer.store === store)).length
}

/**
 * A lock renewal that cannot be mistaken for a store's failure. The reads renew the lock as they
 * go, from inside the code whose failures mean "the store is down"; an index that will not renew
 * is another matter, and is thrown once the store's own verdict is in.
 */
function createLockKeeper(deps: JobDeps) {
  let failure: unknown = null
  return {
    renew: async (): Promise<void> => {
      try {
        await deps.writer.renewLock()
      } catch (error) {
        failure ??= error
      }
    },
    assertHeld: (): void => {
      if (failure !== null) throw failure
    },
  }
}

/**
 * GOG: one walk of the catalog, and every referenced slug looked up in it. All or nothing — a
 * walk that fails at any page, or cannot prove itself whole (`walkGogCatalog`), or would leave
 * under half the offers the documents carried (`belowOfferFloor`), publishes nothing new and
 * takes nothing away.
 */
async function readGog(
  deps: JobDeps,
  referenced: { game: IndexedGame; slug: string }[],
  lastReadAt: string | undefined,
): Promise<StoreReadReport> {
  const report = (extra: Partial<StoreReadReport>): StoreReadReport => ({
    status: 'read',
    references: referenced.length,
    pricesRead: 0,
    failed: 0,
    requests: 0,
    offers: 0,
    lastReadAt: lastReadAt ?? null,
    ...extra,
  })
  if (referenced.length === 0) return report({ status: 'no-references' })
  if (!isOffersReadDue(lastReadAt, deps.clock.now())) return report({ status: 'not-due' })

  const lock = createLockKeeper(deps)
  const carried = countOffers(
    referenced.map((entry) => entry.game),
    'gog',
  )
  let requests = 0
  try {
    const walk = await walkGogCatalog((page) => {
      requests += 1
      return deps.gog(page)
    }, lock.renew)
    const readAt = isoNow(deps.clock)
    // Worked out for every game before any document is touched: whether the read is believed
    // at all is decided on the whole of it.
    const read = referenced.map(({ game, slug }) => {
      const product = walk.products.get(slug)
      const offer: IndexedOffer | null =
        product?.price && product.url
          ? {
              store: 'gog',
              ...titled(product.title),
              ...product.price,
              currency: 'USD',
              url: product.url,
              updatedAt: readAt,
            }
          : null
      return { game, offer }
    })
    const pricesRead = read.filter((entry) => entry.offer !== null).length
    lock.assertHeld()

    const unbelieved = belowOfferFloor(carried, pricesRead)
    if (unbelieved) {
      deps.log(`gog: the catalog was walked in ${requests} requests and ${unbelieved}`)
      return report({
        status: 'failed',
        failed: referenced.length,
        requests,
        error: unbelieved,
      })
    }

    for (const { game, offer } of read) setOffer(game, 'gog', offer)
    deps.log(
      `gog: ${referenced.length} references, ${pricesRead} prices read in ${requests} requests`,
    )
    return report({ pricesRead, requests, lastReadAt: readAt })
  } catch (error) {
    lock.assertHeld()
    const reason = reasonOf(error)
    deps.log(
      `gog: the catalog walk failed after ${requests} requests, keeping every offer: ${reason}`,
    )
    return report({ status: 'failed', failed: referenced.length, requests, error: reason })
  }
}

/**
 * The Microsoft Store: the referenced product ids a hundred a request. A request is the unit of
 * failure here, as a chunk is for Steam's prices, and what a read may do depends on whether any
 * failed:
 *
 * - **every request answered** — a full read. Every referenced game is settled by it: a priced
 *   product gets today's offer, and a product the store left out, or left without a price anyone
 *   can pay, loses the offer it had. The store's stamp moves. Unless the read would leave under
 *   half the offers the documents carried (`belowOfferFloor`): then it is reported as failed, and
 *   nothing at all is taken from it.
 * - **some request failed** — the prices the answered requests gave are published, under today's
 *   date, and **no offer is removed**, not even of a product an answered request left out:
 *   nothing proves a Microsoft answer whole the way a GOG walk is proved, and a store failing one
 *   request in three is the store most likely to answer another with products missing. The
 *   products of a failed request keep the offers they had. The stamp stays, so the next run
 *   reads again.
 */
async function readMicrosoft(
  deps: JobDeps,
  referenced: { game: IndexedGame; product: NonNullable<IndexedStoreRefs['microsoft']> }[],
  lastReadAt: string | undefined,
): Promise<StoreReadReport> {
  const report = (extra: Partial<StoreReadReport>): StoreReadReport => ({
    status: 'read',
    references: referenced.length,
    pricesRead: 0,
    failed: 0,
    requests: 0,
    offers: 0,
    lastReadAt: lastReadAt ?? null,
    ...extra,
  })
  if (referenced.length === 0) return report({ status: 'no-references' })
  if (!isOffersReadDue(lastReadAt, deps.clock.now())) return report({ status: 'not-due' })

  // Two games can name one product; it is asked about once and both are given its price.
  const byId = new Map<string, typeof referenced>()
  for (const entry of referenced) {
    byId.set(entry.product.id, [...(byId.get(entry.product.id) ?? []), entry])
  }

  const lock = createLockKeeper(deps)
  const carried = countOffers(
    referenced.map((entry) => entry.game),
    'xbox-store',
  )
  /** What the answered requests said of each game: an offer, or `null` for "not sold". */
  const answered: { game: IndexedGame; offer: IndexedOffer | null }[] = []
  let requests = 0
  let failedRequests = 0
  let failed = 0
  let error: string | undefined
  for (const ids of chunk([...byId.keys()], MICROSOFT_IDS_PER_REQUEST)) {
    requests += 1
    try {
      const sold = parseMicrosoftProducts(await deps.microsoft(ids), ids, deps.clock.now())
      const readAt = isoNow(deps.clock)
      for (const id of ids) {
        const answer = sold.get(id) ?? null
        for (const { game, product } of byId.get(id) ?? []) {
          const url = answer ? safeExternalUrl(microsoftProductUrl(product)) : null
          answered.push({
            game,
            offer:
              answer && url
                ? {
                    store: 'xbox-store',
                    ...titled(answer.title),
                    ...answer.price,
                    currency: 'UAH',
                    url,
                    updatedAt: readAt,
                  }
                : null,
          })
        }
      }
    } catch (cause) {
      failedRequests += 1
      failed += ids.reduce((games, id) => games + (byId.get(id)?.length ?? 0), 0)
      error = reasonOf(cause)
      deps.log(
        `microsoft: a request for ${ids.length} products failed, keeping their offers: ${error}`,
      )
    }
    await lock.renew()
  }
  lock.assertHeld()

  const priced = answered.filter((entry) => entry.offer !== null)
  if (failedRequests > 0) {
    // Not a full read: what was priced is published, and nothing is removed.
    for (const { game, offer } of priced) setOffer(game, 'xbox-store', offer)
    deps.log(
      `microsoft: ${referenced.length} references, ${priced.length} prices read, ${failed} failed, ` +
        `in ${requests} requests; no offer was removed, the read was not a full one`,
    )
    return report({
      status: failedRequests === requests ? 'failed' : 'partial',
      pricesRead: priced.length,
      failed,
      requests,
      ...(error === undefined ? {} : { error }),
    })
  }

  const unbelieved = belowOfferFloor(carried, priced.length)
  if (unbelieved) {
    deps.log(`microsoft: every one of ${requests} requests was answered and ${unbelieved}`)
    return report({ status: 'failed', failed: referenced.length, requests, error: unbelieved })
  }

  for (const { game, offer } of answered) setOffer(game, 'xbox-store', offer)
  deps.log(
    `microsoft: ${referenced.length} references, ${priced.length} prices read, 0 failed, in ${requests} requests`,
  )
  return report({ pricesRead: priced.length, requests, lastReadAt: isoNow(deps.clock) })
}

/** A published rate as it may be kept: every field what this stage writes, and read in the past. */
function keptRate(rate: IndexedExchangeRate | undefined, now: number): IndexedExchangeRate | null {
  if (!rate || rate.currency !== 'USD' || typeof rate.date !== 'string') return null
  if (typeof rate.uah !== 'number' || !Number.isFinite(rate.uah) || rate.uah <= 0) return null
  const readAt = stampOf(rate.readAt, now)
  return readAt !== null && now - readAt <= RATE_KEPT_MS ? rate : null
}

/**
 * The bank's rate for today, once a run. When it cannot be read — the bank is down, or answers
 * something that is not exactly the rate of the day asked for — the rate the published version
 * carries stands, for seven days counted from the moment it was read. After that there is none:
 * the site then shows the dollar price alone, and no estimate made on a rate that old.
 */
async function readRate(deps: JobDeps, published: IndexMeta | null): Promise<RateReport> {
  const now = deps.clock.now()
  const date = kyivDate(now)
  try {
    const uah = parseUsdRate(await deps.bank(date), date)
    if (uah === null) throw new Error(`the answer is not the dollar's rate for ${date}`)
    deps.log(`rate: ${uah} UAH per USD for ${date}`)
    return { status: 'read', rate: { currency: 'USD', uah, date, readAt: isoNow(deps.clock) } }
  } catch (error) {
    const kept = keptRate(published?.exchangeRate, now)
    deps.log(
      `rate: the National Bank could not be read (${reasonOf(error)}); ` +
        (kept ? `keeping the rate for ${kept.date}` : 'no rate under seven days old is left'),
    )
    return kept ? { status: 'kept', rate: { ...kept } } : { status: 'none', rate: null }
  }
}

export async function refreshOffers(
  deps: JobDeps,
  games: IndexedGame[],
  refs: StoreRefMap,
  published: IndexMeta | null,
): Promise<OffersResult> {
  const gogGames: { game: IndexedGame; slug: string }[] = []
  const microsoftGames: {
    game: IndexedGame
    product: NonNullable<IndexedStoreRefs['microsoft']>
  }[] = []

  for (const game of games) {
    const usable = usableStoreRefs(refs.get(game.id))
    if (usable.gog) gogGames.push({ game, slug: usable.gog })
    if (usable.microsoft) microsoftGames.push({ game, product: usable.microsoft })
    // The mapping is the only authority for which stores a game may carry an offer of.
    const carried = Array.isArray(game.offers) ? game.offers : []
    writeOffers(
      game,
      carried.filter(
        (offer) => OFFER_STORES.includes(offer?.store) && hasReference(usable, offer.store),
      ),
    )
  }

  const previous = published?.offersReadAt ?? {}
  const gog = await readGog(deps, gogGames, previous.gog)
  const microsoft = await readMicrosoft(deps, microsoftGames, previous['xbox-store'])
  const rate = await readRate(deps, published)

  gog.offers = countOffers(games, 'gog')
  microsoft.offers = countOffers(games, 'xbox-store')

  const offersReadAt: Partial<Record<OfferStore, string>> = {}
  if (gog.lastReadAt) offersReadAt.gog = gog.lastReadAt
  if (microsoft.lastReadAt) offersReadAt['xbox-store'] = microsoft.lastReadAt

  return { gog, microsoft, rate, offersReadAt, exchangeRate: rate.rate ?? undefined }
}
