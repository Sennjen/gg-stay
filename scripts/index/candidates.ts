import type { JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import { esrbToAgeRating, gameModesFromTags, storeSlugFromId } from '../../server/rawg/lookups'
import { positive } from '../../server/rawg/mappers'
import type { RawgGameListItem, RawgList } from '../../server/rawg/types'
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
 * Resuming: the cursor holds the number of the last page written into `collected`, and `collected`
 * is the caller's array, appended to page by page. A run that dies mid-stage therefore keeps both
 * halves of its progress — the games it had mapped and the page it stopped at — and the next
 * attempt starts at the page after the cursor. The cursor is cleared once the stage finishes, so
 * the next full run starts from the top of the list again.
 */

export const CANDIDATES_STAGE = 'candidates'

/** RAWG's largest page; 75 of them cover the 3 000 games the design indexes. */
export const CANDIDATE_PAGE_SIZE = 40
export const DEFAULT_CANDIDATE_PAGES = 75

export interface CandidatesOptions {
  /** How many RAWG pages to walk at most. */
  pages?: number
  /**
   * The accumulator, appended to as pages arrive and returned as `games`. Pass the same array back
   * after a failure to carry on where the last attempt stopped.
   */
  collected?: IndexedGame[]
}

export interface CandidatesResult {
  games: IndexedGame[]
  /** Pages fetched by this attempt — a resumed attempt reports only its own. */
  pagesFetched: number
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
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name ?? '',
    cover: safeExternalUrl(raw.background_image),
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
  const collected = options.collected ?? []
  const seen = new Set(collected.map((game) => game.id))

  const cursor = await deps.writer.getCursor(CANDIDATES_STAGE)
  const lastFinishedPage = cursor ? Number(cursor) : 0
  const firstPage = Number.isFinite(lastFinishedPage) ? lastFinishedPage + 1 : 1

  let pagesFetched = 0
  for (let page = firstPage; page <= pages; page += 1) {
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
      collected.push(game)
    }

    await deps.writer.setCursor(CANDIDATES_STAGE, String(page))
    if (!response.next) break
  }

  deps.log(`candidates: ${collected.length} games from ${pagesFetched} page(s)`)
  await deps.writer.clearCursor(CANDIDATES_STAGE)
  return { games: collected, pagesFetched }
}
