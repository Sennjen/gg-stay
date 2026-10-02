import { isMoodTag } from '../../shared/moodTags'
import type { JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import {
  esrbToAgeRating,
  gameModesFromTags,
  storeSlugFromId,
  tagsForGameModes,
} from '../../server/rawg/lookups'
import { positive } from '../../server/rawg/mappers'
import type { RawgParams } from '../../server/rawg/rawgFetch'
import type {
  RawgGameListItem,
  RawgList,
  RawgShortScreenshot,
  RawgTag,
} from '../../server/rawg/types'
import { safeExternalUrl } from '../../shared/url'

/**
 * Stage 1: who is in the index. RAWG's `-added` ordering is the popularity the whole catalog
 * already sorts by, so walking it from the top gives exactly the "3 000 most popular games" the
 * design indexes, and the `added` count doubles as every sort's tie-break.
 *
 * The card fields are mapped here once, by the same lookups the GraphQL path uses
 * (`server/rawg/lookups.ts`), so a genre slug, a platform id or a game mode means the same thing
 * in the index as on a RAWG-served page. Price and localisation stay empty: later stages fill
 * them, and a game they never reach is simply a game with no price, which the reader allows for.
 *
 * This stage deliberately has no resume point. Seventy-five pages cost about twenty seconds at the
 * transport's four requests a second and 0.4 % of RAWG's monthly quota, while a persisted page
 * cursor would let a run that died half way publish an index missing its most popular games — the
 * cursor would survive the crash and the documents would not. Every run walks from page one.
 */

/** RAWG's largest page; 75 of them cover the 3 000 games the design indexes. */
export const CANDIDATE_PAGE_SIZE = 40
export const DEFAULT_CANDIDATE_PAGES = 75
/** Pages between two renewals of the write lock; see `INDEX_LOCK_TTL_SECONDS`. */
export const PAGES_PER_LOCK_RENEWAL = 20

export interface CandidatesOptions {
  /** How many RAWG pages to walk at most. */
  pages?: number
}

export interface CandidatesResult {
  games: IndexedGame[]
  pagesFetched: number
}

/**
 * The card's hover preview: the first of RAWG's short screenshots that is not the cover. RAWG
 * carries the cover in that array under the id `-1`, and some entries repeat it by URL as well,
 * so both are skipped.
 */
export function previewOf(
  shots: RawgShortScreenshot[] | null | undefined,
  cover: string | null,
): string | null {
  for (const shot of shots ?? []) {
    if (shot.id === -1) continue
    const url = safeExternalUrl(shot.image)
    if (url && url !== cover) return url
  }
  return null
}

/** The most tags one document keeps; see `indexTags`. */
export const MAX_INDEXED_TAGS = 12

/**
 * Tags RAWG has on fewer games than this, over its whole catalog, are the long tail: noise too
 * rare to recur among the few thousand indexed games. Applied only when the response carries
 * `games_count`.
 */
export const MIN_TAG_GAMES_COUNT = 100

/**
 * Tags that say what the store or the build offers — achievements, trading cards, controller
 * support, cloud saves, remote play — rather than what the game is. Every other English RAWG tag
 * describes the game, even the very common ones: the similarity ranking weighs a tag by how rare it
 * is in the index, so "atmospheric" barely counts without being listed here.
 */
const STORE_TAGS = new Set([
  'in-app-purchases',
  'includes-level-editor',
  'includes-source-sdk',
  'family-sharing',
  'cloud-saves',
  'valve-anti-cheat-enabled',
  'captions-available',
  'commentary-available',
  'stats',
  'hdr-available',
  'early-access',
  'cross-platform-multiplayer',
  'steamvr-collectibles',
  'additional-high-quality-audio',
  // Platform exclusivity, which RAWG tags console exclusives with.
  'exclusive',
  'true-exclusive',
])
/** `steam-achievements`, `steam-cloud`, `steam-workshop`… — never `steampunk`. */
const STORE_TAG_PREFIXES = ['steam-', 'remote-play-']
/** `full-controller-support`, `partial-controller-support`, `tracked-controller-support`… */
const STORE_TAG_WORD = 'controller'

export function isStoreTag(slug: string): boolean {
  return (
    STORE_TAGS.has(slug) ||
    STORE_TAG_PREFIXES.some((prefix) => slug.startsWith(prefix)) ||
    slug.split('-').includes(STORE_TAG_WORD)
  )
}

/** The mode tags `gameModes` already carries; kept twice, they would count twice. */
const MODE_TAGS = new Set(tagsForGameModes(['SINGLE', 'LOCAL_COOP', 'ONLINE_COOP', 'MULTIPLAYER']))

/**
 * The tags an index document keeps, in RAWG's order:
 *
 * - not those in another language (RAWG tags every game in Russian as well; a tag that names no
 *   language is kept), store features or game modes;
 * - not the long tail — fewer than `MIN_TAG_GAMES_COUNT` games in RAWG's catalog;
 * - of the rest, the `MAX_INDEXED_TAGS` RAWG has seen on the fewest games (`games_count`), or the
 *   first ones in RAWG's order when the response carries no counts.
 *
 * RAWG lists a game's tags most common first, so a plain cut would keep "atmospheric" and "great
 * soundtrack" and drop "post-apocalyptic" or "chernobyl" — the tags that define the game. The cut
 * keeps the rarest instead. A kept tag that no other indexed game carries costs a slot and nothing
 * else: the similarity ranking leaves features of one game out of every vector.
 */
export function indexTags(tags: readonly RawgTag[] | null | undefined): string[] {
  const seen = new Set<string>()
  const eligible: { slug: string; count: number | undefined; position: number }[] = []
  for (const tag of tags ?? []) {
    const slug = tag.slug
    // Only an explicit other language drops a tag. A tag without `language` is taken as English:
    // the recorded fixtures carry none, nothing here proves every live tag does, and reading a
    // missing field as "not English" would quietly empty every document.
    if ((tag.language !== undefined && tag.language !== 'eng') || !slug || seen.has(slug)) continue
    if (isStoreTag(slug) || MODE_TAGS.has(slug)) continue
    seen.add(slug)
    const count = tag.games_count
    if (count !== undefined && count < MIN_TAG_GAMES_COUNT) continue
    eligible.push({ slug, count, position: eligible.length })
  }
  if (eligible.length <= MAX_INDEXED_TAGS) return eligible.map((tag) => tag.slug)
  if (eligible.some((tag) => tag.count === undefined)) {
    return eligible.slice(0, MAX_INDEXED_TAGS).map((tag) => tag.slug)
  }
  return [...eligible]
    .sort((left, right) => left.count! - right.count! || left.position - right.position)
    .slice(0, MAX_INDEXED_TAGS)
    .sort((left, right) => left.position - right.position)
    .map((tag) => tag.slug)
}

/**
 * The mood and sub-genre tags (`shared/moodTags.ts`) among a game's English tags, every one of
 * them and in RAWG's order. `indexTags` keeps only the rarest few for the similarity ranking, which
 * drops exactly the broad tags a visitor asks for by name — "horror", "atmospheric" — so these are
 * kept beside them, uncut, for `/api/ask`'s tag facets.
 */
export function moodTagsFrom(tags: readonly RawgTag[] | null | undefined): string[] {
  const kept: string[] = []
  for (const tag of tags ?? []) {
    if (tag.language !== undefined && tag.language !== 'eng') continue
    if (tag.slug && isMoodTag(tag.slug) && !kept.includes(tag.slug)) kept.push(tag.slug)
  }
  return kept
}

function taxonomySlugs(list: { slug?: string }[] | null | undefined): string[] {
  return (list ?? []).flatMap((item) => (item.slug ? [item.slug] : []))
}

/**
 * One RAWG list item as an index card, before any price or language is known. Returns `null` for
 * an entry without an id or a slug: those two are what the catalog routes and keys on, and a card
 * missing either could never be shown or fetched again.
 */
export function toIndexedGame(raw: RawgGameListItem): IndexedGame | null {
  if (!raw.id || !raw.slug) return null
  const cover = safeExternalUrl(raw.background_image)
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name ?? '',
    cover,
    preview: previewOf(raw.short_screenshots, cover),
    released: raw.released ?? null,
    popularity: raw.added ?? 0,
    platforms: (raw.platforms ?? []).flatMap((entry) =>
      typeof entry.platform?.id === 'number' ? [entry.platform.id] : [],
    ),
    genres: taxonomySlugs(raw.genres),
    tags: indexTags(raw.tags),
    moodTags: moodTagsFrom(raw.tags),
    stores: (raw.stores ?? []).flatMap((entry) => {
      const slug = storeSlugFromId(entry.store?.id)
      return slug ? [slug] : []
    }),
    gameModes: gameModesFromTags(taxonomySlugs(raw.tags)),
    ageRating: esrbToAgeRating(raw.esrb_rating?.slug),
    rating: positive(raw.rating),
    ratingsCount: raw.ratings_count ?? 0,
    metacritic: positive(raw.metacritic),
    playtime: positive(raw.playtime),
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: null,
  }
}

export type RawgGamesPage = RawgList<RawgGameListItem> & { results: RawgGameListItem[] }

/**
 * One page of a RAWG `games` list. RAWG has been seen answering a page with an empty body (`null`)
 * under a 200; the transport has nothing to retry there, so the page is asked for once more, and a
 * second bad answer fails by name — `what` says which page of which list — rather than with a
 * TypeError from deep inside the caller's loop. The popularity walk and the studio lists both read
 * their pages through here.
 */
export async function fetchGamesPage(
  deps: JobDeps,
  params: RawgParams,
  what: string,
): Promise<RawgGamesPage> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = (await deps.rawg('games', params)) as RawgList<RawgGameListItem> | null
    if (response && Array.isArray(response.results)) return response as RawgGamesPage
  }
  throw new Error(`RAWG answered ${what} without a result list twice`)
}

function fetchCandidatePage(deps: JobDeps, page: number): Promise<RawgGamesPage> {
  return fetchGamesPage(
    deps,
    { ordering: '-added', page_size: CANDIDATE_PAGE_SIZE, page },
    `page ${page} of the popularity list`,
  )
}

export async function collectCandidates(
  deps: JobDeps,
  options: CandidatesOptions = {},
): Promise<CandidatesResult> {
  const pages = options.pages ?? DEFAULT_CANDIDATE_PAGES
  const games: IndexedGame[] = []
  const seen = new Set<number>()

  let pagesFetched = 0
  for (let page = 1; page <= pages; page += 1) {
    const response = await fetchCandidatePage(deps, page)
    pagesFetched += 1

    for (const raw of response.results) {
      const game = toIndexedGame(raw)
      // RAWG pages shift under a run that takes an hour, so the same game can arrive twice.
      if (!game || seen.has(game.id)) continue
      seen.add(game.id)
      games.push(game)
    }

    if (pagesFetched % PAGES_PER_LOCK_RENEWAL === 0) await deps.writer.renewLock()
    if (!response.next) break
  }

  deps.log(`candidates: ${games.length} games from ${pagesFetched} page(s)`)
  return { games, pagesFetched }
}

/**
 * Copies what the published version already knows onto freshly mapped candidates: the price, the
 * free flag and the localisation. A full run would otherwise start every game at "no price" and a
 * single bad Steam answer would publish a catalog with the price silently gone, which the price
 * stage's keep-what-we-had rule and the publication's priced-count gate both measure against.
 *
 * Never the made-in-Ukraine flag: the studios stage owns it, and keeps a published flag only for a
 * studio it could not read tonight, so a studio taken off the list takes its flags with it.
 */
export async function carryPublishedForward(
  deps: JobDeps,
  games: IndexedGame[],
  stage = 'candidates',
): Promise<number> {
  if (games.length === 0) return 0
  const published = await deps.writer.getMany(games.map((game) => game.id))
  if (published.size === 0) return 0

  let carried = 0
  for (const game of games) {
    const previous = published.get(game.id)
    if (!previous) continue
    game.priceUah = previous.priceUah
    game.regularPriceUah = previous.regularPriceUah
    game.discountPercent = previous.discountPercent
    game.free = previous.free
    game.priceUpdatedAt = previous.priceUpdatedAt
    game.localisation = previous.localisation ? { ...previous.localisation } : null
    carried += 1
  }

  deps.log(`${stage}: carried the published price and languages forward for ${carried} games`)
  return carried
}
