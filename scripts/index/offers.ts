import { kyivDate, parseUsdRate } from './bank'
import { isoNow, type JobDeps } from './deps'
import { walkGogCatalog, type GogCatalogWalk } from './gog'
import {
  MICROSOFT_IDS_PER_REQUEST,
  microsoftProductUrl,
  parseMicrosoftProducts,
  type MicrosoftProduct,
} from './microsoft'
import {
  findGogProduct,
  findMicrosoftProducts,
  gogSellables,
  isInTimeForTitle,
  isMicrosoftSearchDue,
  MICROSOFT_SEARCHES_PER_RUN,
  usableFallbacks,
  withGogFound,
  withMicrosoftFallback,
  type FallbackStop,
  type FallbackWay,
  type GogFound,
  type MicrosoftFallback,
  type MicrosoftFallbackResult,
  type MicrosoftFound,
  type UsableFallbacks,
} from './storeFallbacks'
import { usableStoreRefs, type StoreRefMap } from './storeRefs'
import { reasonOf } from './storeUpstream'
import { gamesWithLaterNamesakes } from './titleMatch'
import {
  OFFER_STORES,
  offerWay,
  type IndexMeta,
  type IndexedExchangeRate,
  type IndexedGame,
  type IndexedOffer,
  type IndexedStoreRefs,
  type OfferStore,
  type OfferWay,
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
 * the mapping holds one: what the documents of a run arrived carrying is never an authority. The
 * product may be the one RAWG's link names or one the store's own ways found
 * (`IndexedStoreRefs.fallbacks`): either is the mapping naming it.
 *
 * **RAWG's link is the first way to a product, not the only one** (`storeFallbacks.ts`). RAWG's
 * links go stale, and a game whose link leads to a product nobody sells any more is very often on
 * sale under another. So a read in full that leaves a game without a price is followed by the
 * store's own ways — the catalog's relations and its search at the Microsoft Store, a look
 * through the walked catalog by the game's name at GOG — and a game has no price at a store only
 * when none of them finds one. How an offer was found travels with it (`IndexedOffer.via`).
 *
 * **What those ways may do is add.** They run after the read's own verdict is in, only when the
 * read was in full and was believed, and nothing they do changes that verdict, the store's stamp,
 * or what the floors and the mapping guard measured. An offer they found is taken away as any
 * offer is: by a read in full in which its own product has no price anyone can pay — at the
 * Microsoft Store the product is asked about by its id in every read from then on; at GOG the
 * catalog is looked through again in every walk, and the offer goes when the walk finds no
 * product for the game.
 *
 * **And the mapping is believed only so far, too** (`referencesLookLost`). That rule runs before
 * any read and needs no store to be asked, so a mapping that came back empty — its keys gone, or
 * every one of them answered as absent — would take every offer away in a run that ends green,
 * with both stores reporting that they had nothing to read. The documents are no authority for
 * one game, but twenty of them agreeing against a mapping that has forgotten most of them are
 * evidence about the mapping: it is then not believed for that store, no offer of the store is
 * dropped for want of a reference, the store is not read, and its stamp stays where it was.
 *
 * **The PlayStation Store is not read here.** It is read a concept at a time, slowly, by a stage
 * of its own that comes after this one (`playstationOffers.ts`). What is done for it here is what
 * needs no request, and is one rule for every store: an offer of it is kept only while the
 * mapping names the game's title there, and the mapping is believed about it only so far. What
 * that came to is handed on to its stage (`OffersResult.playstation`).
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
  /**
   * The mapping has forgotten most of the games that carry an offer of this store, and is not
   * believed: no request was made, no offer was dropped, and the stamp stayed.
   */
  | 'references-lost'

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
  /**
   * Games that arrived with an offer of this store and lost it in this run for want of a
   * reference, the mapping being believed. Left out when there were none, which is nearly always:
   * a reference is lost one game at a time. Twenty in one run is the mapping on its way back
   * from a loss, and the run says so (`storeWarnings` in `run.ts`).
   */
  dropped?: number
  /** When the store was last read in full, after this run. */
  lastReadAt: string | null
  /**
   * Why the store's prices were not refreshed: the upstream's own words on one line, what the
   * floor saw of a read, or what it saw of the mapping.
   */
  error?: string
  /**
   * Of `offers`, those for a product a way of the store's own found, by the way; the rest are
   * for the product RAWG's link names. Left out when there are none.
   */
  otherWays?: Partial<Record<FallbackWay, number>>
  /**
   * What the store's own ways came to in this run. Left out when they were tried for nobody and
   * nobody is waiting for them — a run that did not find the store due, a read that failed, a
   * store where RAWG's link priced every game.
   */
  fallbacks?: StoreFallbackReport
}

/** What a store's own ways to a product did in one run (`storeFallbacks.ts`). */
export interface StoreFallbackReport {
  /** Games the ways were tried for, to the end, in this run. */
  searched: number
  /** Of them, games a way found a product for, by the way. */
  found: Partial<Record<FallbackWay, number>>
  /**
   * Games left waiting for their turn: over the run's cap, or behind a request that failed. The
   * next run that finds the store due takes them up. Always none at GOG, where looking costs no
   * request and every game is looked for in every walk.
   */
  waiting: number
  /** Requests the ways made to the store; none at GOG. */
  requests: number
  /** Why the ways ended before every game in this run's turn had been tried, when they did. */
  stopped?: FallbackStop
  /** The last failed request's own words, on one line. */
  error?: string
}

export interface RateReport {
  /** `read` now; `kept` from the published version; `none` when there is nothing to keep. */
  status: 'read' | 'kept' | 'none'
  rate: IndexedExchangeRate | null
}

/**
 * What "an offer needs a reference" came to for a store whose read is another stage's: whether
 * the mapping was believed about it, and what a believed mapping cost it.
 */
export interface ReferenceVerdict {
  /** Why the mapping is not believed for the store (`referencesLookLost`), or `null` when it is. */
  lost: string | null
  /** Games that arrived with an offer of the store and lost it here for want of a reference. */
  dropped: number
}

export interface OffersResult {
  gog: StoreReadReport
  microsoft: StoreReadReport
  /** The PlayStation Store's share of the rule about references; its read is its own stage's. */
  playstation: ReferenceVerdict
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

/**
 * Why the mapping is not believed for a store, or `null` when it is: at least
 * `OFFER_FLOOR_MIN_CARRIED` games arrived carrying an offer of the store, and the mapping names a
 * product there for fewer than half of them (`OFFER_FLOOR_RATIO`). The same two numbers as the
 * floor under a read, for the same reason, one step earlier.
 *
 * An offer exists only because a reference did, and a reference is never taken back in bulk: a
 * record is rewritten one game at a time, when RAWG is asked about that game again. So in the
 * ordinary way every game that carries an offer has its reference, a few may lose theirs — a
 * record that will not parse, a link RAWG dropped — and most of them losing it at once is the
 * mapping that is lost, not the references. Under the count, and from half up, the rule is what
 * it always was: an offer without a reference is dropped.
 */
export function referencesLookLost(carrying: number, referenced: number): string | null {
  if (carrying < OFFER_FLOOR_MIN_CARRIED || referenced >= carrying * OFFER_FLOOR_RATIO) return null
  return (
    `carried ${carrying}, the mapping names a product for ${referenced} of those games: ` +
    'under half, so the store references look lost'
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
export function titled(title: string | null): { title?: string } {
  return title === null ? {} : { title }
}

/** A game's Microsoft Store product as a reference holds it. */
type MicrosoftRef = NonNullable<IndexedStoreRefs['microsoft']>

/** What the mapping holds for one game, as far as this stage may use it. */
interface GameReferences {
  /** What RAWG's links named (`usableStoreRefs`). */
  usable: IndexedStoreRefs
  /** What the stores' own ways found, and when they last looked (`usableFallbacks`). */
  fallbacks: UsableFallbacks
}

/**
 * Whether the mapping names the game's product in a store: by RAWG's link, or by what one of the
 * store's own ways found. Either is a reference an offer may stand on. For the PlayStation Store,
 * which has no other way, it is the title RAWG's link gave: what the game's offer there rests on,
 * whether or not Sony has yet been asked which concept the title belongs to.
 */
function hasReference({ usable, fallbacks }: GameReferences, store: OfferStore): boolean {
  switch (store) {
    case 'gog':
      return typeof usable.gog === 'string' || fallbacks.gog !== null
    case 'xbox-store':
      return Boolean(usable.microsoft) || fallbacks.microsoft.found !== null
    case 'playstation-store':
      return Boolean(usable.playstation)
  }
}

/** The way an offer was found as the offer carries it: no field at all for RAWG's link. */
function foundBy(via: OfferWay): { via?: OfferWay } {
  return via === 'link' ? {} : { via }
}

/** How many of `ways` there are of each, as a report states it. */
function countWays<Way extends string>(ways: readonly Way[]): Partial<Record<Way, number>> {
  const counts: Partial<Record<Way, number>> = {}
  for (const way of ways) counts[way] = (counts[way] ?? 0) + 1
  return counts
}

/** The games with the most players first; the lower RAWG id first between two as popular. */
function byPopularity(left: { game: IndexedGame }, right: { game: IndexedGame }): number {
  return right.game.popularity - left.game.popularity || left.game.id - right.game.id
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
export function setOffer(game: IndexedGame, store: OfferStore, offer: IndexedOffer | null): void {
  const others = (game.offers ?? []).filter((candidate) => candidate.store !== store)
  writeOffers(game, offer ? [...others, offer] : others)
}

export function countOffers(games: readonly IndexedGame[], store: OfferStore): number {
  return games.filter((game) => game.offers?.some((offer) => offer.store === store)).length
}

/**
 * A lock renewal that cannot be mistaken for a store's failure. The reads renew the lock as they
 * go, from inside the code whose failures mean "the store is down"; an index that will not renew
 * is another matter, and is thrown once the store's own verdict is in.
 *
 * `held` is for a read long enough to be worth cutting short: a run whose lock will not renew
 * cannot publish, so nothing more need be asked of a store on its behalf.
 */
export function createLockKeeper(deps: JobDeps) {
  let failure: unknown = null
  return {
    renew: async (): Promise<void> => {
      try {
        await deps.writer.renewLock()
      } catch (error) {
        failure ??= error
      }
    },
    held: (): boolean => failure === null,
    assertHeld: (): void => {
      if (failure !== null) throw failure
    },
  }
}

/**
 * What is reported of a store whose mapping is not believed (`referencesLookLost`): nothing was
 * asked and nothing was dropped, and the stamp is the published one.
 *
 * **The store is not read at all in that state**, not even for the games the mapping still
 * names. A read of what is left could not be a read in full — it would move the stamp and put
 * the next one off by eleven hours on the strength of a mapping nobody believes — and a read
 * that may neither move the stamp nor remove anything is a partial read under another name, due
 * again on every run: the job's own fault would have it ask the store twice as often as on a
 * good day. What it costs is the freshness of the few offers that still have a reference, for as
 * long as the mapping is away; their dates stay honest, and the site shows no price it cannot
 * call fresh.
 */
function notRead(
  deps: JobDeps,
  name: string,
  references: number,
  lastReadAt: string | undefined,
  reason: string,
): StoreReadReport {
  deps.log(`${name}: ${reason}; every offer is kept as it was and the store is not read`)
  return {
    status: 'references-lost',
    references,
    pricesRead: 0,
    failed: 0,
    requests: 0,
    offers: 0,
    lastReadAt: lastReadAt ?? null,
    error: reason,
  }
}

/** What the stage knows of one game at GOG before the walk. */
interface GogEntry {
  game: IndexedGame
  /** RAWG's slug for the game, when its link named one. */
  slug: string | null
  /** What the last walk settled on by the game's name, if anything. */
  found: GogFound | null
  /**
   * Whether the game may be looked for by its name: RAWG named a slug for it — which may not be
   * in the catalog any more — or lists it on GOG without a link the job can read.
   */
  byName: boolean
}

/**
 * GOG: one walk of the catalog, and every game looked up in it. All or nothing — a walk that
 * fails at any page, or cannot prove itself whole (`walkGogCatalog`), or would leave under half
 * the offers the documents carried (`belowOfferFloor`), publishes nothing new and takes nothing
 * away.
 *
 * **A game is looked up by RAWG's slug first**, and a slug that is in the catalog settles it: the
 * product's price, or no price when GOG states none — a game that is not out yet is not looked
 * for under another title. **Only a game whose slug is not in the catalog at all, or that RAWG
 * lists on GOG without a link, is looked for by its name** (`findGogProduct`). That is done in
 * every walk, for it costs no request, and so the offer of such a game is always for what this
 * walk found: another product when a cheaper one qualifies now, and none when none does.
 *
 * What a walk found by name is written to the game's record (`IndexedStoreFallbacks.gog`) before
 * any document is touched, and only when it differs from what the record says: an offer needs a
 * reference, and the runs between two walks have to find one.
 */
async function readGog(
  deps: JobDeps,
  entries: GogEntry[],
  refs: StoreRefMap,
  lastReadAt: string | undefined,
  laterNamesakes: ReadonlySet<number>,
): Promise<StoreReadReport> {
  const referenced = entries.filter((entry) => entry.slug !== null || entry.found !== null)
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
  if (entries.length === 0) return report({ status: 'no-references' })
  if (!isOffersReadDue(lastReadAt, deps.clock.now())) return report({ status: 'not-due' })

  const lock = createLockKeeper(deps)
  const carried = countOffers(
    entries.map((entry) => entry.game),
    'gog',
  )
  let requests = 0
  let walk: GogCatalogWalk
  try {
    walk = await walkGogCatalog((page) => {
      requests += 1
      return deps.gog(page)
    }, lock.renew)
  } catch (error) {
    lock.assertHeld()
    const reason = reasonOf(error)
    deps.log(
      `gog: the catalog walk failed after ${requests} requests, keeping every offer: ${reason}`,
    )
    return report({ status: 'failed', failed: referenced.length, requests, error: reason })
  }
  lock.assertHeld()

  const readAt = isoNow(deps.clock)
  const sellable = gogSellables(walk.products.values())
  // Worked out for every game before any document is touched: whether the read is believed at
  // all is decided on the whole of it.
  const read = entries.map((entry) => {
    const { game, slug } = entry
    const linked = slug === null ? undefined : walk.products.get(slug)
    // What an earlier walk found stands while its own product is sold and still passes the title
    // ways' guards; only then is the catalog looked through again.
    const remembered = entry.found ? walk.products.get(entry.found.slug) : undefined
    const kept =
      !linked &&
      entry.found !== null &&
      Boolean(remembered?.price && remembered.url) &&
      isInTimeForTitle(game, remembered?.releasedAt ?? null, laterNamesakes)
    const match =
      !linked && !kept && entry.byName ? findGogProduct(sellable, game, laterNamesakes) : null
    const product = linked ?? (kept ? remembered : match?.product)
    const via: OfferWay = (kept ? entry.found?.via : match?.via) ?? 'link'
    const offer: IndexedOffer | null =
      product?.price && product.url
        ? {
            store: 'gog',
            ...foundBy(via),
            ...titled(product.title),
            ...product.price,
            currency: 'USD',
            url: product.url,
            updatedAt: readAt,
          }
        : null
    return { entry, offer, byName: !linked && (kept || entry.byName), kept, linked, match, via }
  })
  const pricesRead = read.filter((result) => result.offer !== null).length

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

  // The mapping first, the documents after: a record says what this walk settled on by name, and
  // is rewritten only for a game whose answer changed.
  const rewritten: [number, IndexedStoreRefs][] = []
  for (const { entry, match, kept, linked } of read) {
    // RAWG's slug priced it, or the earlier find stands: the record says what it said.
    if (linked || kept) continue
    const before = entry.found
    const same = match
      ? before !== null && before.slug === match.product.slug && before.via === match.via
      : before === null
    if (same) continue
    const record = withGogFound(
      refs.get(entry.game.id) ?? {},
      match ? { slug: match.product.slug, via: match.via, foundAt: readAt } : null,
    )
    refs.set(entry.game.id, record)
    rewritten.push([entry.game.id, record])
  }
  if (rewritten.length > 0) {
    try {
      await deps.writer.setStoreRefs(rewritten)
    } catch (cause) {
      // An offer is not published for a product the mapping does not name, and an index that
      // will not take a few records is not a reason to fail a run whose prices are good: the
      // walk is reported as failed, and every offer and the stamp stay as they were.
      for (const [id, record] of rewritten) {
        refs.set(id, withGogFound(record, entries.find((e) => e.game.id === id)?.found ?? null))
      }
      const reason = `the store references could not be written: ${reasonOf(cause)}`
      deps.log(`gog: ${reason}; every offer is kept as it was`)
      return report({ status: 'failed', failed: referenced.length, requests, error: reason })
    }
  }

  for (const { entry, offer } of read) setOffer(entry.game, 'gog', offer)

  const lookedFor = read.filter((result) => result.byName)
  const byName = lookedFor.flatMap((result) =>
    result.offer !== null && result.via !== 'link' ? [result.via as FallbackWay] : [],
  )
  deps.log(
    `gog: ${referenced.length} references, ${pricesRead} prices read in ${requests} requests` +
      (lookedFor.length > 0
        ? `; ${lookedFor.length} looked for by name, ${byName.length} found`
        : ''),
  )
  return report({
    pricesRead,
    requests,
    lastReadAt: readAt,
    ...(lookedFor.length > 0
      ? {
          fallbacks: {
            searched: lookedFor.length,
            found: countWays(byName),
            waiting: 0,
            requests: 0,
          },
        }
      : {}),
  })
}

/** What the stage knows of one game at the Microsoft Store before the read. */
interface MicrosoftEntry {
  game: IndexedGame
  /** The game's record as the run read it, to put back should the index refuse a newer one. */
  record: IndexedStoreRefs | undefined
  /** RAWG's product for the game, when its link named one. */
  link: MicrosoftRef | null
  /** The product the store's own ways settled on in an earlier run, if any. */
  found: MicrosoftFound | null
  /** When those ways were last tried for the game, or `null` for never. */
  searchedAt: string | null
  /**
   * Whether the store's own ways may be tried for the game: RAWG named a product for it, or
   * lists it on the Xbox store without a link the job can read.
   */
  searchable: boolean
}

/** What a read made of one game: an offer, no price, or no answer for one of its products. */
type MicrosoftVerdict =
  { state: 'priced'; offer: IndexedOffer } | { state: 'unpriced' } | { state: 'unanswered' }

/** The offer of a product the Microsoft Store sells, or `null` when its page has no address. */
function microsoftOffer(
  product: MicrosoftRef,
  sold: MicrosoftProduct,
  via: OfferWay,
  readAt: string,
): IndexedOffer | null {
  const url = safeExternalUrl(microsoftProductUrl(product))
  return url === null
    ? null
    : {
        store: 'xbox-store',
        ...foundBy(via),
        ...titled(sold.title),
        ...sold.price,
        currency: 'UAH',
        url,
        updatedAt: readAt,
      }
}

/**
 * The Microsoft Store: the product ids the mapping names a hundred a request. A request is the
 * unit of failure here, as a chunk is for Steam's prices, and what a read may do depends on
 * whether any failed:
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
 *
 * **Two products may be asked about for one game**: the one RAWG's link names, and the one the
 * store's own ways settled on in an earlier run (`IndexedStoreFallbacks.microsoft`). The order of
 * the ways holds in every read: the link's product is the game's price whenever it has one, and
 * the found product only when the link's has none. A game is not settled by half an answer —
 * when the request about either of its products failed and nothing ahead of it in that order was
 * priced, the game keeps the offer it had.
 *
 * **After a full read that was believed, the store's own ways are tried**
 * (`findMicrosoftProducts`) for the games it left without a price — RAWG's product is not sold,
 * or RAWG lists the game on the store with no link to read — and that have not been tried in the
 * last thirty days: `MICROSOFT_SEARCHES_PER_RUN` of them a run, the most popular first. What
 * they come to is written to the mapping first and to the documents after. They are not tried
 * after a read that failed in any part, or that the floor refused: a store that is failing its
 * requests is not asked for more, and a job that may be misreading the store finds nothing new
 * in it.
 *
 * Known and left as it is: a request that fails every time is never narrowed down. Should one id
 * ever make the catalog refuse its whole request, the hundred games beside it would never be
 * refreshed and the stamp would never move, so every run would repeat all the requests instead of
 * every other one. The warning a failed read now writes (`run.ts`) is what would show it; the
 * remedy, if it is ever seen, is to ask a failed request again in two halves.
 */
async function readMicrosoft(
  deps: JobDeps,
  entries: MicrosoftEntry[],
  refs: StoreRefMap,
  lastReadAt: string | undefined,
  laterNamesakes: ReadonlySet<number>,
): Promise<StoreReadReport> {
  const referenced = entries.filter((entry) => entry.link !== null || entry.found !== null)
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
  if (entries.length === 0) return report({ status: 'no-references' })
  if (!isOffersReadDue(lastReadAt, deps.clock.now())) return report({ status: 'not-due' })

  // Two games can name one product, and one game two; each product is asked about once.
  const asked = new Set<string>()
  for (const { link, found: earlier } of referenced) {
    if (link) asked.add(link.id)
    if (earlier) asked.add(earlier.id)
  }

  const lock = createLockKeeper(deps)
  const carried = countOffers(
    referenced.map((entry) => entry.game),
    'xbox-store',
  )
  /** What the answered requests said of each product: sold or not, and when that was read. */
  const answers = new Map<string, { sold: MicrosoftProduct | null; readAt: string }>()
  const unanswered = new Set<string>()
  let requests = 0
  let failedRequests = 0
  let error: string | undefined
  for (const ids of chunk([...asked], MICROSOFT_IDS_PER_REQUEST)) {
    requests += 1
    try {
      const sold = parseMicrosoftProducts(await deps.microsoft(ids), ids, deps.clock.now())
      const readAt = isoNow(deps.clock)
      for (const id of ids) answers.set(id, { sold: sold.get(id) ?? null, readAt })
    } catch (cause) {
      failedRequests += 1
      for (const id of ids) unanswered.add(id)
      error = reasonOf(cause)
      deps.log(
        `microsoft: a request for ${ids.length} products failed, keeping their offers: ${error}`,
      )
    }
    await lock.renew()
  }
  lock.assertHeld()

  /** The ways in their order: RAWG's product first, then the one found by the store's own. */
  const verdictOn = (entry: MicrosoftEntry): MicrosoftVerdict => {
    const products: [MicrosoftRef | null, OfferWay][] = [
      [entry.link, 'link'],
      [entry.found, entry.found?.via ?? 'link'],
    ]
    for (const [product, via] of products) {
      if (!product) continue
      if (unanswered.has(product.id)) return { state: 'unanswered' }
      const answer = answers.get(product.id)
      // A product found by a title is held to the title ways' guards each time it is read, so
      // that a find made before a guard was added cannot outlive it.
      const judged =
        via === 'name' || via === 'edition'
          ? answer?.sold && isInTimeForTitle(entry.game, answer.sold.releasedAt, laterNamesakes)
          : true
      const offer =
        answer?.sold && judged ? microsoftOffer(product, answer.sold, via, answer.readAt) : null
      if (offer) return { state: 'priced', offer }
    }
    return { state: 'unpriced' }
  }
  const verdicts = referenced.map((entry) => ({ entry, verdict: verdictOn(entry) }))
  // A product an earlier run found by a title, which the title ways' guards now refuse, is no
  // longer the game's: it is not carried into the next look either.
  for (const { entry } of verdicts) {
    const { found: earlier } = entry
    const sold = earlier ? answers.get(earlier.id)?.sold : null
    if (
      earlier &&
      sold &&
      (earlier.via === 'name' || earlier.via === 'edition') &&
      !isInTimeForTitle(entry.game, sold.releasedAt, laterNamesakes)
    ) {
      entry.found = null
    }
  }
  const priced = verdicts.flatMap(({ entry, verdict }) =>
    verdict.state === 'priced' ? [{ game: entry.game, offer: verdict.offer }] : [],
  )
  const failed = verdicts.filter(({ verdict }) => verdict.state === 'unanswered').length

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

  for (const { entry, verdict } of verdicts) {
    setOffer(entry.game, 'xbox-store', verdict.state === 'priced' ? verdict.offer : null)
  }
  deps.log(
    `microsoft: ${referenced.length} references, ${priced.length} prices read, 0 failed, in ${requests} requests`,
  )
  // The read's own moment: what follows may take minutes, and is not what the stamp is of.
  const readAt = isoNow(deps.clock)

  const pricedGames = new Set(priced.map(({ game }) => game.id))
  const waiting = entries
    .filter(
      (entry) =>
        entry.searchable &&
        !pricedGames.has(entry.game.id) &&
        isMicrosoftSearchDue(entry.searchedAt, deps.clock.now()),
    )
    .sort(byPopularity)
  const fallbacks =
    waiting.length > 0
      ? await tryMicrosoftWays(deps, waiting, refs, lock, laterNamesakes)
      : undefined

  return report({
    pricesRead: priced.length,
    requests,
    lastReadAt: readAt,
    ...(fallbacks ? { fallbacks } : {}),
  })
}

/**
 * The store's own ways for the games a full read left without a price, the most popular
 * `MICROSOFT_SEARCHES_PER_RUN` of them, and what they came to put where it belongs.
 *
 * **The mapping first.** For every game the ways were tried for to the end, the record says when
 * (`searchedAt`), and which product they settled on, if any. A game they found nothing for keeps
 * the product an earlier run found: it is not on sale today, it is asked about in every read all
 * the same, and it may be sold again before the thirty days are out. Only then is an offer put on
 * a document — a published offer always has its reference.
 *
 * A game the ways were not tried for to the end — its request failed, or the ways stopped before
 * its turn — is written nowhere, and is still waiting.
 *
 * Nothing Microsoft does here reaches the caller as a failure. An index that will not take the
 * records, or will not renew the lock, is the index failing, and is thrown as that.
 */
async function tryMicrosoftWays(
  deps: JobDeps,
  waiting: MicrosoftEntry[],
  refs: StoreRefMap,
  lock: ReturnType<typeof createLockKeeper>,
  laterNamesakes: ReadonlySet<number>,
): Promise<StoreFallbackReport> {
  const turn = waiting.slice(0, MICROSOFT_SEARCHES_PER_RUN)
  let result: MicrosoftFallbackResult
  try {
    result = await findMicrosoftProducts(deps, turn, lock.renew, laterNamesakes)
  } catch (cause) {
    // It is written to throw nothing; should it ever, that costs this run its finds and no more.
    result = { settled: new Map(), requests: 0, stopped: 'failures', error: reasonOf(cause) }
  }
  lock.assertHeld()

  const searchedAt = isoNow(deps.clock)
  const byGame = new Map(turn.map((entry) => [entry.game.id, entry]))
  const rewritten: [number, IndexedStoreRefs][] = []
  const offers: { game: IndexedGame; offer: IndexedOffer }[] = []
  const ways: FallbackWay[] = []
  for (const [gameId, find] of result.settled) {
    const entry = byGame.get(gameId)
    if (!entry) continue
    const product = find ? { id: find.id, name: find.name } : null
    const offer =
      find && product ? microsoftOffer(product, find.product, find.via, find.readAt) : null
    const remembered: MicrosoftFallback = {
      searchedAt,
      ...(find && product && offer
        ? { found: { ...product, via: find.via, foundAt: find.readAt } }
        : entry.found
          ? { found: entry.found }
          : {}),
    }
    const record = withMicrosoftFallback(refs.get(gameId) ?? {}, remembered)
    refs.set(gameId, record)
    rewritten.push([gameId, record])
    if (find && offer) {
      offers.push({ game: entry.game, offer })
      ways.push(find.via)
    }
  }
  if (rewritten.length > 0) {
    try {
      await deps.writer.setStoreRefs(rewritten)
    } catch (cause) {
      // Nothing of this run's finds is published or remembered: the offers the read left stand,
      // and every game tried is still waiting. An index that will not take a few records is no
      // reason to fail a run whose prices are good.
      for (const [id] of rewritten) {
        const entry = byGame.get(id)
        if (entry?.record) refs.set(id, entry.record)
        else refs.delete(id)
      }
      const error = `the store references could not be written: ${reasonOf(cause)}`
      deps.log(`microsoft: ${error}; nothing the store's own ways found is published`)
      return {
        searched: result.settled.size,
        found: {},
        waiting: waiting.length,
        requests: result.requests,
        stopped: 'index',
        error,
      }
    }
  }
  for (const { game, offer } of offers) setOffer(game, 'xbox-store', offer)

  const left = waiting.length - result.settled.size
  deps.log(
    `microsoft: the store's own ways were tried for ${result.settled.size} games in ` +
      `${result.requests} requests, ${offers.length} found, ${left} waiting` +
      (result.stopped === 'refused' ? ' — stopped early, the store refused a request' : '') +
      (result.stopped === 'failures' ? ' — stopped early, too many requests failed' : '') +
      (result.stopped === 'time' ? ' — stopped early, they had used their ten minutes' : ''),
  )
  return {
    searched: result.settled.size,
    found: countWays(ways),
    waiting: left,
    requests: result.requests,
    ...(result.stopped ? { stopped: result.stopped } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
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
  try {
    // Inside the guard like the request itself: the day is worked out by the runtime's time-zone
    // data, and a runtime without Kyiv in it must cost a run its rate, not the run.
    const date = kyivDate(now)
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
  const gogGames: GogEntry[] = []
  const microsoftGames: MicrosoftEntry[] = []

  const arrived = games.map((game) => {
    const record = refs.get(game.id)
    return {
      game,
      record,
      references: { usable: usableStoreRefs(record), fallbacks: usableFallbacks(record) },
      carried: (Array.isArray(game.offers) ? game.offers : []).filter((offer) =>
        OFFER_STORES.includes(offer?.store),
      ),
    }
  })

  // Before anything is dropped: is the mapping to be believed about each store at all?
  const lost: Partial<Record<OfferStore, string>> = {}
  for (const store of OFFER_STORES) {
    const carrying = arrived.filter((entry) => entry.carried.some((offer) => offer.store === store))
    const referenced = carrying.filter((entry) => hasReference(entry.references, store)).length
    const reason = referencesLookLost(carrying.length, referenced)
    if (reason) lost[store] = reason
  }

  /** Games that lose an offer of each store here, for want of a reference the mapping has not. */
  const dropped: Record<OfferStore, number> = { gog: 0, 'xbox-store': 0, 'playstation-store': 0 }
  for (const { game, record, references, carried } of arrived) {
    const { usable, fallbacks } = references
    // A store RAWG lists the game on and gave no link for (`null`) is one the game may still be
    // found in by its name: that is an answer about the link, not about the store.
    const slug = usable.gog ?? null
    const gogByName = slug !== null || (record?.gog === null && game.stores.includes('gog'))
    if (gogByName || fallbacks.gog) {
      gogGames.push({ game, slug, found: fallbacks.gog, byName: gogByName })
    }
    const link = usable.microsoft ?? null
    const searchable =
      link !== null || (record?.microsoft === null && game.stores.includes('xbox-store'))
    if (searchable || fallbacks.microsoft.found) {
      microsoftGames.push({ game, record, link, ...fallbacks.microsoft, searchable })
    }
    // The mapping is the only authority for which stores a game may carry an offer of — for as
    // long as it is believed about that store. Store by store: what is held, or dropped, of one
    // store says nothing about the other.
    const kept = carried.filter(
      (offer) => lost[offer.store] !== undefined || hasReference(references, offer.store),
    )
    for (const store of OFFER_STORES) {
      const had = carried.some((offer) => offer.store === store)
      if (had && !kept.some((offer) => offer.store === store)) dropped[store] += 1
    }
    writeOffers(game, kept)
  }

  const previous = published?.offersReadAt ?? {}
  // The games a later game of the run shares a name with: no title is theirs.
  const laterNamesakes = gamesWithLaterNamesakes(games)
  const referencedAt = (store: OfferStore) =>
    arrived.filter((entry) => hasReference(entry.references, store)).length
  const gog = lost.gog
    ? notRead(deps, 'gog', referencedAt('gog'), previous.gog, lost.gog)
    : await readGog(deps, gogGames, refs, previous.gog, laterNamesakes)
  const microsoft = lost['xbox-store']
    ? notRead(
        deps,
        'microsoft',
        referencedAt('xbox-store'),
        previous['xbox-store'],
        lost['xbox-store'],
      )
    : await readMicrosoft(deps, microsoftGames, refs, previous['xbox-store'], laterNamesakes)
  const rate = await readRate(deps, published)

  for (const [store, read] of [
    ['gog', gog],
    ['xbox-store', microsoft],
  ] as const) {
    read.offers = countOffers(games, store)
    if (dropped[store] > 0) read.dropped = dropped[store]
    const otherWays = games.flatMap((game) =>
      (game.offers ?? []).flatMap((offer) => {
        const way = offerWay(offer)
        return offer.store === store && way !== 'link' ? [way] : []
      }),
    )
    if (otherWays.length > 0) read.otherWays = countWays(otherWays)
  }

  const offersReadAt: Partial<Record<OfferStore, string>> = {}
  if (gog.lastReadAt) offersReadAt.gog = gog.lastReadAt
  if (microsoft.lastReadAt) offersReadAt['xbox-store'] = microsoft.lastReadAt

  // The mapping's verdict on the PlayStation Store goes with the result as it stands: the stage
  // that reads that store asks nothing while the mapping is not believed, as the two above do not.
  const playstation: ReferenceVerdict = {
    lost: lost['playstation-store'] ?? null,
    dropped: dropped['playstation-store'],
  }

  return { gog, microsoft, playstation, rate, offersReadAt, exchangeRate: rate.rate ?? undefined }
}
