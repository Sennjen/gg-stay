import { MAX_ITEM_FAILURE_RATIO, type JobDeps } from './deps'
import {
  OFFER_STORES,
  type IndexedGame,
  type IndexedStoreRefs,
  type OfferStore,
} from '../../server/index/document'
import type { RawgStoreLink } from '../../server/rawg/types'

/**
 * Which product a game is on GOG and on the Microsoft Store — the two stores, other than Steam,
 * whose prices the job reads (`offers.ts`) — and the sweep that finds it for the games the index
 * already held when those prices were added.
 *
 * The source is the one the Steam app id has: RAWG's `games/{slug}/stores`, which carries every
 * store's own link to the game. A link is read by its shape and by nothing else. One that does not
 * have the shape is no reference, and nothing is ever guessed from a title: a wrong product would
 * be a wrong price under the game's name, which is the one thing this whole feature must not
 * show.
 *
 * The answer is kept where the app ids are, outside the version prefix and for the life of the
 * index (`storeref:{rawgId}`), and for the same reason: it costs a RAWG request a game, and RAWG's
 * monthly quota is what the nightly run lives on.
 *
 * **Only a game RAWG lists on one of the two stores is asked about**, and which those are is in
 * the documents already: `IndexedGame.stores` is RAWG's own list of the stores a game is on, read
 * from the page of the list the game came from (`toIndexedGame`), under the slugs the site uses
 * (`gog`, `xbox-store`). It is the list the app-id stage has always trusted for Steam, and it and
 * the links are one table at RAWG — a game's store rows there carry the ids its link rows have,
 * and the two agreed in every case checked, both ways round — so a game listed on neither store
 * has no link to find and costs no request. "Asked" is remembered store by store
 * (`IndexedStoreRefs`): a store the game is listed on with no link the job can read is recorded
 * as such and not asked about again, and a game that gains a store later is asked then.
 *
 * A game new to the index gets its references with its app id, from the very same response
 * (`resolveAppIds`), at no request of its own. Everything else — the games resolved before this
 * existed, and the games RAWG does not list on Steam, which `resolveAppIds` never asks about — is
 * swept here: at most `STORE_REF_SWEEP_PER_RUN` lookups in a full run, until every game listed on
 * GOG or on the Xbox store has been asked about.
 */

/** RAWG lookups one full run may spend on games waiting to be asked about. */
export const STORE_REF_SWEEP_PER_RUN = 1200

/** How many records to accumulate before one `setStoreRefs` round trip, as the app ids do. */
export const STORE_REF_BATCH_SIZE = 100

/** The cursor the sweep keeps: the RAWG id of the last game it asked about. */
export const STORE_REF_CURSOR = 'storerefs'

/**
 * How long the sweep may run in one night: twenty minutes, on the job's clock.
 *
 * The failure budget below ends a sweep RAWG is refusing. It does nothing about a RAWG that
 * answers every lookup, slowly: twelve hundred answers at five seconds each are a hundred minutes
 * on top of a full run that is given a hundred and fifty in all, and a run GitHub ends at its
 * ceiling publishes nothing and leaves its lock behind. A sweep at RAWG's usual pace is five to
 * ten minutes, so twenty is room for a slow night and no more; what was not asked waits for the
 * next full run, exactly as it does past the cap.
 */
export const STORE_REF_SWEEP_BUDGET_MS = 20 * 60_000

/** Why a sweep ended before it had asked about everything it meant to that night. */
export type SweepStop =
  /** Too many lookups failed: RAWG is refusing, and the rest would fail too. */
  | 'failures'
  /** The sweep's time for the night ran out: RAWG is answering, slowly. */
  | 'time'

/**
 * Failures the sweep shrugs off before it starts measuring them against what it has attempted.
 * Past both this and the share a stage tolerates (`MAX_ITEM_FAILURE_RATIO`) it stops for the
 * night: see `sweepStoreRefs`.
 */
export const STORE_REF_TOLERATED_FAILURES = 5

/** The RAWG store ids of GOG and of the Xbox store; `store_id` on a store link row. */
const GOG_STORE_ID = 5
const XBOX_STORE_ID = 2

const GOG_HOSTS = new Set(['www.gog.com', 'gog.com'])
const MICROSOFT_HOSTS = new Set(['www.microsoft.com', 'microsoft.com'])
const XBOX_HOSTS = new Set(['www.xbox.com', 'xbox.com'])

/** A GOG slug as the catalog spells every one of them: lower-case letters, digits, underscores. */
const GOG_SLUG = /^[a-z0-9_]{1,200}$/

/** Whether text is a slug a GOG game page can have — the only kind a reference can hold. */
export function isGogSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && GOG_SLUG.test(slug)
}

/** A Microsoft product id: twelve letters and digits, in either case in a link. */
const MICROSOFT_PRODUCT_ID = /^[0-9a-z]{12}$/i
/** The name a Microsoft link carries before the id: letters, digits and hyphens. */
const MICROSOFT_PRODUCT_NAME = /^[a-z0-9-]{1,200}$/i
/** A locale as a store puts one in a path: `en`, `fr`, `en-us`, `en-US`. */
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i

/** RAWG id to the game's store references; a game that is absent has never been asked about. */
export type StoreRefMap = Map<number, IndexedStoreRefs>

/** The two stores RAWG lists the game on, by the document's own `stores`. */
export function listedOfferStores(game: Pick<IndexedGame, 'stores'>): OfferStore[] {
  return OFFER_STORES.filter((store) => game.stores.includes(store))
}

/** Whether a record says anything about a store: a reference, or `null` for "none to read". */
function isAskedAbout(record: IndexedStoreRefs | undefined, store: OfferStore): boolean {
  return (store === 'gog' ? record?.gog : record?.microsoft) !== undefined
}

/**
 * Whether RAWG has to be asked about the game: it is listed on a store its record says nothing
 * about. A game listed on neither store never is; a game with a record is again when a store it
 * was not listed on before turns up in its `stores`.
 */
export function needsStoreLookup(
  game: Pick<IndexedGame, 'stores'>,
  record: IndexedStoreRefs | undefined,
): boolean {
  return listedOfferStores(game).some((store) => !isAskedAbout(record, store))
}

/**
 * The segments of an http(s) URL's path on one of `hosts`, or `null` for anything else. Parsed
 * with `URL`, as `safeExternalUrl` parses, so a host is compared as a host: `gog.com.example` and
 * `example.com/gog.com/` are neither of them GOG. A query string and a fragment are not part of
 * the path and are ignored, and so is one trailing slash; any other empty segment is not.
 */
function pathSegments(raw: string | null | undefined, hosts: ReadonlySet<string>): string[] | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!hosts.has(url.hostname) || url.port !== '') return null
  const segments = url.pathname.split('/').slice(1)
  if (segments.at(-1) === '') segments.pop()
  return segments.some((segment) => segment === '') ? null : segments
}

/**
 * The slug of a GOG game page: the one path segment after `/game/`, with or without a locale in
 * front of it — `https://www.gog.com/game/cyberpunk_2077`, `http://www.gog.com/game/limbo`,
 * `https://www.gog.com/fr/game/doom_2016` — which is every shape RAWG's links were seen in
 * (`docs/specs/2026-10-12-other-store-prices-design.md`, "Verified"). `null` for anything else: a
 * search page, a forum thread, a path with more after the slug, a slug GOG could not have written.
 */
export function gogSlugFromUrl(raw: string | null | undefined): string | null {
  const segments = pathSegments(raw, GOG_HOSTS)
  if (!segments) return null
  if (segments.length === 3 && LOCALE_SEGMENT.test(segments[0]!)) segments.shift()
  if (segments.length !== 2 || segments[0] !== 'game') return null
  const slug = segments[1]!
  return GOG_SLUG.test(slug) ? slug : null
}

/**
 * The product a Microsoft Store link names: the twelve-character id that ends its path, and the
 * name in front of it. The shapes are the ones RAWG's links were seen in —
 * `microsoft.com/en-us/p/{name}/{id}`, `/en-us/store/p/{name}/{id}` and `/en-us/store/r/{name}/{id}`
 * — and `xbox.com/en-us/games/store/{name}/{id}`, which the design names and no link seen had.
 * The locale may be missing; a query string (`?cid=msft_web_chart`) is ignored.
 *
 * The id comes back in upper case, as Microsoft's catalog spells it, and the name in lower case.
 * `null` for anything else — an id of eleven or thirteen characters, a path that goes on after
 * the id, an app page, the Xbox 360 marketplace.
 */
export function microsoftProductFromUrl(
  raw: string | null | undefined,
): NonNullable<IndexedStoreRefs['microsoft']> | null {
  const onMicrosoft = pathSegments(raw, MICROSOFT_HOSTS)
  const segments = onMicrosoft ?? pathSegments(raw, XBOX_HOSTS)
  if (!segments) return null
  if (segments.length > 0 && LOCALE_SEGMENT.test(segments[0]!)) segments.shift()

  // What is left has to be one of the product paths, whole: `p/…` and `store/p/…` or `store/r/…`
  // on microsoft.com, `games/store/…` on xbox.com, and then exactly a name and an id.
  const marker = segments.slice(0, -2).join('/')
  const expected = onMicrosoft ? ['p', 'store/p', 'store/r'] : ['games/store']
  if (segments.length < 3 || !expected.includes(marker)) return null

  const [name, id] = segments.slice(-2) as [string, string]
  if (!MICROSOFT_PRODUCT_NAME.test(name) || !MICROSOFT_PRODUCT_ID.test(id)) return null
  return { id: id.toUpperCase(), name: name.toLowerCase() }
}

/**
 * The record one lookup makes: what the game's store links say, and for which stores the question
 * is thereby settled.
 *
 * A reference is the first GOG row whose link is a GOG game page, and the first Xbox-store row
 * whose link is a Microsoft product. A row is taken for a store only when RAWG files it under
 * that store *and* the link has that store's shape, so a link in the wrong row is not a reference
 * either.
 *
 * `listed` is the game's own `stores`. A store among them with no such link is recorded as `null`
 * — asked, and nothing to read — so the game is not looked up for it again. A store that is
 * neither linked nor listed is left out, and the record says nothing about it: when RAWG lists the
 * game there one day, it is asked about then.
 */
export function storeRefsFromLinks(
  links: readonly RawgStoreLink[] | null | undefined,
  listed: readonly string[] = [],
): IndexedStoreRefs {
  const refs: IndexedStoreRefs = {}
  for (const link of links ?? []) {
    if (link?.store_id === GOG_STORE_ID && refs.gog === undefined) {
      const slug = gogSlugFromUrl(link.url)
      if (slug) refs.gog = slug
    }
    if (link?.store_id === XBOX_STORE_ID && refs.microsoft === undefined) {
      const product = microsoftProductFromUrl(link.url)
      if (product) refs.microsoft = product
    }
  }
  if (refs.gog === undefined && listed.includes('gog')) refs.gog = null
  if (refs.microsoft === undefined && listed.includes('xbox-store')) refs.microsoft = null
  return refs
}

/**
 * A record as the price stages may use it: only the references, and only those that are what
 * this module would have written. The mapping outlives every build that writes it, and what is
 * read back from a store is about to become part of a request to somebody else's server and of a
 * link on a page, so nothing is taken from it on trust. A store recorded as `null` has no
 * reference, and comes out as absent.
 */
export function usableStoreRefs(record: IndexedStoreRefs | undefined): IndexedStoreRefs {
  const refs: IndexedStoreRefs = {}
  if (typeof record?.gog === 'string' && GOG_SLUG.test(record.gog)) refs.gog = record.gog
  const product = record?.microsoft
  if (
    product &&
    typeof product.id === 'string' &&
    /^[0-9A-Z]{12}$/.test(product.id) &&
    typeof product.name === 'string' &&
    MICROSOFT_PRODUCT_NAME.test(product.name)
  ) {
    refs.microsoft = { id: product.id, name: product.name.toLowerCase() }
  }
  return refs
}

/**
 * The store links of one RAWG answer to `games/{slug}/stores`, or `null` when the body is not such
 * an answer. RAWG has been seen sending an empty body under a 200; read as "no links", that would
 * be remembered for good as "this game has no link to read".
 */
export function storeLinksOf(body: unknown): RawgStoreLink[] | null {
  if (body === null || typeof body !== 'object') return null
  const results = (body as { results?: unknown }).results
  return Array.isArray(results) ? (results as RawgStoreLink[]) : null
}

export interface StoreRefsOptions {
  /** RAWG lookups this run may spend; `STORE_REF_SWEEP_PER_RUN` when omitted. */
  limit?: number
  /** How many records to accumulate before one `setStoreRefs` round trip. */
  batchSize?: number
}

export interface StoreRefsResult {
  /** The record of every game of the run that has one, written this run or before it. */
  refs: StoreRefMap
  /** Games asked about in this run: RAWG requests, whatever came of them. */
  attempted: number
  /** Those RAWG would not answer for; their records are as they were and they are asked again. */
  failures: number
  /** Games still waiting to be asked about when the stage ended: the next full run's work. */
  remaining: number
  /** Why the sweep gave up for the night before its cap, or `null` when it did not. */
  stopped: SweepStop | null
}

/**
 * The stage of a full run that asks RAWG about the games waiting to be asked (`needsStoreLookup`)
 * — those it lists on GOG or on the Xbox store and has not answered for — and hands every stage
 * after it the mapping for the run's games. A game on neither store is not asked, and gets no
 * record: there is nothing to remember about a question that was never put.
 *
 * **Progress is the mapping itself**, as it is for the app ids: a store a game has been asked
 * about is never asked about again, so a run that dies has lost at most one unwritten batch.
 * **The cursor is only where the next run starts.** The waiting games are taken in the order of
 * their RAWG ids, beginning after the last one the sweep asked about and wrapping round, so a
 * game RAWG keeps refusing to answer for is met again after all the others have had their turn
 * rather than first thing every night, at the head of the cap.
 *
 * A lookup that fails writes nothing — never "no link to read", which would make one timeout
 * permanent — and the game is asked about again on a later run. One that succeeds replaces the
 * game's record whole: the links are the whole of what RAWG knows, for both stores at once.
 *
 * **It cannot cost the run.** These references only add prices to a catalog that is complete
 * without them, so the stage does not hold a failing RAWG to the budget the app ids do: past
 * `STORE_REF_TOLERATED_FAILURES` failures and a twentieth of what it attempted, it stops and
 * leaves the rest for the next full run. Nor may it take the run's time: it stops as well once
 * `STORE_REF_SWEEP_BUDGET_MS` has passed on the job's clock, whatever the reason each lookup was
 * slow. Either way what it had read is kept, and the result says which of the two ended it.
 *
 * The cursor is cleared whenever nothing is waiting, including on a night that finds nothing to
 * do: the waiting games of an earlier, cut-short night can be settled another way — they leave
 * the index, or the app-id stage writes their record — and a key nobody reads is not kept.
 */
export async function sweepStoreRefs(
  deps: JobDeps,
  games: IndexedGame[],
  options: StoreRefsOptions = {},
): Promise<StoreRefsResult> {
  const limit = options.limit ?? STORE_REF_SWEEP_PER_RUN
  const batchSize = options.batchSize ?? STORE_REF_BATCH_SIZE
  const known = await deps.writer.getStoreRefs(games.map((game) => game.id))

  const pending = games
    .filter((game) => needsStoreLookup(game, known.get(game.id)))
    .sort((left, right) => left.id - right.id)
  if (pending.length === 0) {
    // One idempotent delete a full run, rather than a read to learn whether there is a key.
    await deps.writer.clearCursor(STORE_REF_CURSOR)
    deps.log(`store references: none of ${games.length} games is waiting to be asked about`)
    return { refs: known, attempted: 0, failures: 0, remaining: 0, stopped: null }
  }

  const stored = await deps.writer.getCursor(STORE_REF_CURSOR)
  const after = stored === null ? Number.NaN : Number(stored)
  const start = Number.isFinite(after) ? pending.findIndex((game) => game.id > after) : 0
  const queue = [...pending.slice(Math.max(start, 0)), ...pending.slice(0, Math.max(start, 0))]

  const startedAt = deps.clock.now()
  let attempted = 0
  let failures = 0
  let stopped: SweepStop | null = null
  let batch: [number, IndexedStoreRefs][] = []
  let lastAsked: number | null = null

  async function flush(): Promise<void> {
    if (batch.length > 0) await deps.writer.setStoreRefs(batch)
    batch = []
    if (lastAsked !== null) await deps.writer.setCursor(STORE_REF_CURSOR, String(lastAsked))
    lastAsked = null
    // Twelve hundred lookups are five minutes of a run; the lock needs a sign of life in them.
    await deps.writer.renewLock()
  }

  try {
    for (const game of queue.slice(0, Math.max(0, limit))) {
      // Looked at before a lookup is started, never in the middle of one: the game that would
      // have been next is simply first in line on the next full run.
      if (deps.clock.now() - startedAt >= STORE_REF_SWEEP_BUDGET_MS) {
        stopped = 'time'
        break
      }
      attempted += 1
      lastAsked = game.id
      try {
        const links = storeLinksOf(await deps.rawg(`games/${game.slug}/stores`))
        if (!links) throw new Error('RAWG answered without a list of store links')
        const refs = storeRefsFromLinks(links, game.stores)
        known.set(game.id, refs)
        batch.push([game.id, refs])
      } catch {
        failures += 1
        deps.log(`store references: ${game.slug} could not be read, leaving it for a later run`)
        if (
          failures > STORE_REF_TOLERATED_FAILURES &&
          failures > attempted * MAX_ITEM_FAILURE_RATIO
        ) {
          stopped = 'failures'
          break
        }
      }
      if (attempted % batchSize === 0) await flush()
    }
  } finally {
    // Whatever was read before the stage ended is quota already spent, and worth keeping.
    await flush()
  }

  const remaining = pending.length - (attempted - failures)
  // Nothing left to sweep: the cursor has done its work, and a key nobody reads is not kept.
  if (remaining === 0) await deps.writer.clearCursor(STORE_REF_CURSOR)

  deps.log(
    `store references: ${attempted - failures} games read this run, ${failures} failed, ${remaining} left for the next full run` +
      (stopped === 'failures' ? ' — stopped early, too many lookups failed' : '') +
      (stopped === 'time' ? ' — stopped early, the sweep had used its twenty minutes' : ''),
  )
  return { refs: known, attempted, failures, remaining, stopped }
}

/**
 * Where the mapping stands for the run's games: how many RAWG lists on GOG or on the Xbox store,
 * how many of those have been asked about every store they are listed on, and how many games the
 * mapping names a GOG page and a Microsoft product for.
 */
export function countStoreRefs(
  games: readonly IndexedGame[],
  refs: StoreRefMap,
): { listed: number; asked: number; gog: number; microsoft: number } {
  let listed = 0
  let asked = 0
  let gog = 0
  let microsoft = 0
  for (const game of games) {
    const record = refs.get(game.id)
    if (listedOfferStores(game).length > 0) {
      listed += 1
      if (!needsStoreLookup(game, record)) asked += 1
    }
    const usable = usableStoreRefs(record)
    if (usable.gog) gog += 1
    if (usable.microsoft) microsoft += 1
  }
  return { listed, asked, gog, microsoft }
}
