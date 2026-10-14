import { oneLine, type JobDeps } from './deps'
import type { GogPrice, GogProduct } from './gog'
import {
  MICROSOFT_DETAIL_IDS_PER_REQUEST,
  MICROSOFT_IDS_PER_REQUEST,
  microsoftProductName,
  parseMicrosoftProducts,
  parseMicrosoftRelations,
  parseMicrosoftSearch,
  type MicrosoftProduct,
} from './microsoft'
import { isGogSlug, usableStoreRefs } from './storeRefs'
import { asRecord, reasonOf } from './storeUpstream'
import {
  comparableTitle,
  gameReleasedAt,
  isReleasedInTime,
  isSameTitle,
  matchComparableTitle,
  matchTitle,
  type TitleMatch,
} from './titleMatch'
import type {
  IndexedGame,
  IndexedStoreFallbacks,
  IndexedStoreRefs,
} from '../../server/index/document'
import { UpstreamError } from '../../server/upstream/errors'

/**
 * The ways to a game's product at GOG and at the Microsoft Store that are not RAWG's link, tried
 * only where the link found no price (`offers.ts`).
 *
 * RAWG's links go stale. On production on 2026-10-13 the Microsoft Store gave a price for 296 of
 * the 1 162 games RAWG links a product for, and the first of the rest that was opened by hand —
 * Resident Evil Village — is on sale in Ukraine for 1 199 ₴, under another product id than the
 * one RAWG has, which nobody can buy anywhere. So the rule "the product RAWG links, or no price"
 * is extended, not replaced: the ways are tried in a fixed order, and a game has no price at a
 * store only when none of them finds one.
 *
 * **The Microsoft Store**
 *
 * 1. RAWG's link (`offers.ts`, as before).
 * 2. **The store's own relations** (`relation`). The linked product is usually a bundle that has
 *    been replaced. The catalog still knows what it was made of (its `Parent` relations) and what
 *    else is made of the same things (their `Bundle` relations). A product among those, in the
 *    linked product's own group and under the linked product's own title, with a price anyone
 *    can pay, is the game as it is sold today.
 * 3. **The store's search for the game's name** (`name`, then `edition`). A product of the kind
 *    the store calls a game, whose title is the game's name — or, when none is, the game's name
 *    and an edition's words (`titleMatch.ts`) — released no more than a year before the game,
 *    with a price anyone can pay. A game RAWG lists on the store without a link the job can read
 *    has only this way.
 *
 * **GOG**
 *
 * 1. RAWG's slug (`offers.ts`, as before).
 * 2. **The catalog, by the game's name** (`name`, then `edition`), when RAWG's slug is not in the
 *    catalog the job has just walked, or RAWG lists the game there without a link the job can
 *    read. A game under the game's name; or, when there is none, a game or a pack under the name
 *    and an edition's words. It costs GOG nothing: the catalog is in memory.
 *
 * Wherever several products qualify, the cheapest is taken. Wherever none does, nothing is: a
 * way never settles for the nearest thing.
 *
 * **What every price found here has to be** is one a buyer in Ukraine really sees on the store's
 * page for that product. So a way reads a price by the very rule the link's price is read by, and
 * accepts a product only on what the store itself says of it. When in doubt, it finds nothing.
 *
 * **None of this asks RAWG anything.** Every request goes to the Microsoft catalog; GOG's way
 * makes none at all.
 *
 * **And none of it can cost a run.** A way may add an offer and may not take one away; a request
 * of its own that fails is a game left for a later run, and nothing here is thrown at the stage
 * (`findMicrosoftProducts` says how it ends early instead).
 */

/** The ways of a store's own: every way but RAWG's link. */
export type FallbackWay = TitleMatch | 'relation'

/** What GOG's catalog walk settled on for a game by its name. */
export type GogFound = NonNullable<IndexedStoreFallbacks['gog']>

/** What is remembered of the Microsoft Store's own ways for a game. */
export type MicrosoftFallback = NonNullable<IndexedStoreFallbacks['microsoft']>

/** The product the Microsoft Store's own ways settled on for a game. */
export type MicrosoftFound = NonNullable<MicrosoftFallback['found']>

/**
 * Games the Microsoft Store's own ways are tried for in one run: a hundred and fifty, the most
 * popular first, in a run that finds the store due — which is twice a day.
 *
 * It is the number of searches a run may send, a search being one request a game, to an endpoint
 * that is public and documented for nobody. Some 870 games were waiting on the day this was
 * written, so the first pass takes three days. That is intended: nothing here is urgent, and a
 * catalog that is asked politely goes on answering.
 */
export const MICROSOFT_SEARCHES_PER_RUN = 150

/**
 * How long a game the ways were tried for is left alone: thirty days. A product comes to a store
 * later than the game comes to RAWG, so "found nothing" is not for ever — and it is not news
 * every twelve hours either.
 */
export const MICROSOFT_SEARCH_AGAIN_MS = 30 * 86_400_000

/**
 * How far one product's relations are followed: its first eight parents, and the first forty
 * bundles those lead to. The one chain checked by hand — Resident Evil Village — has four
 * parents and sixteen bundles; a compilation can have dozens of each, and every one of them is a
 * product to ask Microsoft about. A product past the bound is not followed further, which can
 * miss a price and cannot find a wrong one.
 */
export const MICROSOFT_PARENTS_PER_PRODUCT = 8
export const MICROSOFT_BUNDLES_PER_PRODUCT = 40

/**
 * Failed requests after which the ways stop for the run: five. One search that times out is a
 * game left for the next run; five are a store that is not answering, and the hundred and
 * forty-five games behind them would each wait out a timeout to learn the same thing.
 */
export const MICROSOFT_FALLBACK_MAX_FAILURES = 5

/**
 * How long the ways may run in one run: ten minutes, on the job's clock. At a request a second a
 * full round is about three; ten is room for a slow day and no more. It is the bound the count
 * of failures cannot give — a store that answers every request, slowly, fails none of them.
 */
export const MICROSOFT_FALLBACK_BUDGET_MS = 10 * 60_000

/** Why the Microsoft Store's own ways ended before they had been tried for every game. */
export type FallbackStop =
  /** The store refused a request (HTTP 403 or 429): nothing more is asked of it in this run. */
  | 'refused'
  /** Too many requests failed: the store is not answering. */
  | 'failures'
  /** The ways' time for the run ran out: the store is answering, slowly. */
  | 'time'

/** Whether a timestamp is one: a string `Date.parse` reads. */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** What a record remembers of the stores' own ways, as the price stage may use it. */
export interface UsableFallbacks {
  gog: GogFound | null
  microsoft: {
    found: MicrosoftFound | null
    /** When the ways were last tried for the game, or `null` for never — or not readably. */
    searchedAt: string | null
  }
}

/**
 * What a record remembers of the stores' own ways (`IndexedStoreRefs.fallbacks`), and only what
 * this module would have written — as `usableStoreRefs` reads the links. The mapping outlives
 * every build that writes it, and a product read back from it is about to become part of a
 * request and of a link on a page, so nothing is taken from it on trust: a slug has to be a slug,
 * a product id a product id, a way one of the ways, a date a date.
 *
 * What does not read is worth what was never written. A found product that fails is a game with
 * none, and is looked for again; a date that fails is a game that was never searched for.
 */
export function usableFallbacks(record: IndexedStoreRefs | undefined): UsableFallbacks {
  const fallbacks = asRecord(record?.fallbacks)
  const usable: UsableFallbacks = { gog: null, microsoft: { found: null, searchedAt: null } }

  const gog = asRecord(fallbacks?.gog)
  if (
    gog &&
    isGogSlug(gog.slug) &&
    (gog.via === 'name' || gog.via === 'edition') &&
    isTimestamp(gog.foundAt)
  ) {
    usable.gog = { slug: gog.slug, via: gog.via, foundAt: gog.foundAt }
  }

  const microsoft = asRecord(fallbacks?.microsoft)
  if (isTimestamp(microsoft?.searchedAt)) usable.microsoft.searchedAt = microsoft.searchedAt
  const found = asRecord(microsoft?.found)
  // The id and the name by the rule a link's are held to, and by the same function.
  const product = usableStoreRefs({
    microsoft: found ? { id: found.id as string, name: found.name as string } : null,
  }).microsoft
  if (
    found &&
    product &&
    (found.via === 'relation' || found.via === 'name' || found.via === 'edition') &&
    isTimestamp(found.foundAt)
  ) {
    usable.microsoft.found = { ...product, via: found.via, foundAt: found.foundAt }
  }
  return usable
}

/** A record with one store's part of `fallbacks` replaced, or removed, and nothing else touched. */
function withFallback(
  record: IndexedStoreRefs,
  store: keyof IndexedStoreFallbacks,
  value: IndexedStoreFallbacks[keyof IndexedStoreFallbacks] | null,
): IndexedStoreRefs {
  const { fallbacks: _fallbacks, ...rest } = record
  const { [store]: _replaced, ...others } = asRecord(record.fallbacks) ?? {}
  const fallbacks = value === null ? others : { ...others, [store]: value }
  // What RAWG said, and whatever else a record holds, is passed on as it stands. No empty
  // `fallbacks` is written: a record says nothing where there is nothing to say.
  return Object.keys(fallbacks).length > 0 ? { ...rest, fallbacks } : rest
}

/** The record with what a walk of GOG's catalog found by name, or with nothing found there. */
export function withGogFound(record: IndexedStoreRefs, found: GogFound | null): IndexedStoreRefs {
  return withFallback(record, 'gog', found)
}

/** The record with what the Microsoft Store's own ways came to for the game. */
export function withMicrosoftFallback(
  record: IndexedStoreRefs,
  fallback: MicrosoftFallback,
): IndexedStoreRefs {
  return withFallback(record, 'microsoft', fallback)
}

/** Whether the ways are due for a game: never tried, or last tried more than thirty days ago. */
export function isMicrosoftSearchDue(searchedAt: string | null, now: number): boolean {
  const at = searchedAt === null ? Number.NaN : Date.parse(searchedAt)
  // A date ahead of the clock is no date: thirty days never run out from a moment not yet come.
  return !Number.isFinite(at) || at > now || now - at > MICROSOFT_SEARCH_AGAIN_MS
}

/**
 * The guards every product found by a title is held to, when it is found and every time it is
 * read again — so that a find made before a guard cannot outlive it:
 *
 * - the product is dated: a listing whose date the store does not give, or gives as the year
 *   9998, cannot be placed beside the game, and is not taken;
 * - its date is no more than a year before the game's and no more than twelve years after it
 *   (`isReleasedInTime`): older is another game of the name, much younger a remake that took it;
 * - no later game of the run shares the game's name (`gamesWithLaterNamesakes`): the product under
 *   that name is the later game's.
 *
 * The relation way is not held to them. It follows the catalog's own record from the very
 * product RAWG linked, and asks for that product's exact title within its own group.
 */
export function isInTimeForTitle(
  game: Pick<IndexedGame, 'id' | 'released'>,
  productReleasedAt: number | null,
  laterNamesakes: ReadonlySet<number>,
): boolean {
  return (
    !laterNamesakes.has(game.id) &&
    productReleasedAt !== null &&
    isReleasedInTime(game.released, productReleasedAt)
  )
}

/** A catalog product GOG sells, as it may become an offer: priced, linked, titled and of a kind. */
export interface GogSellable {
  product: GogProduct & { price: GogPrice; url: string; title: string }
  /** Its title as titles are compared (`comparableTitle`). */
  title: string
}

/**
 * The products of a walked catalog that could be an offer found by a title: those with a price,
 * a link of their own, a title, and a kind the job knows. Folded once a walk, so that looking a
 * game up is a pass over strings.
 */
export function gogSellables(products: Iterable<GogProduct>): GogSellable[] {
  const sellable: GogSellable[] = []
  for (const product of products) {
    if (!product.price || !product.url || product.title === null || product.type === null) continue
    sellable.push({
      product: product as GogSellable['product'],
      title: comparableTitle(product.title),
    })
  }
  return sellable
}

/** The cheapest of several, and the same one every time two cost the same. */
function cheapest<T>(
  candidates: readonly T[],
  amountOf: (candidate: T) => number,
  keyOf: (candidate: T) => string,
): T | null {
  return (
    [...candidates].sort(
      (left, right) => amountOf(left) - amountOf(right) || (keyOf(left) < keyOf(right) ? -1 : 1),
    )[0] ?? null
  )
}

/**
 * The product GOG sells a game as, looked for by the game's name in a walked catalog, and the way
 * it was found by; `null` when there is none.
 *
 * - **By the name** (`name`): a product of the kind `game` whose title is the game's name. Not a
 *   pack: a pack under the game's bare name would be the game with something else.
 * - **By an edition's name** (`edition`), only when nothing has the name itself: a `game` or a
 *   `pack` — an edition is a pack at GOG — whose title is the name and an edition's words after
 *   it ("The Witcher 3: Wild Hunt - Complete Edition", for a game whose own slug GOG retired).
 *
 * Either way the product has to be one GOG is selling (`gogSellables`) and has to pass the
 * title ways' guards (`isInTimeForTitle`): dated, no more than a year before the game and no
 * more than twelve years after it, for a game no later game of the run shares a name with.
 *
 * Of several that qualify, the cheapest: the same game at two prices is worth the lower one, and
 * the title an offer carries says which product that is.
 */
export function findGogProduct(
  catalog: readonly GogSellable[],
  game: Pick<IndexedGame, 'id' | 'name' | 'released'>,
  laterNamesakes: ReadonlySet<number> = new Set(),
): { product: GogSellable['product']; via: TitleMatch } | null {
  const name = comparableTitle(game.name)
  if (name === '' || gameReleasedAt(game.released) === null || laterNamesakes.has(game.id)) {
    return null
  }

  const matches = catalog.flatMap(({ product, title }) => {
    const via = matchComparableTitle(name, title)
    if (via === null || (via === 'name' && product.type !== 'game')) return []
    return isInTimeForTitle(game, product.releasedAt, laterNamesakes) ? [{ product, via }] : []
  })
  const named = matches.filter((match) => match.via === 'name')
  return cheapest(
    named.length > 0 ? named : matches,
    (match) => match.product.price.amount,
    (match) => match.product.slug,
  )
}

/** A game the Microsoft Store's own ways are tried for, and RAWG's product for it if it has one. */
export interface MicrosoftTarget {
  game: Pick<IndexedGame, 'id' | 'slug' | 'name' | 'released'>
  link: { id: string; name: string } | null
}

/** A product one of the ways settled on: what it is, how it was found, and what it costs now. */
export interface MicrosoftFind {
  id: string
  /** The name its page is addressed by (`microsoftProductName`). */
  name: string
  via: FallbackWay
  product: MicrosoftProduct
  /** ISO timestamp of the read that priced it. */
  readAt: string
}

export interface MicrosoftFallbackResult {
  /**
   * What the ways came to for each game they were tried for **to the end**: a product, or `null`
   * for "every way found nothing". A game that is not here was not settled — a request of its
   * own failed, or the ways stopped before its turn — and nothing may be remembered of it: it is
   * tried again by the next run that finds the store due.
   */
  settled: Map<number, MicrosoftFind | null>
  /** Requests the ways made to Microsoft. */
  requests: number
  /** Why they ended before every game had its turn, or `null` when they did not. */
  stopped: FallbackStop | null
  /** The last failure's own words, on one line; absent when no request failed. */
  error?: string
}

/** What `ask` hands back for a request that was not answered, or was never sent. */
const UNANSWERED = Symbol('unanswered')

/** Whether a failure is the store refusing: an HTTP 403 or 429. */
function isRefusal(error: unknown): boolean {
  return error instanceof UpstreamError && (error.status === 403 || error.status === 429)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Tries the Microsoft Store's own ways for the games it is given, in their order: the relations
 * of the product RAWG links, for the games that have one, and then the store's search for the
 * name of every game the relations found nothing for.
 *
 * **Requests.** A product's relations are read twenty ids a request, nothing filtered out; the
 * products they lead to, and those a search found, a hundred a request with what can be bought
 * alone in the answer — the price read's own request and its own rule for a price. A search is
 * one request a game. All of them leave through the one limiter Microsoft's transport has.
 *
 * **A way is tried to the end or not at all.** A game is settled only when every request its
 * ways needed was answered. One whose relations could not be read is not searched for instead:
 * the order of the ways is the rule, and a search that ran because a request failed would have
 * jumped it. It waits for the next run.
 *
 * **How it ends early**, each of which leaves the games not yet settled as they were:
 *
 * - the store refuses a request (HTTP 403 or 429): nothing more is asked in this run;
 * - `MICROSOFT_FALLBACK_MAX_FAILURES` requests have failed: the store is not answering;
 * - `MICROSOFT_FALLBACK_BUDGET_MS` have passed on the job's clock.
 *
 * It throws nothing. A request that fails, an answer that cannot be read, a product without a
 * price: each is a game without a find, and the stage that called goes on as if the ways had
 * never been tried for it.
 *
 * `onRequest` is called after each request, for a caller that has a lock to keep alive.
 * `laterNamesakes` are the games of the run a later game shares a name with
 * (`gamesWithLaterNamesakes`): the search is not tried for them.
 */
export async function findMicrosoftProducts(
  deps: JobDeps,
  targets: readonly MicrosoftTarget[],
  onRequest: () => Promise<void> = async () => {},
  laterNamesakes: ReadonlySet<number> = new Set(),
): Promise<MicrosoftFallbackResult> {
  const startedAt = deps.clock.now()
  const settled = new Map<number, MicrosoftFind | null>()
  /** Games a request of their own failed for: no way is tried further for them in this run. */
  const unsettled = new Set<number>()
  let requests = 0
  let failures = 0
  let stopped: FallbackStop | null = null
  let error: string | undefined

  /** One request, counted, or nothing at all once the ways have stopped. */
  async function ask<T>(what: string, run: () => Promise<T>): Promise<T | typeof UNANSWERED> {
    if (stopped) return UNANSWERED
    // Looked at before a request is started, never in the middle of one.
    if (deps.clock.now() - startedAt >= MICROSOFT_FALLBACK_BUDGET_MS) {
      stopped = 'time'
      return UNANSWERED
    }
    requests += 1
    try {
      return await run()
    } catch (cause) {
      error = reasonOf(cause)
      failures += 1
      if (isRefusal(cause)) stopped = 'refused'
      else if (failures >= MICROSOFT_FALLBACK_MAX_FAILURES) stopped = 'failures'
      deps.log(`microsoft: ${what} failed, leaving it for a later run: ${error}`)
      return UNANSWERED
    } finally {
      await onRequest()
    }
  }

  /** What Microsoft says of each id, in batches; the ids of a batch that was not answered. */
  async function askAbout<T>(
    ids: readonly string[],
    size: number,
    what: string,
    read: (batch: string[]) => Promise<Map<string, T>>,
  ): Promise<{ answers: Map<string, T>; unanswered: Set<string> }> {
    const answers = new Map<string, T>()
    const unanswered = new Set<string>()
    for (const batch of chunk([...new Set(ids)], size)) {
      const answer = await ask(`a request for ${what} of ${batch.length} products`, () =>
        read(batch),
      )
      if (answer === UNANSWERED) for (const id of batch) unanswered.add(id)
      else for (const [id, value] of answer) answers.set(id, value)
    }
    return { answers, unanswered }
  }

  const relationsOf = (ids: readonly string[]) =>
    askAbout(ids, MICROSOFT_DETAIL_IDS_PER_REQUEST, 'the relations', async (batch) =>
      parseMicrosoftRelations(await deps.microsoftCatalog.details(batch), batch),
    )

  /** The products among `ids` that anyone can buy, each with the moment it was read. */
  const soldAmong = (ids: readonly string[]) =>
    askAbout(ids, MICROSOFT_IDS_PER_REQUEST, 'the prices', async (batch) => {
      const sold = parseMicrosoftProducts(await deps.microsoft(batch), batch, deps.clock.now())
      const readAt = new Date(deps.clock.now()).toISOString()
      return new Map(
        [...sold].flatMap(([id, product]) => (product ? [[id, { product, readAt }] as const] : [])),
      )
    })

  type Sold = Awaited<ReturnType<typeof soldAmong>>['answers']
  type Candidate = { id: string; product: MicrosoftProduct; readAt: string }

  const findOf = (candidate: Candidate | null, via: FallbackWay): MicrosoftFind | null =>
    candidate && {
      id: candidate.id,
      name: microsoftProductName(candidate.product.title),
      via,
      product: candidate.product,
      readAt: candidate.readAt,
    }

  const pick = (candidates: readonly Candidate[]) =>
    cheapest(
      candidates,
      (candidate) => candidate.product.price.amount,
      (candidate) => candidate.id,
    )

  // --- The store's own relations, for the games RAWG links a product for.
  const linked = targets.flatMap((target) =>
    target.link ? [{ ...target, link: target.link }] : [],
  )
  const links = await relationsOf(linked.map((target) => target.link.id))

  /** What a linked product leads to: its own title and group, and the products to follow. */
  const leads = new Map<
    number,
    { title: string; group: string; parents: string[]; bundles: string[] }
  >()
  for (const { game, link } of linked) {
    if (links.unanswered.has(link.id)) {
      unsettled.add(game.id)
      continue
    }
    const product = links.answers.get(link.id)
    // Without a title there is nothing to know the game's other product by, and without a group
    // nothing to say that it is the same game's.
    if (!product || product.title === null || product.group === null) continue
    if (product.parents.length === 0) continue
    leads.set(game.id, {
      title: product.title,
      group: product.group,
      parents: product.parents.slice(0, MICROSOFT_PARENTS_PER_PRODUCT),
      bundles: [],
    })
  }

  const parents = await relationsOf([...leads.values()].flatMap((lead) => lead.parents))
  for (const { game, link } of linked) {
    const lead = leads.get(game.id)
    if (!lead) continue
    if (lead.parents.some((id) => parents.unanswered.has(id))) {
      unsettled.add(game.id)
      leads.delete(game.id)
      continue
    }
    // Only what the linked product has in common with its own group: a bundle also holds what
    // came with the game — another game, in another group — and that one's bundles are not this
    // game's editions.
    const bundles = lead.parents.flatMap((id) => {
      const parent = parents.answers.get(id)
      return parent && parent.group === lead.group ? parent.bundles : []
    })
    lead.bundles = [...new Set(bundles)]
      .filter((id) => id !== link.id)
      .slice(0, MICROSOFT_BUNDLES_PER_PRODUCT)
  }

  const related = await soldAmong([...leads.values()].flatMap((lead) => lead.bundles))
  for (const [gameId, lead] of leads) {
    if (lead.bundles.some((id) => related.unanswered.has(id))) {
      unsettled.add(gameId)
      continue
    }
    const candidates = lead.bundles.flatMap((id): Candidate[] => {
      const sold = related.answers.get(id)
      // In the linked product's group, and under its very title: the game, and not an edition
      // of it the visitor did not ask about.
      // And a game: an add-on in the game's group is no price for the game, whatever it is called.
      return sold &&
        sold.product.kind === 'Game' &&
        sold.product.group === lead.group &&
        isSameTitle(sold.product.title, lead.title)
        ? [{ id, ...sold }]
        : []
    })
    const find = findOf(pick(candidates), 'relation')
    if (find) settled.set(gameId, find)
  }

  // --- The store's search, for every game the relations found nothing for.
  /** Games whose search found something worth reading, until their products have been read. */
  let found: { target: MicrosoftTarget; ids: string[] }[] = []

  /** Reads what the searches so far found, and settles the games they were for. */
  async function settleFound(): Promise<void> {
    const waiting = found
    found = []
    if (waiting.length === 0) return
    const sold = await soldAmong(waiting.flatMap((entry) => entry.ids))
    for (const { target, ids } of waiting) {
      if (ids.some((id) => sold.unanswered.has(id))) continue
      settled.set(target.game.id, bySearch(target.game, ids, sold.answers))
    }
  }

  /**
   * The product a search settled on. The title is judged again, on the catalog's own answer: it
   * is the one the offer will carry, and the one the price beside it belongs to.
   */
  function bySearch(game: MicrosoftTarget['game'], ids: readonly string[], sold: Sold) {
    const matches = ids.flatMap((id) => {
      const answer = sold.get(id)
      const via = answer ? matchTitle(game.name, answer.product.title) : null
      if (!answer || via === null) return []
      if (!isInTimeForTitle(game, answer.product.releasedAt, laterNamesakes)) return []
      return [{ candidate: { id, ...answer }, via }]
    })
    const named = matches.filter((match) => match.via === 'name')
    const pool = named.length > 0 ? named : matches
    const chosen = pick(pool.map((match) => match.candidate))
    return findOf(chosen, pool.find((match) => match.candidate === chosen)?.via ?? 'name')
  }

  for (const target of targets) {
    const { game } = target
    if (stopped) break
    if (settled.has(game.id) || unsettled.has(game.id)) continue
    // A game with no release date, or with a later namesake in the run, is found under no title,
    // and one with no name has none to search for: each is settled without a request.
    if (
      comparableTitle(game.name) === '' ||
      gameReleasedAt(game.released) === null ||
      laterNamesakes.has(game.id)
    ) {
      settled.set(game.id, null)
      continue
    }
    const results = await ask(`the search for ${oneLine(game.slug)}`, async () =>
      parseMicrosoftSearch(await deps.microsoftCatalog.search(game.name)),
    )
    if (results === UNANSWERED) continue
    // Only what its title could be the game by is worth a read of its price.
    const ids = results
      .filter((result) => matchTitle(game.name, result.title) !== null)
      .map((result) => result.id)
    if (ids.length === 0) {
      settled.set(game.id, null)
      continue
    }
    found.push({ target, ids })
    if (new Set(found.flatMap((entry) => entry.ids)).size >= MICROSOFT_IDS_PER_REQUEST) {
      await settleFound()
    }
  }
  await settleFound()

  return { settled, requests, stopped, ...(error === undefined ? {} : { error }) }
}
