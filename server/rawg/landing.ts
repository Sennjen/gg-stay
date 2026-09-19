import type { RawgGameListItem } from './types'

const MIN_RATINGS_COUNT = 100

/** `YYYY-MM-DD,YYYY-MM-DD` window ending on `today`, `daysBack` days wide — the shape RAWG's `dates` filter expects. */
export function dateRange(today: string, daysBack: number): string {
  const end = new Date(`${today}T00:00:00Z`)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - daysBack)
  const format = (date: Date) => date.toISOString().slice(0, 10)
  return `${format(start)},${format(end)}`
}

function qualifies(item: RawgGameListItem): boolean {
  return (item.ratings_count ?? 0) >= MIN_RATINGS_COUNT
}

/**
 * Highest-rated item with at least 100 ratings and a cover, tie-broken by more ratings.
 * Returns null when nothing in `items` qualifies — the caller falls back to the carousel.
 */
export function pickFeatured(items: readonly RawgGameListItem[]): RawgGameListItem | null {
  const candidates = items.filter((item) => qualifies(item) && item.background_image)
  return candidates.reduce<RawgGameListItem | null>((best, item) => {
    if (!best) return item
    const itemRating = item.rating ?? 0
    const bestRating = best.rating ?? 0
    if (itemRating > bestRating) return item
    if (itemRating === bestRating && (item.ratings_count ?? 0) > (best.ratings_count ?? 0)) {
      return item
    }
    return best
  }, null)
}

/** Items with at least 100 ratings, sorted by rating descending, capped to `limit`. */
export function pickTopRated(
  items: readonly RawgGameListItem[],
  limit: number,
): RawgGameListItem[] {
  return items
    .filter(qualifies)
    .slice()
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, limit)
}
