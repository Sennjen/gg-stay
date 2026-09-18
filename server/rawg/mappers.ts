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
  RawgStoreLink,
  RawgTaxonomy,
} from './types'
import { esrbToAgeRating, gameModesFromTags, storeSlugFromId } from './lookups'

export function mapTaxonomy(raw: RawgTaxonomy): Taxonomy {
  return { id: String(raw.id ?? ''), slug: raw.slug ?? '', name: raw.name ?? '' }
}

function mapTaxonomies(list?: RawgTaxonomy[] | null): Taxonomy[] {
  return (list ?? []).filter((item) => item.slug).map(mapTaxonomy)
}

function mapCover(url?: string | null): Image | null {
  return url ? { url, width: null, height: null } : null
}

/** RAWG uses 0 for "unknown" on numeric fields. */
function positive(value?: number | null): number | null {
  return value && value > 0 ? value : null
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
    if (!store || !link.url) return []
    return [
      {
        store,
        url: link.url,
        priceUah: null,
        regularPriceUah: null,
        discountPercent: null,
        updatedAt: null,
      },
    ]
  })
}

export function mapGame(raw: RawgGameDetail, storeLinks: RawgStoreLink[]): Game {
  // `price` exists on GameCard but not on Game; destructure it out so the
  // spread below doesn't carry a field the Game type doesn't declare.
  const { price: _price, ...card } = mapGameCard(raw)
  const tags = mapTaxonomies(raw.tags)
  return {
    ...card,
    description: raw.description_raw?.trim() || null,
    ratingsCount: positive(raw.ratings_count),
    ageRating: esrbToAgeRating(raw.esrb_rating?.slug),
    gameModes: gameModesFromTags(tags.map((tag) => tag.slug)),
    screenshots: [],
    tags,
    developers: mapTaxonomies(raw.developers),
    publishers: mapTaxonomies(raw.publishers),
    website: raw.website || null,
    stores: mapStoreOffers(storeLinks),
    similar: [],
  }
}

export function mapGamePage(
  raw: Pick<RawgList<unknown>, 'count' | 'next'>,
  items: GameCard[],
  page: number,
  pageSize: number,
): GamePage {
  return {
    items,
    total: raw.count ?? 0,
    page,
    pageSize,
    hasNext: Boolean(raw.next),
    indexedOnly: false,
  }
}
