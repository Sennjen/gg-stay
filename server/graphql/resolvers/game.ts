import { isMadeInUkraine } from '../../../shared/ukrainianStudios'
import { isIndexableSlug, type IndexedGame } from '../../index/document'
import { steamStorePageOf, toGame, toLocalisationInfo, toSteamOffer } from '../../index/toGraphql'
import { mapGame } from '../../rawg/mappers'
import type { RawgGameDetail, RawgList, RawgScreenshot, RawgStoreLink } from '../../rawg/types'
import type { SteamPrice } from '../../steam/price'
import { steamAppIdFromUrl, steamStoreUrl } from '../../steam/steam'
import { UpstreamError } from '../../upstream/errors'
import { trackPending, valueOf, type Observed, type Pending } from '../budget'
import type { GraphQLContext } from '../context'
import { withUpstreamErrors } from '../errors'
import { indexEntry, indexEntryBySlug, indexState } from '../indexPath'
import type { Game, QueryResolvers, StoreOffer } from '../__generated__/resolvers-types'

/**
 * The game page, answered inside a time budget.
 *
 * The page asks RAWG three things — the game's detail, its store links and its screenshots — and
 * the index one: the document it holds under this address. All of it is sent before anything is
 * awaited, the detail first, and the index beside the RAWG requests rather than in front of them.
 * What the page then waits for depends on what it can do without:
 *
 * - **The detail** is the page. RAWG's answer inside `GAME_DETAIL_HEDGE_MS` is used exactly as it
 *   always was. Past that, a game the index holds is answered from its index document (`toGame`)
 *   and marked `partial`; so is one whose detail request failed, without waiting for the budget.
 *   A game the index does not hold waits for RAWG as long as RAWG takes and fails as RAWG fails,
 *   as before — which is every game while the index is unavailable, once it has failed in this
 *   request, and for as long as the published version has no slugs to find a game by. "No such
 *   game" is RAWG's answer rather than a failure of it, and is passed on whatever the index holds:
 *   the index was built from RAWG's list some time ago, and RAWG is the one that knows whether
 *   the game still exists.
 * - **The store links and the screenshots** are enhancements. They are waited for until
 *   `GAME_EXTRAS_BUDGET_MS` after the request began, and the page is then assembled from whichever
 *   have arrived — `partial` if one had not. One that failed inside the budget is not missing in
 *   that sense: the page renders without it and is complete, exactly as it was.
 * - **The live Steam price** (below) is waited for `LIVE_PRICE_BUDGET_MS` from the moment it was
 *   asked for. Past that the index price stands, under its own true timestamp. That is not a
 *   reason for `partial`: the page has a price, and says how old it is. A Steam game the index
 *   does not hold has no such price to fall back on — the page goes out with the Steam link and
 *   nothing on it — so there a price that is still on its way does make the page `partial`: the
 *   read is left running, and the page's own second request finds its answer in the cache.
 *
 * Nothing the page stops waiting for is cancelled. Every request keeps running so that its answer
 * reaches the cache it was headed for, and `Pending.release` hands whatever is still running to
 * `context.waitUntil` at every exit — the page the same visitor's browser asks for again a few
 * seconds later then collects those answers instead of starting over, because the transport
 * shares a request that is still in flight (`createUpstreamFetch`).
 *
 * The page also reads its own index entry: the Steam offer carries the price, and the page gets
 * the language list and the made-in-Ukraine flag. On a page RAWG answered the entry is read by the
 * id RAWG gave, as it always was — in the usual case that is the very read the lookup by slug has
 * already made, and `Game.similar` shares it, so one request reads the game's document once. The
 * lookup by slug is a head start, not a second source: RAWG says which game the page is about.
 *
 * The flag has a second source that needs no index at all: the game's own RAWG developers, checked
 * against the studio list (`shared/ukrainianStudios.ts`). That keeps it right for a game outside
 * the index and while the index is down; the index flag, set by the refresh job from the same
 * list, still counts when RAWG credits a studio under a slug the list does not carry.
 *
 * Prices are refreshed every six hours by the nightly job, so an entry that old — and a game with
 * a Steam store page that the index has never seen at all — is refreshed live from Steam for this
 * one app, and the answer is kept in Nitro storage for the same six hours so the next reader pays
 * nothing. "Steam has no price for this app" is an answer too, and is kept as well: a delisted or
 * regionless game would otherwise cost every reader of its page a Steam request that can only say
 * the same thing again. It is kept for one hour, not six (`NO_LIVE_PRICE_TTL_SECONDS` says why).
 * Only Steam saying so counts: an answer that could not be read — an empty body under a 200, a
 * body with nothing in it about this app — is a failed read like any other, and nothing is kept
 * of a failed read, so the next reader asks again. The live read is about the price only: the
 * design refreshes languages weekly, so the language list always comes from the index. Anything
 * that goes wrong keeps the index copy and logs a warning, because this page has to render either
 * way, and the site never writes to Redis.
 *
 * Which app to ask about comes from the index document when the refresh job has published the
 * game's Steam app id there, and from RAWG's own store links otherwise, as before. When the
 * document also lists the game on Steam the read starts the moment the document is found, beside
 * the RAWG requests instead of behind them; a document that names an app without listing Steam
 * is not asked about ahead of RAWG, whose links are then what says whether the price has a place.
 *
 * The read goes through `fetchPrice(appId)`, on the only Steam transport in this project that
 * never caches (`steamPriceFetch.ts`'s `NO_CACHE`) — and the read that tells Steam having no
 * price from an answer that is not one. The per-app transport beside it keeps its answers for
 * twenty-four hours, so a "refresh" through it would very often hand back a day-old body — and
 * the whole point of this call is that the timestamp on the price is true. What is
 * cached is this resolver's own six-hour entry, and it carries the clock of the request that made
 * the read (`context.now`), which is what `updatedAt` is stamped with.
 */

/**
 * How long the page waits for RAWG's detail before a game the index holds is answered from the
 * index instead.
 *
 * The same two and a half seconds the catalog gives RAWG (`RAWG_HEDGE_MS` in `games.ts`), for the
 * same reason: long enough that a page RAWG answers at its usual pace is never second-guessed,
 * short enough that a visitor is not left looking at a skeleton for the whole of RAWG's slow
 * path — which reached 8.6 s for a first open of a game page when it was measured on production
 * (`docs/specs/2026-10-06-game-page-budget-design.md`).
 */
export const GAME_DETAIL_HEDGE_MS = 2_500

/**
 * How long after the request began the page still waits for the store links and the screenshots.
 * Shorter than the detail's budget on purpose: the page can be read without either, and the one
 * that is missing arrives with the page's own second request.
 */
export const GAME_EXTRAS_BUDGET_MS = 1_500

/** How long the page waits for a live Steam price, counted from the moment it was asked for. */
export const LIVE_PRICE_BUDGET_MS = 1_000

/** How old an index price may be before the page refreshes that one game from Steam. */
export const PRICE_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000
/** How long a price Steam gave is kept: until the index would have refreshed it anyway. */
const LIVE_PRICE_TTL_SECONDS = 6 * 60 * 60
/**
 * How long "Steam has no price for this app" is kept: one hour, where a price is kept six.
 *
 * A price is a fact about the app. "None" is weaker evidence, because Steam does not only say it
 * of an app it does not sell here: under load it answers a 200 with the same
 * `{"<appid>":{"success":false}}` for an app that does have a price (`scripts/index/prices.ts`
 * has the note), and nothing on the wire tells the two apart. So a "none" may be wrong, and a
 * wrong one must not keep a page from its price for long. An hour still does what remembering it
 * is for — a delisted or regionless game stops costing every reader of its page a Steam request —
 * and is the longest a soft failure can pass for an answer.
 */
const NO_LIVE_PRICE_TTL_SECONDS = 60 * 60
const LIVE_PRICE_PREFIX = 'steam-price'

interface LivePrice {
  price: SteamPrice
  /**
   * When this price was read from Steam: the clock of the request that read it (`context.now`,
   * taken once as that request began), kept in the cache entry beside the price, so a reader
   * served from the cache hours later still stamps `updatedAt` with the read rather than with its
   * own request time.
   *
   * It is the moment the read was asked for, not the moment Steam answered. The two are apart by
   * however long Steam took — and a read the page stopped waiting for can take several seconds
   * more (two five-second attempts at most, behind the limiter's queue). The difference only ever
   * errs one way: a price is dated a little older than it is, never newer.
   */
  fetchedAt: string
}

/**
 * What one live read left in the cache: the price, kept for six hours, or `null` for "Steam
 * answered, and has no price for this app", kept for one. Only an answer is ever written — a read
 * that failed leaves nothing, so the next reader asks Steam again, and an answer that could not
 * be read is a read that failed.
 */
interface RememberedPrice {
  price: SteamPrice | null
  fetchedAt: string
}

/** The remembered answer as a price to serve, or `null` when what is remembered is that none exists. */
function pricedOrNull(remembered: RememberedPrice): LivePrice | null {
  return remembered.price ? { price: remembered.price, fetchedAt: remembered.fetchedAt } : null
}

/** What the index holds for the address the page was asked for, when it can stand in for RAWG. */
interface Indexed {
  document: IndexedGame
  /** The index's prices are too old to be shown (`indexState`). */
  stale: boolean
}

/** RAWG's two enhancements to the page, and the budget they share. */
interface Extras {
  storeLinks: Observed<RawgList<RawgStoreLink>>
  screenshots: Observed<RawgList<RawgScreenshot>>
  /** Resolves `GAME_EXTRAS_BUDGET_MS` after the request began. */
  budget: Promise<void>
}

type LivePrices = ReturnType<typeof livePrices>

export const game: QueryResolvers['game'] = (_parent, { slug }, context) =>
  withUpstreamErrors(async () => {
    // The slug is a visitor's, in a request variable nothing else bounds, and it is about to be
    // sent to RAWG three times over. One that cannot be a game's — empty, longer than any slug
    // the index would file, or not well-formed text, which cannot even be put in an address — is
    // answered here as RAWG would answer it, and costs no upstream a request. The same rule the
    // index draws its own line by (`isIndexableSlug`), so the two can never disagree about it.
    if (!isIndexableSlug(slug)) throw new UpstreamError('RAWG', 'NOT_FOUND', 404)

    const pending = trackPending(context)
    try {
      return await gamePage(context, slug, pending)
    } finally {
      // However the answer came out — a page, a partial page or an error — no timer outlives it,
      // and nothing it started and did not wait for is dropped.
      pending.release()
    }
  })

async function gamePage(context: GraphQLContext, slug: string, pending: Pending): Promise<Game> {
  const path = `games/${encodeURIComponent(slug)}`

  // Sent before anything is awaited, the detail first: the transport spaces its requests, and the
  // detail is the one the page cannot be built without.
  const detail = pending.observe(context.rawg(path).then(detailOrThrow))
  const extras: Extras = {
    // Store links are an enhancement: the page still renders without them.
    storeLinks: pending.observe(context.rawg(`${path}/stores`) as Promise<RawgList<RawgStoreLink>>),
    // Same pattern: screenshots are an enhancement, not required to render the page.
    screenshots: pending.observe(
      context.rawg(`${path}/screenshots`) as Promise<RawgList<RawgScreenshot>>,
    ),
    budget: pending.budget(GAME_EXTRAS_BUDGET_MS),
  }
  const hedge = pending.budget(GAME_DETAIL_HEDGE_MS)

  // The index, beside the RAWG requests and never in front of them. With the document comes the
  // game's Steam app id, so a price that is due a refresh is asked for right there, while RAWG is
  // still out.
  const price = livePrices(context, pending)
  const indexed = pending.observe(
    indexedGame(context, slug).then((found) => {
      if (found) price.startEarly(found.document)
      return found
    }),
  )

  await Promise.race([detail.settled, hedge])
  if (!hasAnswered(detail)) {
    // RAWG is late, or has failed. The index answers if it holds the game — unless RAWG's own
    // answer gets in first, which is the better page and costs nothing more to take.
    const found = await Promise.race([
      indexed.settled.then(() => valueOf(indexed) ?? null),
      answerOf(detail),
    ])
    if (found) return indexPage(found, detail, price)
    // RAWG got in first, or the index does not hold the game: RAWG's answer, or RAWG's error,
    // exactly as before.
  }

  const answer = await detail.settled
  if (answer.status === 'rejected') throw answer.reason
  return rawgPage(context, answer.value, extras, price)
}

/**
 * RAWG's detail, or the upstream error a body that is not a game stands for. RAWG has been seen
 * answering with an empty body under a 200, which the transport hands back once without caching
 * it (see `rawgListOrThrow` for the same rule on lists). Named here, at the source, it is a failed
 * detail like any other: a game the index holds is answered from the index, and any other game
 * fails through the resolvers' error mapping rather than on a property read.
 */
function detailOrThrow(body: unknown): RawgGameDetail {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UpstreamError('RAWG', 'ERROR')
  }
  return body as RawgGameDetail
}

function isNotFound(reason: unknown): boolean {
  return reason instanceof UpstreamError && reason.kind === 'NOT_FOUND'
}

/**
 * Whether RAWG has said what the page needs to know: which game this is — or that there is no such
 * game, which is as much an answer and is never second-guessed from the index.
 */
function hasAnswered(detail: Observed<RawgGameDetail>): boolean {
  const outcome = detail.outcome()
  return (
    outcome.status === 'fulfilled' || (outcome.status === 'rejected' && isNotFound(outcome.reason))
  )
}

/**
 * Resolves — with `null`, "nothing from the index" — when RAWG has answered (`hasAnswered`), and
 * never settles when it has failed instead: a RAWG failure does not win a race against the index,
 * it leaves the index to answer.
 */
function answerOf(detail: Observed<RawgGameDetail>): Promise<null> {
  return detail.settled.then(() => (hasAnswered(detail) ? null : new Promise<never>(() => {})))
}

/**
 * The document the index holds for this address, with what the index says about its own prices;
 * `null` whenever the page should carry on as for a game the index does not hold.
 *
 * That is when there is no index to ask — nothing published, nothing configured, or a metadata
 * read that failed — when the index has already let this request down, in which case the lookup
 * is not even made (`indexEntryBySlug`), and when it does not know the slug, which is also all a
 * version published before the refresh job wrote slugs can say. Never rejects: a read that fails
 * is warned about once, like every index read, and declines.
 *
 * The metadata is read first. It is the one read that says whether there is anything to ask, so
 * an index that is down costs this page one failed call rather than two, and `Game.similar` needs
 * it anyway — within a request it is read once.
 */
async function indexedGame(context: GraphQLContext, slug: string): Promise<Indexed | null> {
  const state = await indexState(context)
  if (state.meta === null) return null
  const document = await indexEntryBySlug(context, slug)
  return document ? { document, stale: state.stale } : null
}

/**
 * The page built from the index document, when RAWG's detail is late or has failed: `toGame` says
 * what such a page holds, and that it is `partial`.
 *
 * Its Steam offer carries the freshest price there is — the live one when it was due and Steam
 * answered within its budget, the index copy otherwise. A stale index is not trusted with a price
 * here either, as on every page the index serves on its own: its copy is withheld, and only a
 * price Steam has just given is shown.
 *
 * One `console.info` line per page answered this way: the runtime logs are how it is seen in
 * production.
 */
async function indexPage(
  { document, stale }: Indexed,
  detail: Observed<RawgGameDetail>,
  price: LivePrices,
): Promise<Game> {
  const rawg = detail.outcome()
  console.info(
    rawg.status === 'rejected'
      ? `[game] RAWG failed (${kindOf(rawg.reason)}), answered from the index`
      : `[game] RAWG slower than ${GAME_DETAIL_HEDGE_MS} ms, answered from the index`,
  )

  // Without a Steam offer on the page there is nothing for a price to sit on, and so nothing to
  // wait for (`offeredSteamAppOf`).
  const appId = offeredSteamAppOf(document)
  const live = appId ? await price.read(appId, document) : null
  if (live) return toGame(withLivePrice(document, live))
  return toGame(stale ? withoutPrice(document) : document)
}

function kindOf(reason: unknown): string {
  return reason instanceof UpstreamError ? reason.kind : 'ERROR'
}

/**
 * The page built from RAWG's detail, as it always was, with whatever else has arrived.
 *
 * The store links and the screenshots are waited for until their budget is spent — which, for a
 * detail that itself arrived after it, is no time at all — and the page says `partial` when one
 * of them had still not settled. The index entry is read by the id RAWG gave.
 *
 * The live price is the other thing such a page can go out without, for a game the index does
 * not hold (the header says why that one case counts and no other).
 *
 * One `console.info` line per page that goes out partial this way, naming what it went out
 * without, as the page answered from the index writes one (`indexPage`): together the two lines
 * are how the share of partial pages is read from the runtime logs.
 */
async function rawgPage(
  context: GraphQLContext,
  detail: RawgGameDetail,
  extras: Extras,
  price: LivePrices,
): Promise<Game> {
  await Promise.race([
    Promise.all([extras.storeLinks.settled, extras.screenshots.settled]),
    extras.budget,
  ])
  const links = valueOf(extras.storeLinks)?.results ?? []
  const mapped = mapGame(detail, links, valueOf(extras.screenshots)?.results ?? [])
  const late = lateExtras(extras)

  const id = Number(mapped.id)
  const entry = Number.isFinite(id) ? await indexEntry(context, id) : null

  // Whether there is a Steam price to show is RAWG's store link's to say, as it always was: the
  // price sits on that link. Which app the link stands for is the document's to say when it
  // knows, because that is the app whose price is already being read.
  const listed = links.map((link) => steamAppIdFromUrl(link.url)).find((found) => found !== null)
  const appId = listed ? (steamAppIdOf(entry) ?? listed) : null
  const live = appId ? await price.read(appId, entry) : null
  // Without a live price the index's own stands, under the timestamp the index gave it — however
  // old that is, and even when the index as a whole is too stale to put a price on a card. That
  // is this page's rule, and it is deliberate: the page shows a price's age beside the price
  // (`GameScoreboard`), so an old price is an honest one here, where a card has no room to say
  // how old its price is. A page the index answers on its own withholds a stale one (`indexPage`).
  const priced = appId && live ? withLivePrice(entry ?? emptyEntryFor(appId), live) : entry
  // With no index entry there is no price to stand in for one that is still on its way: the
  // Steam link goes out bare, which is something left out for the page to ask for again. An
  // answer inside the budget — a price, Steam's "none", a failure — leaves nothing to collect.
  const priceLate = appId !== null && entry === null && price.isOut(appId)

  const partial = late.length > 0 || priceLate
  if (partial) console.info(partialLine(late, priceLate))
  return {
    ...mapped,
    stores: withSteamPrice(mapped.stores, priced),
    localisation: entry ? toLocalisationInfo(entry) : null,
    madeInUkraine:
      isMadeInUkraine(mapped.developers.map((developer) => developer.slug)) ||
      (entry?.madeInUkraine ?? false),
    partial,
  }
}

/** Which of RAWG's two enhancements had not answered when the page was put together, by name. */
function lateExtras(extras: Extras): string[] {
  return [
    ...(isPending(extras.storeLinks) ? ['store links'] : []),
    ...(isPending(extras.screenshots) ? ['screenshots'] : []),
  ]
}

/**
 * The line about a page RAWG answered that went out partial: what it went out without, each with
 * the budget it missed. In the shape of the line about a page answered from the index.
 */
function partialLine(late: readonly string[], priceLate: boolean): string {
  const missed = [
    ...(late.length > 0
      ? [`RAWG ${late.join(' and ')} slower than ${GAME_EXTRAS_BUDGET_MS} ms`]
      : []),
    ...(priceLate ? [`Steam price slower than ${LIVE_PRICE_BUDGET_MS} ms`] : []),
  ]
  return `[game] ${missed.join(' and ')}, answered without ${late.length > 0 ? 'them' : 'it'}`
}

function isPending(request: Observed<unknown>): boolean {
  return request.outcome().status === 'pending'
}

/**
 * The Steam app the index document names, when it names one. Anything that is not an app id is no
 * app id: the value goes into a store address and a cache key (`steamStoreUrl`).
 */
function steamAppIdOf(entry: IndexedGame | null): string | null {
  const appId = entry?.steamAppId
  return appId && steamStoreUrl(appId) ? appId : null
}

/**
 * The Steam app whose price a page built from this document alone would show: the one the
 * document names, when it also lists Steam among the game's stores (`steamStorePageOf`). That is
 * the page's whole Steam offer, so it is also all that is worth asking Steam about on the
 * document's word alone — a document that names an app without listing Steam is of a game RAWG
 * has stopped listing there, or has not listed yet, and a price read for it would be shown
 * nowhere unless RAWG's own store links say otherwise.
 */
function offeredSteamAppOf(document: IndexedGame): string | null {
  return steamStorePageOf(document) ? steamAppIdOf(document) : null
}

/**
 * The live Steam price for the one app this page is about: asked for at most once per app, and
 * waited for `LIVE_PRICE_BUDGET_MS` from the moment it was asked — not from the moment the page
 * came to need it, so a read that started beside the RAWG requests has usually used its budget up
 * before the page is assembled, and costs the page nothing then.
 *
 * A read the page does not wait out is left running, like every request here (`Pending`): it ends
 * in the cache entry the next reader is served from.
 */
function livePrices(context: GraphQLContext, pending: Pending) {
  let asked: { appId: string; price: Observed<LivePrice | null>; budget: Promise<void> } | null =
    null

  function ask(appId: string) {
    if (asked?.appId !== appId) {
      asked = {
        appId,
        price: pending.observe(livePrice(context, appId)),
        budget: pending.budget(LIVE_PRICE_BUDGET_MS),
      }
    }
    return asked
  }

  return {
    /**
     * Asks Steam as soon as the index document says which app to ask about, when its price is due
     * a refresh — and when the document itself offers the game on Steam (`offeredSteamAppOf`):
     * a head start is only worth a request for a price the page is known to have a place for.
     * Any other game's price waits for RAWG's store links to say whether there is a Steam link to
     * put it on. Does nothing once the answer has been given: a head start is all this is.
     */
    startEarly(document: IndexedGame): void {
      if (pending.released) return
      const appId = offeredSteamAppOf(document)
      if (appId && needsRefresh(context, document)) ask(appId)
    },

    /**
     * The live price for `appId`, or `null` when none is needed — the entry's own is fresh
     * enough — when Steam has none, when the read failed, and when it did not arrive in time. In
     * every one of those the caller keeps what the index holds.
     */
    async read(appId: string, entry: IndexedGame | null): Promise<LivePrice | null> {
      if (entry && !needsRefresh(context, entry)) return null
      const { price, budget } = ask(appId)
      await Promise.race([price.settled, budget])
      return valueOf(price) ?? null
    },

    /**
     * Whether the read for `appId` is still out: asked for, and neither answered nor failed. What
     * a caller that got `null` from `read` asks to tell "not in yet" from every other `null`.
     */
    isOut(appId: string): boolean {
      return asked?.appId === appId && isPending(asked.price)
    },
  }
}

function needsRefresh(context: GraphQLContext, entry: IndexedGame): boolean {
  if (entry.priceUpdatedAt === null) return true
  const age = Date.parse(context.now) - Date.parse(entry.priceUpdatedAt)
  return !Number.isFinite(age) || age > PRICE_REFRESH_AFTER_MS
}

/** Never rejects: whatever goes wrong is warned about, and the caller keeps the index copy. */
async function livePrice(context: GraphQLContext, appId: string): Promise<LivePrice | null> {
  const key = `${LIVE_PRICE_PREFIX}:${appId}`
  try {
    // The cache read is inside the guard on purpose: a storage driver that throws must cost this
    // page a Steam request, never a 500.
    const cached = await context.cache.get<RememberedPrice>(key)
    if (cached) return pricedOrNull(cached)

    // `null` here is Steam's own word that it has no price for this app — a regionless or
    // delisted one, a free one. It is not a fresher price, so the index copy stays; it is an
    // answer all the same, and is remembered as one — for an hour — so the next reader of this
    // page does not wait for Steam to give it again. An answer that could not be read never gets
    // this far: `fetchPrice` raises it as the failed read it is, and the `catch` keeps nothing.
    const price = await context.steamPrices.fetchPrice(appId)
    // A price without an amount is no price to serve, and it is not Steam saying it has none.
    if (price && !Number.isFinite(price.priceUah)) throw new UpstreamError('STEAM', 'ERROR')
    const remembered: RememberedPrice = { price, fetchedAt: context.now }
    const keptFor = price ? LIVE_PRICE_TTL_SECONDS : NO_LIVE_PRICE_TTL_SECONDS
    await context.cache.set(key, remembered, keptFor)
    return pricedOrNull(remembered)
  } catch (error) {
    warnOfLivePriceOnce(context, error)
    return null
  }
}

/** The requests that have already said a live price could not be read. */
const warnedOfLivePrice = new WeakSet<GraphQLContext>()

/**
 * One line per request, at warn level, for a live price that could not be read — naming what
 * failed and nothing else, never an address.
 *
 * It is Steam that failed here, or the price cache, and the line says so under the page's own
 * name. It is deliberately not the index's warning (`warnIndexOnce`): that one also marks the
 * request's index as failed, after which nothing in the request asks the index again — and a
 * Steam answer that could not be read would take the similar games off the very page it failed
 * to price, with the index in perfect health.
 */
function warnOfLivePriceOnce(context: GraphQLContext, error: unknown): void {
  if (warnedOfLivePrice.has(context)) return
  warnedOfLivePrice.add(context)
  const reason = error instanceof Error ? error.message : 'unknown error'
  console.warn(`[game] the live Steam price could not be read: ${reason}`)
}

/** The entry with the price Steam has just given on it, dated by the read. */
function withLivePrice(entry: IndexedGame, live: LivePrice): IndexedGame {
  return {
    ...entry,
    priceUah: live.price.priceUah,
    regularPriceUah: live.price.regularPriceUah,
    discountPercent: live.price.discountPercent,
    free: live.price.isFree,
    priceUpdatedAt: live.fetchedAt,
  }
}

/** The document with its price withheld, for a page a stale index serves on its own. */
function withoutPrice(document: IndexedGame): IndexedGame {
  return {
    ...document,
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    priceUpdatedAt: null,
  }
}

/**
 * A price for a game the index has never held needs somewhere to sit. Everything else on this
 * shape stays empty: it is the price that was fetched, not a card.
 */
function emptyEntryFor(appId: string): IndexedGame {
  return {
    id: 0,
    slug: appId,
    name: '',
    cover: null,
    preview: null,
    released: null,
    popularity: 0,
    platforms: [],
    genres: [],
    stores: ['steam'],
    gameModes: [],
    ageRating: null,
    rating: null,
    ratingsCount: 0,
    metacritic: null,
    playtime: null,
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: null,
  }
}

/** The Steam link keeps its URL and gains the price; every other store stays a plain link. */
function withSteamPrice(offers: StoreOffer[], entry: IndexedGame | null): StoreOffer[] {
  if (!entry) return offers
  return offers.map((offer) => (offer.store === 'steam' ? toSteamOffer(entry, offer.url) : offer))
}
