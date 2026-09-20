import type { AgeRatingValue, GameModeValue, PlaytimeValue } from '../../shared/catalog'

/**
 * The card document the index stores per game, and the run metadata published beside it. Reader
 * and writer share these shapes, so both adapters and the refresh job agree on what a game in the
 * index looks like without importing each other.
 */

export interface IndexedLocalisation {
  /** The game's interface or subtitles are available in Ukrainian. */
  text: boolean
  /** The game is voiced in Ukrainian. */
  audio: boolean
  /** Where the flags came from, e.g. `steam`. */
  source: string
}

export interface IndexedGame {
  id: number
  slug: string
  name: string
  cover: string | null
  /** ISO date (`YYYY-MM-DD`); `null` when the release date is unknown. */
  released: string | null
  /** RAWG's "added" count — the popularity score and the tie-break of every sort. */
  popularity: number
  platforms: number[]
  genres: string[]
  stores: string[]
  gameModes: GameModeValue[]
  ageRating: AgeRatingValue | null
  rating: number | null
  ratingsCount: number
  metacritic: number | null
  /** Average playtime in hours. */
  playtime: number | null
  /** Current price in whole hryvnia; `null` when no price is known. */
  priceUah: number | null
  regularPriceUah: number | null
  discountPercent: number
  free: boolean
  localisation: IndexedLocalisation | null
  madeInUkraine: boolean
  /** ISO timestamp of the last successful price read. */
  priceUpdatedAt: string | null
}

export interface IndexRunStats {
  gamesIndexed: number
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
}

export interface IndexMeta {
  version: number
  /** ISO timestamp of the publication; the staleness check reads this. */
  updatedAt: string
  pricesUpdatedAt: string | null
  gameCount: number
  stats?: Partial<IndexRunStats>
}

/** The sorted sets a version keeps, one per sort order and range. */
export const INDEX_SORT_FIELDS = [
  'popularity',
  'rating',
  'metacritic',
  'released',
  'name',
  'price',
  'discount',
] as const
export type IndexSortField = (typeof INDEX_SORT_FIELDS)[number]

/**
 * The playtime bucket a game belongs to, matching the catalog's own buckets
 * (`server/rawg/lookups.ts`). Games with an unknown playtime belong to none.
 */
export function playtimeBucketOf(hours: number | null | undefined): PlaytimeValue | null {
  if (!hours || hours <= 0) return null
  if (hours < 10) return 'SHORT'
  if (hours <= 40) return 'MEDIUM'
  return 'LONG'
}

/** The release year of a game, or `null` when it has no release date. */
export function releaseYearOf(game: Pick<IndexedGame, 'released'>): number | null {
  const year = Number(game.released?.slice(0, 4))
  return Number.isInteger(year) ? year : null
}

/** The `s:released` score: the release date as a UTC timestamp. */
export function releasedScore(released: string): number {
  return Date.parse(`${released.slice(0, 10)}T00:00:00Z`)
}

/**
 * The score of a game in one sorted set, or `null` when the game does not belong to it: a game
 * without a price is absent from `s:price` and `s:discount` so the price sorts never list it, and
 * a game without a release date is absent from `s:released` for the same reason. `s:name` is
 * scored by rank, which only the whole set can decide — see `nameRanks`.
 */
export function sortScoreOf(game: IndexedGame, field: IndexSortField): number | null {
  switch (field) {
    case 'popularity':
      return game.popularity
    case 'rating':
      return game.rating ?? 0
    case 'metacritic':
      return game.metacritic ?? 0
    case 'released':
      return game.released ? releasedScore(game.released) : null
    case 'price':
      return game.priceUah ?? null
    case 'discount':
      return game.priceUah === null ? null : game.discountPercent
    case 'name':
      return null
  }
}

/**
 * Locale-aware ranks of the names in one version, which become the `s:name` scores. The job
 * computes them once per publication because Redis sorts by score, not by string.
 */
export function nameRanks(games: readonly IndexedGame[]): Map<number, number> {
  const collator = new Intl.Collator('uk', { numeric: true, sensitivity: 'variant' })
  const ordered = [...games].sort(
    (left, right) => collator.compare(left.name, right.name) || left.id - right.id,
  )
  return new Map(ordered.map((game, rank) => [game.id, rank]))
}
