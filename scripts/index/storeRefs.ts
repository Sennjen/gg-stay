import { MAX_ITEM_FAILURE_RATIO, oneLine, type JobDeps } from './deps'
import {
  MAX_STORE_LINK_LENGTH,
  MAX_STORE_LINKS,
  OFFER_STORES,
  type IndexedGame,
  type IndexedStoreRefs,
  type OfferStore,
} from '../../server/index/document'
import type { RawgStoreLink } from '../../server/rawg/types'
import { safeExternalUrl } from '../../shared/url'

/**
 * Which product a game is on GOG, on the Microsoft Store and on the PlayStation Store — the
 * stores, other than Steam, whose prices the job reads (`offers.ts`, `playstationOffers.ts`) —
 * and the sweep that finds it for the games the index already held when those prices were added.
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
 * **Only a game RAWG lists on one of these stores is asked about**, and which those are is in
 * the documents already: `IndexedGame.stores` is RAWG's own list of the stores a game is on, read
 * from the page of the list the game came from (`toIndexedGame`), under the slugs the site uses
 * (`gog`, `xbox-store`, `playstation-store`). It is the list the app-id stage has always trusted
 * for Steam, and it and the links are one table at RAWG — a game's store rows there carry the ids
 * its link rows have, and the two agreed in every case checked, both ways round — so a game
 * listed on none of the stores has no link to find and costs no request. "Asked" is remembered
 * store by store (`IndexedStoreRefs`): a store the game is listed on with no link the job can
 * read is recorded as such and not asked about again, and a game that gains a store later is
 * asked then.
 *
 * That last rule is also how a store is added to this list. When the PlayStation Store joined
 * it, every game RAWG lists there had a record that said nothing about it, so every one of them
 * was waiting to be asked: the sweep below takes them a capped number a night, like the games it
 * was written for, and nothing else had to be built.
 *
 * Whoever asks keeps the answer whole: beside the three references a record holds every link RAWG
 * gave (`IndexedStoreRefs.links`), bounded and checked by `linksToKeep`, so that reading another
 * store one day starts from what is already known. Only a reference parser reads them. The
 * PlayStation Store is the first store read that way: a record that kept its links and says
 * nothing of that store is completed from them by the sweep, with no request
 * (`playstationFromLinks`).
 *
 * A game new to the index gets its references with its app id, from the very same response
 * (`resolveAppIds`), at no request of its own. Everything else — the games resolved before this
 * existed, and the games RAWG does not list on Steam, which `resolveAppIds` never asks about — is
 * swept here: at most `STORE_REF_SWEEP_PER_RUN` lookups in a full run, until every game listed on
 * one of the stores has been asked about each of them.
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

/**
 * Whether a stage RAWG is not allowed to fail has seen enough of it failing: past
 * `STORE_REF_TOLERATED_FAILURES` failures and past the share of its attempts a stage tolerates
 * (`MAX_ITEM_FAILURE_RATIO`). Both, so that a handful of timeouts early in a long stage does not
 * end it, and a RAWG that is refusing everything ends it at the sixth lookup.
 */
export function isFailingWholesale(failures: number, attempted: number): boolean {
  return failures > STORE_REF_TOLERATED_FAILURES && failures > attempted * MAX_ITEM_FAILURE_RATIO
}

/**
 * The RAWG store ids of GOG, of the Xbox store and of the PlayStation Store; `store_id` on a
 * store link row.
 */
const GOG_STORE_ID = 5
const XBOX_STORE_ID = 2
const PLAYSTATION_STORE_ID = 3

const GOG_HOSTS = new Set(['www.gog.com', 'gog.com'])
const MICROSOFT_HOSTS = new Set(['www.microsoft.com', 'microsoft.com'])
const XBOX_HOSTS = new Set(['www.xbox.com', 'xbox.com'])
const PLAYSTATION_HOSTS = new Set(['store.playstation.com'])

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

/**
 * A locale as the PlayStation Store puts one in a path: a language and a country, with a script
 * between them for the few that need one — `en-us`, `uk-ua`, `zh-hans-hk`. Never a language
 * alone: that store has no page without a country.
 */
const PLAYSTATION_LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{4})?-[a-z]{2}$/i

/**
 * A PlayStation product id, whole, with its title id as the one group:
 * `UP1004-CUSA00419_00-GTAVDIGITALDOWNL` is the region and the publisher, the title, and a label
 * of sixteen letters and digits. Upper case throughout, as Sony writes every one of them.
 */
const PLAYSTATION_PRODUCT_ID = /^[A-Z]{2}\d{4}-([A-Z]{4}\d{5}_\d{2})-[A-Z0-9]{16}$/

/**
 * A title of the two consoles the current store sells for: `CUSA` is a PlayStation 4 title and
 * `PPSA` a PlayStation 5 one. Every other family — `NPUB` and `BLUS` for the PlayStation 3,
 * `PCSE` for the Vita — is a title the store no longer carries at all.
 */
const PLAYSTATION_TITLE_ID = /^(?:CUSA|PPSA)\d{5}_\d{2}$/

/** Whether text is a product id the PlayStation Store could have written. */
export function isPlaystationProductId(id: unknown): id is string {
  return typeof id === 'string' && PLAYSTATION_PRODUCT_ID.test(id)
}

/** Whether text is the id of a PlayStation 4 or PlayStation 5 title — the only kind a reference holds. */
export function isPlaystationTitleId(id: unknown): id is string {
  return typeof id === 'string' && PLAYSTATION_TITLE_ID.test(id)
}

/** RAWG id to the game's store references; a game that is absent has never been asked about. */
export type StoreRefMap = Map<number, IndexedStoreRefs>

/** The stores, of those the job reads, that RAWG lists the game on, by the document's own `stores`. */
export function listedOfferStores(game: Pick<IndexedGame, 'stores'>): OfferStore[] {
  return OFFER_STORES.filter((store) => game.stores.includes(store))
}

/** What a record says of one store: a reference, `null` for "none to read", or nothing at all. */
function fieldOf(record: IndexedStoreRefs | undefined, store: OfferStore): unknown {
  switch (store) {
    case 'gog':
      return record?.gog
    case 'xbox-store':
      return record?.microsoft
    case 'playstation-store':
      return record?.playstation
  }
}

/** Whether a record says anything about a store: a reference, or `null` for "none to read". */
function isAskedAbout(record: IndexedStoreRefs | undefined, store: OfferStore): boolean {
  return fieldOf(record, store) !== undefined
}

/**
 * Whether RAWG has to be asked about the game: it is listed on a store its record says nothing
 * about. A game listed on none of the stores never is; a game with a record is again when a
 * store it was not listed on before turns up in its `stores` — or when a store the job did not
 * read before joins `OFFER_STORES`, which the record of no game says anything about.
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
 * The title a PlayStation Store link names: the title id in the middle of the product id that
 * ends its path, `store.playstation.com/{locale}/product/{productId}` — the one shape RAWG's
 * links were seen in, every one of them under `en-us`
 * (`docs/specs/2026-10-13-playstation-store-prices-design.md`). A query string is ignored; one
 * link seen had a stray `?aaaa` after the id.
 *
 * Only the title is taken, never the product. The product id in a link of RAWG's is the American
 * one and, two times in three, one Sony no longer sells under; the title id is what Sony can
 * still be asked about, for any region (`playstation.ts`).
 *
 * And only a title of a console the store still sells for (`isPlaystationTitleId`). `null` for
 * anything else: a PlayStation 3 or Vita product, a concept page, a product id that is a
 * character short or in lower case, a path with no locale or with more after the id.
 */
export function playstationTitleFromUrl(raw: string | null | undefined): string | null {
  const segments = pathSegments(raw, PLAYSTATION_HOSTS)
  if (!segments || segments.length !== 3) return null
  const [locale, marker, productId] = segments as [string, string, string]
  if (!PLAYSTATION_LOCALE_SEGMENT.test(locale) || marker !== 'product') return null
  const titleId = PLAYSTATION_PRODUCT_ID.exec(productId)?.[1]
  return titleId !== undefined && PLAYSTATION_TITLE_ID.test(titleId) ? titleId : null
}

/** A timestamp this job wrote: ISO, in UTC, to the millisecond — `2026-10-13T06:15:00.000Z`. */
export const JOB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * What a record says of the PlayStation Store, as far as it is what this job would have written:
 * the title, what Sony said about it, and when Sony was last asked. `undefined` for a field that
 * is `null`, absent, or holds a title id that is not one.
 *
 * A concept id that is not a positive whole number or `null` is left out, which reads as "Sony
 * has not answered yet", and a date that is not one of the job's own is left out too, which
 * reads as "never asked": both are then simply asked for again. Nothing else the field holds is
 * passed on.
 */
function usablePlaystationRef(
  value: unknown,
): NonNullable<IndexedStoreRefs['playstation']> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { titleId, conceptId, mappedAt, askedAt } = value as Record<string, unknown>
  if (!isPlaystationTitleId(titleId)) return undefined
  const ref: NonNullable<IndexedStoreRefs['playstation']> = { titleId }
  if (conceptId === null) ref.conceptId = null
  else if (typeof conceptId === 'number' && Number.isSafeInteger(conceptId) && conceptId > 0) {
    ref.conceptId = conceptId
  }
  const isDate = (at: unknown): at is string => typeof at === 'string' && JOB_TIMESTAMP.test(at)
  if (isDate(mappedAt)) {
    ref.mappedAt = mappedAt
    if (isDate(askedAt)) ref.askedAt = askedAt
  } else if (isDate(askedAt)) {
    // Written before the mapping and the price had a date each: its one date was the mapping's,
    // and the price has never been asked.
    ref.mappedAt = askedAt
  }
  return ref
}

/**
 * The record one lookup makes: what the game's store links say, and for which stores the question
 * is thereby settled.
 *
 * A reference is the first GOG row whose link is a GOG game page, the first Xbox-store row whose
 * link is a Microsoft product, and the first PlayStation-store row whose link names a PlayStation
 * 4 or PlayStation 5 title. A row is taken for a store only when RAWG files it under that store
 * *and* the link has that store's shape, so a link in the wrong row is not a reference either.
 *
 * `listed` is the game's own `stores`. A store among them with no such link is recorded as `null`
 * — asked, and nothing to read — so the game is not looked up for it again. A store that is
 * neither linked nor listed is left out, and the record says nothing about it: when RAWG lists the
 * game there one day, it is asked about then.
 *
 * `previous` is the record the game had, when it had one. RAWG's links are the whole of what
 * RAWG knows, so nothing of the old record survives a new one — except what was never RAWG's:
 * what Sony answered about the game's PlayStation title, and when it was last asked (`conceptId`,
 * `askedAt`). That cost a request to Sony, which is the scarcest thing this job spends, and it is
 * still true for as long as the link names the same title; so it is kept exactly then, and
 * dropped with a title that changed.
 */
export function storeRefsFromLinks(
  links: readonly RawgStoreLink[] | null | undefined,
  listed: readonly string[] = [],
  previous?: IndexedStoreRefs,
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
    if (link?.store_id === PLAYSTATION_STORE_ID && refs.playstation === undefined) {
      const titleId = playstationTitleFromUrl(link.url)
      if (titleId) {
        const known = usablePlaystationRef(previous?.playstation)
        refs.playstation = known?.titleId === titleId ? known : { titleId }
      }
    }
  }
  if (refs.gog === undefined && listed.includes('gog')) refs.gog = null
  if (refs.microsoft === undefined && listed.includes('xbox-store')) refs.microsoft = null
  if (refs.playstation === undefined && listed.includes('playstation-store')) {
    refs.playstation = null
  }
  return refs
}

/**
 * A record RAWG's answer has just made (`storeRecordFromLinks`), with what the stores' own ways
 * had found for the game carried over from the record it replaces (`IndexedStoreRefs.fallbacks`),
 * for each store the new record still answers about. A rewrite is RAWG speaking again about its
 * links, not about what the job found by other means; dropped with the old record, a find would
 * take its offer with it, and the Microsoft Store's would wait thirty days to be found again.
 *
 * A store the new record says nothing about takes nothing with it. Everything else is the new
 * record's own, fields this module does not know included: whatever a newer builder puts in it
 * stays.
 */
export function carryFallbacks(
  previous: IndexedStoreRefs | undefined,
  next: IndexedStoreRefs,
): IndexedStoreRefs {
  const before = previous?.fallbacks
  if (!before || typeof before !== 'object') return next
  const carried: NonNullable<IndexedStoreRefs['fallbacks']> = {}
  if ('gog' in next && before.gog) carried.gog = before.gog
  if ('microsoft' in next && before.microsoft) carried.microsoft = before.microsoft
  return Object.keys(carried).length > 0
    ? { ...next, fallbacks: { ...next.fallbacks, ...carried } }
    : next
}

/**
 * The links of one RAWG answer as a record keeps them (`IndexedStoreRefs.links`): every link that
 * is an absolute http(s) URL of at most `MAX_STORE_LINK_LENGTH` characters under a whole-number
 * store id, in RAWG's order, and the first `MAX_STORE_LINKS` of those.
 *
 * A link is kept as `URL` writes it (`safeExternalUrl`): the same address, without credentials,
 * with nothing in it that is not part of a URL, and it is that text the length is measured on. A
 * reference parser reads a link through `URL` as well, so it finds in the kept text exactly what
 * it would have found in RAWG's. A link that fails a check is left out and costs the others
 * nothing; what is left out can only be asked for again.
 *
 * Nothing here says which store a link belongs to beyond RAWG's own id for it: the links are kept
 * for stores the job cannot read yet, and reading one is its parser's work, by its shape.
 */
export function linksToKeep(
  links: readonly RawgStoreLink[] | null | undefined,
): NonNullable<IndexedStoreRefs['links']> {
  const kept: NonNullable<IndexedStoreRefs['links']> = []
  for (const link of links ?? []) {
    if (kept.length >= MAX_STORE_LINKS) break
    const storeId = link?.store_id
    if (typeof storeId !== 'number' || !Number.isSafeInteger(storeId) || storeId < 1) continue
    const url = typeof link?.url === 'string' ? safeExternalUrl(link.url) : null
    if (url === null || url.length > MAX_STORE_LINK_LENGTH) continue
    kept.push([storeId, url])
  }
  return kept
}

/**
 * The record one RAWG answer is kept as, whichever stage asked: what `storeRefsFromLinks` reads
 * from the links — the three references, with what Sony had said about an unchanged PlayStation
 * title, and the marks of the stores the game is listed on — and the links themselves beside
 * them (`linksToKeep`).
 *
 * The links change nothing about what the record says of the stores: `needsStoreLookup` reads the
 * three store fields and nothing else. They are left out when there is none to keep, so the
 * record of a game RAWG gave no link for is what it always was.
 *
 * `previous` is the record this one replaces, when the game had one: what the stores' own ways
 * had found for it is carried over (`carryFallbacks`). Every stage that writes a record from
 * RAWG's links goes through here, so none of them can drop a find.
 */
export function storeRecordFromLinks(
  links: readonly RawgStoreLink[] | null | undefined,
  listed: readonly string[] = [],
  previous?: IndexedStoreRefs,
): IndexedStoreRefs {
  // What Sony said about an unchanged PlayStation title rides on `previous` as well.
  const record = storeRefsFromLinks(links, listed, previous)
  const kept = linksToKeep(links)
  if (kept.length > 0) record.links = kept
  return carryFallbacks(previous, record)
}

/**
 * A record that says nothing about the PlayStation Store, completed from the links it keeps
 * (`IndexedStoreRefs.links`): what a RAWG lookup would have written for that store, and no
 * request made. `undefined` when there is nothing to complete — the record has a PlayStation
 * field already, keeps no links, or its links have no row of that store at all.
 *
 * The links are the answer RAWG gave when the record was written, all of it, and that is what
 * `storeRefsFromLinks` reads: the first PlayStation-store row whose link names a PlayStation 4 or
 * 5 title, or `null` — asked, nothing to read — for a game whose PlayStation-store rows name no
 * such title (a PlayStation 3 product, say). A record whose links have no PlayStation-store row is
 * left to RAWG: the game may have come to the store after its links were read, and "no link" from
 * links that old would be an answer nobody gave. Every other field of the record is kept as it is: references,
 * marks, links, the stores' own finds, and whatever a newer build put there.
 *
 * It is how a store the job learned to read after a record was written takes its reference from
 * what is already known (`links`' own reason to be kept), so that only a game whose record keeps
 * no links costs the sweep a RAWG request for it.
 */
export function playstationFromLinks(
  record: IndexedStoreRefs | undefined,
  listed: readonly string[],
): IndexedStoreRefs | undefined {
  if (!record || record.playstation !== undefined || !Array.isArray(record.links)) return undefined
  const links: RawgStoreLink[] = record.links.flatMap((entry) =>
    Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'string'
      ? [{ store_id: entry[0], url: entry[1] }]
      : [],
  )
  // Links with no PlayStation-store row at all say nothing either way: RAWG may have had none
  // for the game, or listed it there only after the record was written. RAWG is asked then.
  if (!links.some((link) => link.store_id === PLAYSTATION_STORE_ID)) return undefined
  const { playstation } = storeRefsFromLinks(links, listed)
  return playstation === undefined ? undefined : { ...record, playstation }
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
  const playstation = usablePlaystationRef(record?.playstation)
  if (playstation) refs.playstation = playstation
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
  /**
   * Records completed from the links they keep, with no request (`playstationFromLinks`).
   * Optional for the callers that build a result of their own.
   */
  fromLinks?: number
}

/**
 * The stage of a full run that asks RAWG about the games waiting to be asked (`needsStoreLookup`)
 * — those it lists on GOG, on the Xbox store or on the PlayStation Store and has not answered for
 * — and hands every stage after it the mapping for the run's games. A game on none of them is
 * not asked, and gets no record: there is nothing to remember about a question that was never
 * put.
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
 * game's record whole: the links are the whole of what RAWG knows, for every store at once, and
 * the record keeps them (`storeRecordFromLinks`), so a store the job reads later needs no request
 * of its own for this game. What Sony has said about the game's PlayStation title is not RAWG's,
 * and is carried into the new record while the link still names that title, as the stores' own
 * finds are (`storeRefsFromLinks`, `carryFallbacks`).
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

  // A record that keeps RAWG's links says what a lookup would about a store the job learned to
  // read since: it is completed from them, and written, before anyone is counted as waiting.
  const completed: [number, IndexedStoreRefs][] = []
  for (const game of games) {
    const record = playstationFromLinks(known.get(game.id), game.stores)
    if (!record) continue
    known.set(game.id, record)
    completed.push([game.id, record])
  }
  for (let start = 0; start < completed.length; start += batchSize) {
    await deps.writer.setStoreRefs(completed.slice(start, start + batchSize))
  }
  if (completed.length > 0) {
    deps.log(`store references: ${completed.length} completed from the links they keep`)
  }
  const fromLinks = completed.length

  const pending = games
    .filter((game) => needsStoreLookup(game, known.get(game.id)))
    .sort((left, right) => left.id - right.id)
  if (pending.length === 0) {
    // One idempotent delete a full run, rather than a read to learn whether there is a key.
    await deps.writer.clearCursor(STORE_REF_CURSOR)
    deps.log(`store references: none of ${games.length} games is waiting to be asked about`)
    return { refs: known, attempted: 0, failures: 0, remaining: 0, stopped: null, fromLinks }
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
        const refs = storeRecordFromLinks(links, game.stores, known.get(game.id))
        known.set(game.id, refs)
        batch.push([game.id, refs])
      } catch {
        failures += 1
        deps.log(
          `store references: ${oneLine(game.slug)} could not be read, leaving it for a later run`,
        )
        if (isFailingWholesale(failures, attempted)) {
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
  return { refs: known, attempted, failures, remaining, stopped, fromLinks }
}

/**
 * Where the mapping stands for the run's games: how many RAWG lists on GOG, on the Xbox store or
 * on the PlayStation Store, how many of those have been asked about every store they are listed
 * on, and how many games the mapping names a GOG page, a Microsoft product and a PlayStation
 * title for.
 */
export function countStoreRefs(
  games: readonly IndexedGame[],
  refs: StoreRefMap,
): { listed: number; asked: number; gog: number; microsoft: number; playstation: number } {
  let listed = 0
  let asked = 0
  let gog = 0
  let microsoft = 0
  let playstation = 0
  for (const game of games) {
    const record = refs.get(game.id)
    if (listedOfferStores(game).length > 0) {
      listed += 1
      if (!needsStoreLookup(game, record)) asked += 1
    }
    const usable = usableStoreRefs(record)
    if (usable.gog) gog += 1
    if (usable.microsoft) microsoft += 1
    if (usable.playstation) playstation += 1
  }
  return { listed, asked, gog, microsoft, playstation }
}
