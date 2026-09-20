import type {
  Game,
  GameCard,
  GamePage,
  Image,
  StoreOffer,
  Taxonomy,
} from '../graphql/__generated__/resolvers-types'
import type {
  RawgGameDetail,
  RawgGameListItem,
  RawgList,
  RawgScreenshot,
  RawgShortScreenshot,
  RawgStoreLink,
  RawgTaxonomy,
} from './types'
import { safeExternalUrl } from '../../shared/url'
import {
  esrbToAgeRating,
  gameModesFromTags,
  platformFamiliesFromSlugs,
  storeSlugFromId,
} from './lookups'

export function mapTaxonomy(raw: RawgTaxonomy): Taxonomy {
  return { id: String(raw.id ?? ''), slug: raw.slug ?? '', name: raw.name ?? '' }
}

function mapTaxonomies(list?: RawgTaxonomy[] | null): Taxonomy[] {
  return (list ?? []).filter((item) => item.slug).map(mapTaxonomy)
}

/**
 * Image URLs go through the same scheme allow-list as the links: `img-src` in the CSP already
 * stops a `javascript:` value from doing anything, but it does allow `data:` (for the inline
 * placeholders the image module emits), and C3's rule is every third-party URL bound to `href`
 * **or** `src`. A cover that fails the check is dropped, and the card renders its no-cover state.
 */
export function mapCover(url?: string | null): Image | null {
  const safe = safeExternalUrl(url)
  return safe ? { url: safe, width: null, height: null } : null
}

/** RAWG uses 0 for "unknown" on numeric fields; negative values are also treated as unknown. */
export function positive(value?: number | null): number | null {
  return value && value > 0 ? value : null
}

/** `short_screenshots`: exclude the id -1 entry (it duplicates the cover) and cap at 4. */
function mapShortScreenshots(list?: RawgShortScreenshot[] | null): Image[] {
  return (list ?? [])
    .filter((item) => item.id !== -1)
    .flatMap((item) => {
      const url = safeExternalUrl(item.image)
      return url ? [{ url, width: null, height: null }] : []
    })
    .slice(0, 4)
}

/** Full screenshots from `GET games/{slug}/screenshots`, width/height passed through when present. */
function mapScreenshots(list?: RawgScreenshot[] | null): Image[] {
  return (list ?? []).flatMap((item) => {
    const url = safeExternalUrl(item.image)
    return url ? [{ url, width: item.width ?? null, height: item.height ?? null }] : []
  })
}

function platformFamilies(raw: RawgGameListItem): GameCard['platformFamilies'] {
  const source = raw.parent_platforms ?? raw.platforms ?? []
  const slugs = source.map((entry) => entry.platform?.slug)
  return platformFamiliesFromSlugs(slugs)
}

export function mapGameCard(raw: RawgGameListItem): GameCard {
  return {
    id: String(raw.id ?? ''),
    slug: raw.slug ?? '',
    name: raw.name ?? '',
    released: raw.released ?? null,
    rating: positive(raw.rating),
    metacritic: positive(raw.metacritic),
    playtime: positive(raw.playtime),
    cover: mapCover(raw.background_image),
    screenshots: mapShortScreenshots(raw.short_screenshots),
    platformFamilies: platformFamilies(raw),
    platforms: mapTaxonomies((raw.platforms ?? []).map((entry) => entry.platform ?? {})),
    genres: mapTaxonomies(raw.genres),
    price: null,
    localisation: null,
    madeInUkraine: false,
  }
}

function mapStoreOffers(links: RawgStoreLink[]): StoreOffer[] {
  return links.flatMap((link) => {
    const store = storeSlugFromId(link.store_id)
    // A store link with an unsafe scheme is dropped rather than passed through: the offer only
    // exists to be clicked, so there is nothing left to render once the URL is refused.
    const url = safeExternalUrl(link.url)
    if (!store || !url) return []
    return [
      {
        store,
        url,
        priceUah: null,
        regularPriceUah: null,
        discountPercent: null,
        isFree: null,
        updatedAt: null,
      },
    ]
  })
}

export function mapGame(
  raw: RawgGameDetail,
  storeLinks: RawgStoreLink[],
  screenshots: RawgScreenshot[] = [],
): Game {
  // `price` exists on GameCard but not on Game; destructure it out so the
  // spread below doesn't carry a field the Game type doesn't declare.
  // `screenshots` (mapped from `short_screenshots` above) is also replaced: `Game.screenshots`
  // comes from the dedicated screenshots endpoint, not the max-4 card preview.
  const { price: _price, screenshots: _cardScreenshots, ...card } = mapGameCard(raw)
  const tags = mapTaxonomies(raw.tags)
  return {
    ...card,
    description: raw.description_raw?.trim() || null,
    ratingsCount: positive(raw.ratings_count),
    ageRating: esrbToAgeRating(raw.esrb_rating?.slug),
    gameModes: gameModesFromTags(tags.map((tag) => tag.slug)),
    screenshots: mapScreenshots(screenshots),
    tags,
    developers: mapTaxonomies(raw.developers),
    publishers: mapTaxonomies(raw.publishers),
    website: safeExternalUrl(raw.website),
    stores: mapStoreOffers(storeLinks),
    similar: [],
  }
}

/**
 * What the index contributed to a page. The defaults describe a page the RAWG path answered with
 * no index involved at all, which is what every caller that passes nothing gets.
 */
export type GamePageIndexState = Partial<
  Pick<GamePage, 'indexedOnly' | 'indexStale' | 'indexUpdatedAt' | 'ignoredFilters'>
>

export function mapGamePage(
  raw: Pick<RawgList<unknown>, 'count' | 'next'>,
  items: GameCard[],
  page: number,
  pageSize: number,
  index: GamePageIndexState = {},
): GamePage {
  return {
    items,
    total: raw.count ?? 0,
    page,
    pageSize,
    hasNext: Boolean(raw.next),
    indexedOnly: index.indexedOnly ?? false,
    indexStale: index.indexStale ?? false,
    indexUpdatedAt: index.indexUpdatedAt ?? null,
    ignoredFilters: index.ignoredFilters ?? [],
  }
}
