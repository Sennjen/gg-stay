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

/**
 * The values a query trims on, one sorted set each. Every score is a safe integer far below 2^53,
 * because a Redis score is a double and a wider score would round on the way in: prices and
 * discounts are whole numbers already, ratings are stored in hundredths and release dates in days
 * since the epoch rather than milliseconds.
 */
export const INDEX_RANGE_FIELDS = ['price', 'discount', 'metacritic', 'rating', 'released'] as const
export type IndexRangeField = (typeof INDEX_RANGE_FIELDS)[number]

/** Whole days since the epoch, the finest granularity an ISO date carries. */
export function daysSinceEpoch(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86_400_000)
}

/** The day after `isoDate`, as days since the epoch. */
export function dayAfter(isoDate: string): number {
  return daysSinceEpoch(isoDate) + 1
}

/** The first day of a year, as days since the epoch. Years are padded, so year 20 is not 1920. */
export function firstDayOfYear(year: number): number {
  return daysSinceEpoch(`${String(year).padStart(4, '0')}-01-01`)
}

/** The last day of a year (31 December), as days since the epoch. */
export function lastDayOfYear(year: number): number {
  return daysSinceEpoch(`${String(year).padStart(4, '0')}-12-31`)
}

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

/**
 * The value a game contributes to one range set, or `null` when it does not belong to it: a game
 * without a price is absent from the price and discount ranges, and a game without a release date
 * from the release range, so neither can be matched by a filter over a value it does not have.
 * Games without a rating or a Metacritic score stay in those ranges at zero — the catalog shows
 * them, and a minimum above zero excludes them anyway.
 */
export function rangeValueOf(game: IndexedGame, field: IndexRangeField): number | null {
  switch (field) {
    case 'price':
      return game.priceUah
    case 'discount':
      return game.priceUah === null ? null : game.discountPercent
    case 'metacritic':
      return game.metacritic ?? 0
    case 'rating':
      return Math.round((game.rating ?? 0) * 100)
    case 'released':
      return game.released ? daysSinceEpoch(game.released) : null
  }
}

/**
 * The name as the search matches it. Folded once by the writer, into the index's names key, and
 * once per query by the planner, so both sides fold the same way.
 */
export function foldName(name: string): string {
  return name.trim().toLocaleLowerCase('uk')
}
