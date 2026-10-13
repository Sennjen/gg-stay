import { isPlaystationProductId, isPlaystationTitleId } from './storeRefs'
import { asRecord, discountPercentOf, storeTitle } from './storeUpstream'
import { UpstreamError } from '../../server/upstream/errors'
import { safeExternalUrl } from '../../shared/url'

/**
 * What the PlayStation Store charges a buyer in Ukraine, read from the two endpoints its own
 * application and its own storefront are built on — and the transport that reads them, which is
 * most of this module, because how slowly Sony is asked matters more here than what is asked.
 *
 * **Sony is asked two things, a game at a time.** RAWG's link names a title (`CUSA00419_00`), and
 * the store prices a concept, so a game is first asked about once: which concept its title
 * belongs to in the Ukrainian store (`concept`). After that it is asked about once a day: what
 * the concept's default product costs (`price`). Neither endpoint takes more than one game a
 * request, and nothing else was found that does. Which run asks which, and how often a game is
 * asked at all, is the stage's to say (`playstationOffers.ts`).
 *
 * **The read is rationed, and the ration is the transport's.** Sony documents neither endpoint
 * and its website terms restrict automated access; the project's owner accepted that for a
 * non-commercial site on conditions that are requirements and not tuning
 * (`docs/specs/2026-10-13-playstation-store-prices-design.md`). Every one of them is kept here,
 * inside the one object that can reach Sony at all (`createPlaystationStore`), so that no stage,
 * no later caller and no mistake in a loop can ask faster than the conditions allow:
 *
 * - ten seconds between two requests, of either kind, whatever came of the first
 *   (`PLAYSTATION_PAUSE_MS`);
 * - at most `PLAYSTATION_REQUESTS_PER_RUN` requests in a run, and at most
 *   `PLAYSTATION_BUDGET_MS` of them;
 * - no retry: a request is made once;
 * - the first refusal ends the run's asking, and so do three failures in a row
 *   (`PLAYSTATION_FAILURES_IN_A_ROW`);
 * - the requests say who they are, send no cookie and follow no redirect.
 *
 * It is not built from the shared factory (`server/upstream/createUpstreamFetch.ts`) as the job's
 * other transports are. That one retries, paces from the start of a request rather than from its
 * end, knows nothing of a cap or of a refusal, and gives each transport a limiter of its own —
 * and here two hosts have to share one.
 *
 * **The product, not the game.** A concept's default product is Sony's choice and is not always
 * the game RAWG filed the link under: for Grand Theft Auto V it is the standalone Grand Theft
 * Auto Online. Nothing in either answer was found to tell the two apart, and nothing is matched
 * by title, so the product's own name travels with its price and a page shows it.
 *
 * Every fact here was established on 2026-10-12 and 2026-10-13 and is written down in the design,
 * under "Verified".
 */

const CONCEPTS_URL = 'https://m.np.playstation.com/api/catalog/v2/titles'
const GRAPHQL_URL = 'https://web.np.playstation.com/api/graphql/v1/op'

/**
 * The one operation of the storefront's that is asked for, and the hash Sony registers it under.
 * The storefront accepts only its own registered operations, by the SHA-256 of their text; this
 * is `conceptRetrieveForCtasWithPrice` as the store's own pages ask for it. Should Sony edit the
 * query, the hash stops being known, every price request is refused with a 400, and the stage
 * ends on its third failure with a warning: that is what a change here looks like from outside.
 */
const PRICE_OPERATION = 'conceptRetrieveForCtasWithPrice'
const PRICE_OPERATION_HASH = 'eab9d873f90d4ad98fd55f07b6a0a606e6b3925f2d03b70477234b79c1df30b5'

/** The store whose prices are read, and whose product pages are linked. */
const COUNTRY = 'UA'
const LANGUAGE = 'uk'
const LOCALE = 'uk-UA'
const CURRENCY = 'UAH'

/**
 * What Sony's catalog answers, in both endpoints, for a thing it does not have in the store that
 * was asked about: a title with no concept, a concept that is not sold in Ukraine. The only error
 * that is an answer; every other one is a request that failed.
 */
const NOT_IN_THE_STORE = 3166081

/** Both endpoints answered in about half a second; fifteen is for a slow day. There is no retry. */
const TIMEOUT_MS = 15_000

/**
 * Ten seconds between two requests to Sony, of either kind, whatever came of the first.
 *
 * Counted from the moment the first one ended — its answer in hand, or its failure — to the
 * moment the next one leaves, so two requests are never closer than this however long Sony took
 * over the first.
 */
export const PLAYSTATION_PAUSE_MS = 10_000

/** The most requests one run makes to Sony, of both kinds together. */
export const PLAYSTATION_REQUESTS_PER_RUN = 225

/**
 * The most time one run spends asking Sony: forty minutes from its first request. No request
 * leaves once they have passed, so the stage is over a pause and a timeout later at the latest.
 * At ten seconds and half a second a request, 225 of them are a little under that.
 */
export const PLAYSTATION_BUDGET_MS = 40 * 60_000

/** How many requests may fail one after another before the run stops asking. */
export const PLAYSTATION_FAILURES_IN_A_ROW = 3

/**
 * Why a run stopped asking Sony.
 *
 * The first two are the design working: a run has its ration and uses it. The other two are
 * Sony's doing, and a run that ends on one of them says so in a warning (`run.ts`).
 */
export type PlaystationStop =
  /** The run has made its `PLAYSTATION_REQUESTS_PER_RUN` requests. */
  | 'requests'
  /** The run has used its `PLAYSTATION_BUDGET_MS`. */
  | 'time'
  /** Sony refused a request: a 403, a 429, a redirect, or a page where data was asked for. */
  | 'refused'
  /** `PLAYSTATION_FAILURES_IN_A_ROW` requests failed one after another. */
  | 'failures'

export interface PlaystationStopReport {
  reason: PlaystationStop
  /**
   * What ended it, in this module's own words and never in Sony's: "HTTP 403", "a page instead of
   * data". Fit for a line of the log as it stands.
   */
  detail: string
}

/**
 * Thrown for a question that was not put: the run had already stopped asking. No request was
 * made, so nothing was learnt about the game, and a caller treats it as it treats a game it never
 * reached.
 */
export class PlaystationStopped extends Error {
  constructor(public readonly stop: PlaystationStopReport) {
    super(`Sony is not asked anything more in this run: ${stop.detail}`)
    this.name = 'PlaystationStopped'
  }
}

/** One answer of Sony's, as the transport is handed it by whatever made the request. */
export interface PlaystationResponse {
  status: number
  /** The body when it was JSON; `undefined` when it was anything else, or empty. */
  body: unknown
  /** Whether the answer says of itself that it is a page for a browser (`text/html`). */
  html: boolean
}

/** What the transport is given: the network, the recorded answers, and the job's clock. */
export interface PlaystationRuntime {
  /** Serve the recorded answers (`tests/fixtures/playstation`) and ask the network nothing. */
  fixtures: boolean
  /**
   * One GET, with the headers the transport names added to whatever says who is asking. It must
   * not follow a redirect and must not keep a cookie: a hop the transport did not make is a
   * request it did not count.
   */
  fetch: (
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) => Promise<PlaystationResponse>
  readFixture: (name: string) => Promise<unknown | null>
  /**
   * The clock the pause and the budget are counted on, in milliseconds. It is read for how far
   * apart two moments are and never for what time it is, so it should be one that only goes
   * forward: a wall clock that is set ahead in the middle of a run would shorten a pause.
   */
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface PlaystationPrice {
  /** What is charged now, in kopecks. */
  amount: number
  /** The price without the discount, in kopecks; never below `amount`. */
  regularAmount: number
  discountPercent: number
  /** When the discount ends (ISO), or `null` when there is none or Sony named no moment. */
  saleEndsAt: string | null
}

/** A concept's default product as Sony sells it in Ukraine: what anyone pays for it, and what it is. */
export interface PlaystationProduct {
  /** The product id, of the shape `isPlaystationProductId` knows. */
  id: string
  /** What the store calls the product, as plain text; `null` when it sent nothing that reads as one. */
  title: string | null
  price: PlaystationPrice
  /** The product's page in the Ukrainian store. */
  url: string
}

/**
 * The PlayStation Store as the job's stage sees it: two questions, and what has become of the
 * run's ration. One is built for one run of the job (`createJobPlaystation`, `run.ts`).
 */
export interface PlaystationStore {
  /**
   * Which concept a title belongs to in the Ukrainian store: its id, or `null` when Sony answers
   * that the title has none there. Rejects when the request failed or its answer could not be
   * read, and with `PlaystationStopped` when it was never made.
   */
  concept: (titleId: string) => Promise<number | null>
  /**
   * What a concept's default product costs anyone in Ukraine, or `null` when Sony answered and
   * there is no such price: no default product, none anyone can buy, or a concept the store does
   * not have. Rejects as `concept` does.
   */
  price: (conceptId: number) => Promise<PlaystationProduct | null>
  /** Why nothing more is asked in this run, or `null` while the next question would be put. */
  stopped: () => PlaystationStopReport | null
  /** Requests made in this run so far, of both kinds, whatever came of them. */
  requests: () => number
}

function conceptsUrl(titleId: string): string {
  return `${CONCEPTS_URL}/${titleId}/concepts?country=${COUNTRY}&language=${LANGUAGE}&age=99`
}

function priceUrl(conceptId: number): string {
  const variables = JSON.stringify({ conceptId: String(conceptId) })
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: PRICE_OPERATION_HASH },
  })
  return (
    `${GRAPHQL_URL}?operationName=${PRICE_OPERATION}` +
    `&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`
  )
}

/**
 * The two headers the storefront's endpoint cannot be asked without. The locale is what makes the
 * answer the Ukrainian store's: the price depends on it and not on where the request comes from.
 * `Content-Type` is there although a GET has no body: without it the server refuses the request
 * as a possible cross-site forgery (HTTP 400).
 */
const PRICE_HEADERS = {
  'x-psn-store-locale-override': LOCALE,
  'Content-Type': 'application/json',
} as const

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** A whole, non-negative number of kopecks, or `null`. Sony writes amounts as integers. */
function kopecksOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * The moment a discount ends, as ISO, or `null`. Sony writes it as epoch milliseconds in a
 * string (`"1792623540000"`), which names an instant by itself: there is no zone to get wrong.
 * Thirteen digits, which is every moment from 2001 to 2286; anything else — a date in words, a
 * number of seconds, a number that is not in a string — is no moment this job knows how to read.
 */
function saleEndOf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{13}$/.test(value)) return null
  return new Date(Number(value)).toISOString()
}

/** The qualification that a discount is listed for the buyers of an experiment, and no others. */
const IN_EXPERIMENT = 'USER_IN_EXPERIMENT'

/** One way of buying or of freely downloading a product, with every field the rule reads. */
interface PurchaseEntry {
  type: 'ADD_TO_CART' | 'DOWNLOAD'
  applicability: string
  tiedToSubscription: boolean
  exclusive: boolean
  free: boolean
  branding: string[]
  /** `meta.upSellService`, or `null` where the entry states none. */
  upsell: string | null
  /** The `type` of each of the price's qualifications. */
  qualifications: string[]
  /** `discountedValue` and `basePriceValue`, in kopecks. */
  amount: number
  base: number
  endTime: unknown
}

const UNREADABLE_ENTRY = 'Sony answered with a purchase entry this job cannot read'

/**
 * A `webctas` entry as the rule below weighs it, or `null` for an entry that is not a purchase
 * at all: any `type` but `ADD_TO_CART`, the purchase, and `DOWNLOAD`, a game that is free for
 * everybody. `DOWNLOAD_TRIAL` (a free trial of a paid game), `UPSELL_PS_PLUS_GAME_CATALOG`
 * (included with a subscription), `UPSELL_PS_PLUS_TRIAL` and `UPSELL_GTA_PLUS_FREE` are never
 * prices: three kinds of zero stand beside a paid price, and taking the lowest, or believing
 * `isFree`, would call a paid game free.
 *
 * **A purchase entry that cannot be read is thrown, not passed over.** Every field the rule
 * reads has to be there and be what it has always been — the amounts whole kopecks, the flags
 * flags, the lists lists — and the price has to be in hryvnia, the currency of the store that
 * was asked for. An entry that says "this is not for everybody" is an answer, and gives no
 * price. An entry that has lost a field, or changed the kind of one, is this job not
 * understanding Sony any more: read as "no price" it would remove an offer in a run that ends
 * green, and read as a failure it stops the stage on its third request.
 */
function purchaseEntryOf(entry: unknown): PurchaseEntry | null {
  const cta = asRecord(entry)
  if (!cta || (cta.type !== 'ADD_TO_CART' && cta.type !== 'DOWNLOAD')) return null
  const price = asRecord(cta.price)
  if (!price || price.currencyCode !== CURRENCY) throw new Error(UNREADABLE_ENTRY)

  const { applicability, isTiedToSubscription, isExclusive, isFree, serviceBranding } = price
  const amount = kopecksOf(price.discountedValue)
  const base = kopecksOf(price.basePriceValue)
  const upsell = asRecord(cta.meta)?.upSellService ?? null
  const qualifications = Array.isArray(price.qualifications)
    ? price.qualifications.map((qualification) => asRecord(qualification)?.type)
    : null
  if (
    typeof applicability !== 'string' ||
    typeof isTiedToSubscription !== 'boolean' ||
    typeof isExclusive !== 'boolean' ||
    typeof isFree !== 'boolean' ||
    !Array.isArray(serviceBranding) ||
    !serviceBranding.every((brand): brand is string => typeof brand === 'string') ||
    (upsell !== null && typeof upsell !== 'string') ||
    !qualifications?.every((kind): kind is string => typeof kind === 'string') ||
    amount === null ||
    base === null
  ) {
    throw new Error(UNREADABLE_ENTRY)
  }
  return {
    type: cta.type,
    applicability,
    tiedToSubscription: isTiedToSubscription,
    exclusive: isExclusive,
    free: isFree,
    branding: serviceBranding,
    upsell,
    qualifications,
    amount,
    base,
    endTime: price.endTime,
  }
}

/**
 * Whether the entry is offered to everybody, leaving aside whom its discount is for: the price is
 * `APPLICABLE` and not an `UPSELL`; it is not tied to a subscription and not exclusive; and it is
 * branded with no service (`serviceBranding` is exactly `["NONE"]`, and `meta.upSellService`,
 * where stated, is `NONE`). Each is one of the ways the store was seen to mark a subscriber's
 * price.
 */
function isForEverybody(entry: PurchaseEntry): boolean {
  return (
    entry.applicability === 'APPLICABLE' &&
    !entry.tiedToSubscription &&
    !entry.exclusive &&
    entry.branding.length === 1 &&
    entry.branding[0] === 'NONE' &&
    (entry.upsell === null || entry.upsell === 'NONE')
  )
}

/**
 * The price anyone in Ukraine can buy the product at through this entry, or `null` when the entry
 * is not that: it is for everybody (`isForEverybody`), **it has no qualification**, and a purchase
 * is not free and charges more than nothing, while a free game charges nothing and has no regular
 * price above nothing.
 */
function plainPriceOf(entry: PurchaseEntry): PlaystationPrice | null {
  if (!isForEverybody(entry) || entry.qualifications.length > 0) return null
  const { amount, base } = entry
  if (entry.type === 'ADD_TO_CART' && (entry.free || amount === 0)) return null
  if (entry.type === 'DOWNLOAD' && (!entry.free || amount !== 0 || base !== 0)) return null

  const regularAmount = Math.max(amount, base)
  return {
    amount,
    regularAmount,
    discountPercent: discountPercentOf(amount, regularAmount),
    // A sale's end belongs to a sale: an entry at its regular price has none, whatever it says.
    saleEndsAt: amount < regularAmount ? saleEndOf(entry.endTime) : null,
  }
}

/**
 * The regular price of a purchase whose discount is listed for the buyers of an experiment, or
 * `null` when the entry is not that.
 *
 * A sale can be listed with `qualifications` of type `USER_IN_EXPERIMENT` — seen on Red Dead
 * Redemption 2 and on Metro Exodus, both of one campaign. Such a discount is one price for some
 * buyers and another for the rest, and which of them a visitor is cannot be known, so the
 * discounted amount is never taken. The base price under it is what everybody else is charged:
 * on both entries it is the same whole sum the product's other entries carry. So the entry is
 * taken **at its base price, as a price with no discount and no end of a sale**, on conditions
 * that are all of the rule:
 *
 * - every qualification is `USER_IN_EXPERIMENT`. An entitlement, an owner's upgrade or anything
 *   else may be a condition on the base itself, and stays no price;
 * - the entry is otherwise a purchase for everybody (`isForEverybody`), and not free;
 * - its base price is above nothing;
 * - and it is only ever a fallback (`playstationPurchasePrice`): a product with an unqualified
 *   purchase has that one's price.
 *
 * What it shows is the dearer of two sums the store may charge: the row never promises a
 * discount, and where the store gives one the buyer finds it on the store's page.
 */
function experimentPriceOf(entry: PurchaseEntry): PlaystationPrice | null {
  if (entry.type !== 'ADD_TO_CART' || !isForEverybody(entry) || entry.free) return null
  const { qualifications, base } = entry
  if (qualifications.length === 0 || !qualifications.every((kind) => kind === IN_EXPERIMENT)) {
    return null
  }
  return base > 0
    ? { amount: base, regularAmount: base, discountPercent: 0, saleEndsAt: null }
    : null
}

/** The earlier of two moments a discount may end at; a moment before none at all. */
function earlier(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return left ?? right
  return left <= right ? left : right
}

/**
 * The price anyone pays for a product, from its `webctas` — each a way of getting the product —
 * or `null` when none of them is such a price.
 *
 * It is the product's unqualified purchase (`plainPriceOf`). Only a product that has none is
 * looked at again for a purchase whose discount is an experiment's, which is taken at its regular
 * price (`experimentPriceOf`); the two kinds are never weighed against each other.
 *
 * Every priced product seen had exactly one such entry. Should there be several, they have to
 * agree to the kopeck, as the Microsoft Store's availabilities have to
 * (`microsoftPurchasePrice`): when they do not, there is no telling which a visitor would be
 * charged, so there is no price. Where they agree and name two ends for the discount, the earlier
 * one stands — a regular price shown a little early is the lesser mistake.
 *
 * Throws for a purchase entry that cannot be read (`purchaseEntryOf`), and for `webctas` that are
 * not a list.
 */
export function playstationPurchasePrice(webctas: unknown): PlaystationPrice | null {
  if (!Array.isArray(webctas)) throw new Error(UNREADABLE_ENTRY)
  const entries = webctas.flatMap((entry) => {
    const purchase = purchaseEntryOf(entry)
    return purchase ? [purchase] : []
  })
  const priced = (rule: (entry: PurchaseEntry) => PlaystationPrice | null) =>
    entries.flatMap((entry) => {
      const price = rule(entry)
      return price ? [price] : []
    })
  const plain = priced(plainPriceOf)
  const candidates = plain.length > 0 ? plain : priced(experimentPriceOf)

  let found: PlaystationPrice | null = null
  for (const price of candidates) {
    if (!found) {
      found = price
      continue
    }
    if (found.amount !== price.amount || found.regularAmount !== price.regularAmount) return null
    found = { ...found, saleEndsAt: earlier(found.saleEndsAt, price.saleEndsAt) }
  }
  return found
}

/** The product's page in the Ukrainian store, from an id that has the shape of one. */
export function playstationProductUrl(productId: string): string {
  return `https://store.playstation.com/uk-ua/product/${productId}`
}

/**
 * What a list of GraphQL errors says, when every one of them says the same thing: Sony's own
 * error code, or `null` when they differ or carry none.
 */
function errorCodeOf(errors: readonly unknown[]): number | null {
  const codes = errors.map((error) => asRecord(asRecord(error)?.extensions)?.errorCode)
  const [first] = codes
  return typeof first === 'number' && Number.isSafeInteger(first) && codes.every((c) => c === first)
    ? first
    : null
}

/**
 * Which concept Sony's answer names for the title that was asked about: its id, or `null` when
 * the answer is that the title has none in the Ukrainian store.
 *
 * The answer is a list with an entry about the title. An entry is taken only when it names the
 * title among its `titleIds` — a title asked about under its American id comes back in a concept
 * that lists it beside the European ones, which is the whole of how the mapping works — and then:
 *
 * - one concept's `id`, in one entry or repeated in several — that concept;
 * - an entry with `errorCode` `NOT_IN_THE_STORE` and no `id` — no concept. Every PlayStation 3
 *   and Vita title answers so, and so does a title id Sony has never heard of;
 * - several different concepts for one title — no concept either. Choosing among them would be a
 *   guess, and a guess here is another game's price.
 *
 * Anything else is thrown, as the failure it is: an answer that is not such a list, one that says
 * nothing of the title, an error of another kind. "No concept" is remembered for thirty days
 * (`IndexedStoreRefs`), so it is said only when Sony said it.
 */
export function parsePlaystationConcept(body: unknown, titleId: string): number | null {
  if (!Array.isArray(body)) {
    throw new Error('Sony answered about a title with something that is not a list of concepts')
  }
  const about = body.flatMap((entry) => {
    const record = asRecord(entry)
    return record && Array.isArray(record.titleIds) && record.titleIds.includes(titleId)
      ? [record]
      : []
  })
  if (about.length === 0) throw new Error('Sony answered without a word about the title asked for')

  const concepts = new Set<number>()
  for (const entry of about) {
    const { id, errorCode } = entry
    if (errorCode !== undefined && errorCode !== null) {
      if (errorCode === NOT_IN_THE_STORE && id === undefined) continue
      throw new Error('Sony answered about a title with an error that is not "no such title"')
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('Sony answered about a title with a concept that has no id')
    }
    concepts.add(id)
  }
  const [only] = concepts
  return concepts.size === 1 && only !== undefined ? only : null
}

/**
 * What Sony's answer says the concept's default product costs anyone in Ukraine, or `null` when
 * the answer is that there is no such price:
 *
 * - the concept is not in the Ukrainian store — `errors` that all carry `NOT_IN_THE_STORE`, over
 *   a `conceptRetrieve` of `null`;
 * - the concept has no default product (`defaultProduct: null`) — nothing of it is on sale, as
 *   for Grand Theft Auto: San Andreas, or it has a product and Sony puts none first, as for
 *   Stardew Valley. No other product is chosen in its place;
 * - the default product has no entry anyone can buy at (`playstationPurchasePrice`);
 * - its id is not one this job could build an address from: a price nobody can be sent to is no
 *   offer.
 *
 * Anything else is thrown, and a caller keeps the offer it had: any other `errors`, an answer
 * about another concept than the one asked for, a default product or a list of `webctas` that is
 * missing rather than `null`, a purchase entry that has lost a field or is in another currency.
 * A field that has gone is this job not understanding the answer any more, and that must never
 * read as "Sony does not sell it".
 */
export function parsePlaystationPrice(body: unknown, conceptId: number): PlaystationProduct | null {
  const answer = asRecord(body)
  if (!answer) throw new Error('Sony answered about a price with something that is not an object')
  const data = asRecord(answer.data)

  if (answer.errors !== undefined && answer.errors !== null) {
    const errors = Array.isArray(answer.errors) ? answer.errors : []
    const code = errors.length > 0 ? errorCodeOf(errors) : null
    if (code === NOT_IN_THE_STORE && data?.conceptRetrieve === null) return null
    throw new Error(
      code === null
        ? 'Sony answered about a price with errors'
        : `Sony answered about a price with error ${code}`,
    )
  }

  const concept = asRecord(data?.conceptRetrieve)
  if (!concept) throw new Error('Sony answered about a price without the concept asked for')
  if (concept.id !== String(conceptId)) {
    throw new Error('Sony answered about another concept than the one asked for')
  }
  if (concept.defaultProduct === null) return null
  const product = asRecord(concept.defaultProduct)
  if (!product || !Array.isArray(product.webctas)) {
    throw new Error('Sony answered about a price without a default product that can be read')
  }
  // The product says which concept it is of. Where it does, it has to be this one.
  const own = asRecord(product.concept)?.id
  if (own !== undefined && own !== String(conceptId)) {
    throw new Error('Sony answered with a default product of another concept')
  }

  const price = playstationPurchasePrice(product.webctas)
  if (!price || !isPlaystationProductId(product.id)) return null
  const url = safeExternalUrl(playstationProductUrl(product.id))
  return url ? { id: product.id, title: storeTitle(product.name), price, url } : null
}

/**
 * Builds the one object through which a run of the job reaches Sony.
 *
 * **One request at a time, in the order the questions were put.** Every question stands in one
 * line, whichever of the two it is and whoever put it, and the next leaves only when the one
 * before it has ended and `PLAYSTATION_PAUSE_MS` have passed since. Two calls made together are
 * therefore two requests ten seconds apart, not two requests.
 *
 * **What ends the asking.** Before a request leaves, the run's ration is looked at: the cap, and
 * whether the request would leave inside the budget, which is counted from the first request of
 * the run. After it comes back, so is what came of it:
 *
 * - a 403, a 429, a redirect, a page for a browser, or a success that is not data at all — a
 *   refusal, and the run asks nothing more. Sony's endpoints answer in JSON even to say no, so
 *   anything else under a success is somebody in front of them answering instead, and a
 *   challenge is not something this project gets around;
 * - any other failure — a timeout, the network, another status, an answer the parsers above
 *   cannot read — is counted, and the third in a row ends the asking as well. An answer that is
 *   read, whatever it says, starts the count again.
 *
 * A failed request is not repeated here, and nothing is repeated by anyone: the game it was about
 * is simply still waiting when the next run comes.
 *
 * **In fixture mode nothing is sent**, so there is nothing to pause between: a recorded answer is
 * read off disk, and a game without one is a request that failed. The cap and the three failures
 * hold as they do against the network.
 */
export function createPlaystationStore(runtime: PlaystationRuntime): PlaystationStore {
  let requests = 0
  /** When the first request of the run left: what the budget is counted from. */
  let startedAt: number | null = null
  /** When the last request ended, whatever came of it: what the pause is counted from. */
  let lastEndedAt: number | null = null
  let failuresInARow = 0
  /** Set once, by a refusal or by the third failure in a row, and never taken back. */
  let ended: PlaystationStopReport | null = null
  let line: Promise<void> = Promise.resolve()

  /** The moment the next request would leave, were it asked for now. */
  function leavesAt(now: number): number {
    return lastEndedAt === null ? now : Math.max(now, lastEndedAt + PLAYSTATION_PAUSE_MS)
  }

  function stopped(): PlaystationStopReport | null {
    if (ended) return ended
    if (requests >= PLAYSTATION_REQUESTS_PER_RUN) {
      return { reason: 'requests', detail: `the run has made its ${requests} requests` }
    }
    if (startedAt !== null && leavesAt(runtime.now()) - startedAt >= PLAYSTATION_BUDGET_MS) {
      return { reason: 'time', detail: 'the run has used its forty minutes' }
    }
    return null
  }

  function failed(error: UpstreamError | Error): never {
    failuresInARow += 1
    if (failuresInARow >= PLAYSTATION_FAILURES_IN_A_ROW) {
      ended ??= {
        reason: 'failures',
        detail: `${PLAYSTATION_FAILURES_IN_A_ROW} requests in a row failed`,
      }
    }
    throw error
  }

  function refused(detail: string, status?: number): never {
    ended ??= { reason: 'refused', detail }
    throw new UpstreamError('PLAYSTATION', status === 429 ? 'RATE_LIMITED' : 'ERROR', status)
  }

  /** One request and what it brought back, or the throw that says why it brought nothing. */
  async function send(url: string, headers: Readonly<Record<string, string>>): Promise<unknown> {
    let response: PlaystationResponse
    try {
      response = await runtime.fetch(url, headers, AbortSignal.timeout(TIMEOUT_MS))
    } catch (error) {
      lastEndedAt = runtime.now()
      return failed(new UpstreamError('PLAYSTATION', isTimeout(error) ? 'TIMEOUT' : 'ERROR'))
    }
    lastEndedAt = runtime.now()

    const { status } = response
    if (status === 403 || status === 429) return refused(`HTTP ${status}`, status)
    if (response.html) return refused('a page instead of data', status)
    if (status >= 300 && status < 400) return refused(`a redirect (HTTP ${status})`, status)
    if (status < 200 || status >= 300) {
      return failed(new UpstreamError('PLAYSTATION', 'ERROR', status))
    }
    if (response.body === undefined) return refused('an answer that is not data', status)
    return response.body
  }

  /**
   * Waits until the next request may leave, by the clock and not by the sleep: a timer may fire
   * a moment early, and a request must not. A sleep that did not move the clock at all would be
   * waited on for ever, so it is a failure like any other — nothing is sent, and the third ends
   * the run's asking.
   */
  async function pause(): Promise<void> {
    let now = runtime.now()
    const leaves = leavesAt(now)
    while (now < leaves) {
      await runtime.sleep(leaves - now)
      const after = runtime.now()
      if (after <= now) return failed(new Error('the clock stood still through a pause'))
      now = after
    }
  }

  /** A recorded answer, or the failure a game without one is. */
  async function recorded(fixture: string): Promise<unknown> {
    const body = await runtime.readFixture(fixture)
    if (body === null) return failed(new UpstreamError('PLAYSTATION', 'NOT_FOUND', 404))
    return body
  }

  async function ask<T>(
    url: string,
    headers: Readonly<Record<string, string>>,
    fixture: string,
    read: (body: unknown) => T,
  ): Promise<T> {
    // Its place in the line is taken before anything is awaited, so that two questions put in
    // the same breath still leave one after the other.
    const before = line
    let done!: () => void
    line = new Promise<void>((resolve) => {
      done = resolve
    })
    await before
    try {
      const stop = stopped()
      if (stop) throw new PlaystationStopped(stop)

      let body: unknown
      if (runtime.fixtures) {
        requests += 1
        body = await recorded(fixture)
      } else {
        await pause()
        startedAt ??= runtime.now()
        requests += 1
        body = await send(url, headers)
      }

      let answer: T
      try {
        answer = read(body)
      } catch (error) {
        return failed(error instanceof Error ? error : new Error('Sony’s answer could not be read'))
      }
      failuresInARow = 0
      return answer
    } finally {
      done()
    }
  }

  return {
    // What is asked about becomes part of an address on somebody else's server, so it is one of
    // the two things this module knows the shape of, or the question is not put at all.
    concept: async (titleId) => {
      if (!isPlaystationTitleId(titleId)) throw new Error('not a PlayStation title id')
      return ask(conceptsUrl(titleId), {}, `concepts-${titleId}`, (body) =>
        parsePlaystationConcept(body, titleId),
      )
    },
    price: async (conceptId) => {
      if (!Number.isSafeInteger(conceptId) || conceptId <= 0) {
        throw new Error('not a PlayStation concept id')
      }
      return ask(priceUrl(conceptId), PRICE_HEADERS, `price-${conceptId}`, (body) =>
        parsePlaystationPrice(body, conceptId),
      )
    },
    stopped,
    requests: () => requests,
  }
}
