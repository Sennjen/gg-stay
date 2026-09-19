export const GAME_SORTS = [
  'POPULARITY_DESC',
  'RATING_DESC',
  'METACRITIC_DESC',
  'RELEASED_DESC',
  'RELEASED_ASC',
  'NAME_ASC',
  'PRICE_ASC',
  'PRICE_DESC',
  'DISCOUNT_DESC',
] as const
export type GameSortValue = (typeof GAME_SORTS)[number]

/** Sorts offered in the UI; price and discount sorts need the week 2 index. */
export const UI_SORTS = [
  'POPULARITY_DESC',
  'RATING_DESC',
  'METACRITIC_DESC',
  'RELEASED_DESC',
  'RELEASED_ASC',
  'NAME_ASC',
] as const satisfies readonly GameSortValue[]

export const PLAYTIMES = ['SHORT', 'MEDIUM', 'LONG'] as const
export type PlaytimeValue = (typeof PLAYTIMES)[number]

export const GAME_MODES = ['SINGLE', 'LOCAL_COOP', 'ONLINE_COOP', 'MULTIPLAYER'] as const
export type GameModeValue = (typeof GAME_MODES)[number]

export const AGE_RATINGS = ['PEGI3', 'PEGI7', 'PEGI12', 'PEGI16', 'PEGI18'] as const
export type AgeRatingValue = (typeof AGE_RATINGS)[number]

export const PLATFORM_FAMILIES = [
  'PC',
  'PLAYSTATION',
  'XBOX',
  'NINTENDO',
  'MOBILE',
  'OTHER',
] as const
export type PlatformFamilyValue = (typeof PLATFORM_FAMILIES)[number]

export const PLATFORM_OPTIONS = [
  { id: 4, name: 'PC' },
  { id: 187, name: 'PlayStation 5' },
  { id: 18, name: 'PlayStation 4' },
  { id: 186, name: 'Xbox Series S/X' },
  { id: 1, name: 'Xbox One' },
  { id: 7, name: 'Nintendo Switch' },
  { id: 3, name: 'iOS' },
  { id: 21, name: 'Android' },
] as const

export const STORE_OPTIONS = [
  { slug: 'steam', id: 1, name: 'Steam' },
  { slug: 'gog', id: 5, name: 'GOG' },
  { slug: 'epic-games', id: 11, name: 'Epic Games' },
  { slug: 'playstation-store', id: 3, name: 'PlayStation Store' },
  { slug: 'xbox-store', id: 2, name: 'Xbox Store' },
  { slug: 'nintendo', id: 6, name: 'Nintendo eShop' },
] as const

export const METACRITIC_STEPS = [70, 80, 90] as const
export const USER_RATING_MIN = 4
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 40
export const MAX_PAGE = 500

/**
 * Longest search term that reaches an upstream request — and therefore a cache key. RAWG matches
 * on titles, so anything past this is not a search any more; capping it keeps the attacker-facing
 * part of the key space finite rather than "one permanent entry per arbitrary string".
 */
export const MAX_SEARCH_LENGTH = 100
