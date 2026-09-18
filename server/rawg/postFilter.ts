import type { GameFilter } from '../graphql/__generated__/resolvers-types'
import type { RawgGameListItem } from './types'
import { esrbSlugsForAgeRatings, matchesPlaytime } from './lookups'

/** Applies the filters RAWG has no query parameter for. Operates on one fetched page. */
export function postFilter(
  items: RawgGameListItem[],
  filter?: GameFilter | null,
): RawgGameListItem[] {
  if (!filter) return items
  const { ratingMin, playtime, ageRating } = filter
  const esrbSlugs = ageRating?.length ? new Set(esrbSlugsForAgeRatings(ageRating)) : null

  return items.filter((item) => {
    if (ratingMin && (item.rating ?? 0) < ratingMin) return false
    if (playtime && !matchesPlaytime(item.playtime, playtime)) return false
    if (esrbSlugs && !esrbSlugs.has(item.esrb_rating?.slug ?? '')) return false
    return true
  })
}
