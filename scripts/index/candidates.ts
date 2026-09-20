import type { JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import { esrbToAgeRating, gameModesFromTags, storeSlugFromId } from '../../server/rawg/lookups'
import { positive } from '../../server/rawg/mappers'
import type { RawgGameListItem, RawgList, RawgShortScreenshot } from '../../server/rawg/types'
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
const PAGES_PER_LOCK_RENEWAL = 20

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

export async function collectCandidates(
  deps: JobDeps,
  options: CandidatesOptions = {},
): Promise<CandidatesResult> {
  const pages = options.pages ?? DEFAULT_CANDIDATE_PAGES
  const games: IndexedGame[] = []
  const seen = new Set<number>()

  let pagesFetched = 0
  for (let page = 1; page <= pages; page += 1) {
    const response = (await deps.rawg('games', {
      ordering: '-added',
      page_size: CANDIDATE_PAGE_SIZE,
      page,
    })) as RawgList<RawgGameListItem>
    pagesFetched += 1

    for (const raw of response.results ?? []) {
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
 */
export async function carryPublishedForward(deps: JobDeps, games: IndexedGame[]): Promise<number> {
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

  deps.log(`candidates: carried the published price and languages forward for ${carried} games`)
  return carried
}
