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

/**
 * Sorts offered in the UI. The last three are answered by the price index alone: choosing one
 * sends the whole request down the index path, and the catalog hides them while the index reports
 * its prices as stale (`INDEX_SORTS`).
 */
export const UI_SORTS = [
  'POPULARITY_DESC',
  'RATING_DESC',
  'METACRITIC_DESC',
  'RELEASED_DESC',
  'RELEASED_ASC',
  'NAME_ASC',
  'PRICE_ASC',
  'PRICE_DESC',
  'DISCOUNT_DESC',
] as const satisfies readonly GameSortValue[]

/** The sorts only the price index can answer; hidden while its prices are stale. */
export const INDEX_SORTS = ['PRICE_ASC', 'PRICE_DESC', 'DISCOUNT_DESC'] as const

/** The sorts that survive a stale index, in the order the select lists them. */
export const NON_INDEX_SORTS = UI_SORTS.filter(
  (sort): sort is Exclude<GameSortValue, (typeof INDEX_SORTS)[number]> =>
    !(INDEX_SORTS as readonly GameSortValue[]).includes(sort),
)

export const PLAYTIMES = ['SHORT', 'MEDIUM', 'LONG'] as const
export type PlaytimeValue = (typeof PLAYTIMES)[number]

export const GAME_MODES = ['SINGLE', 'LOCAL_COOP', 'ONLINE_COOP', 'MULTIPLAYER'] as const
export type GameModeValue = (typeof GAME_MODES)[number]

export const AGE_RATINGS = ['PEGI3', 'PEGI7', 'PEGI12', 'PEGI16', 'PEGI18'] as const
export type AgeRatingValue = (typeof AGE_RATINGS)[number]

/**
 * Ukrainian localisation levels. Steam reports "supported" and "full audio" per language and
 * nothing finer, so the catalog knows text and audio — an interface or subtitles level cannot be
 * told apart without scraping store pages.
 */
export const LOCALISATIONS = ['ANY', 'TEXT', 'AUDIO'] as const
export type LocalisationValue = (typeof LOCALISATIONS)[number]

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

/** The ready-made "up to N ₴" steps the price section offers beside the free chip. */
export const PRICE_STEPS = [300, 600, 1000] as const

/**
 * Ceiling for a hand-typed price. Well past the most expensive collector's edition Steam sells in
 * hryvnia, and finite, so the filter cannot become an unbounded cache key.
 */
export const MAX_PRICE_UAH = 100_000

/** The discount steps the "Знижка" section offers; the URL accepts any whole percent 1–99. */
export const DISCOUNT_STEPS = [25, 50, 75] as const

/**
 * How many games the price index covers, as the catalog note tells a visitor. A round figure the
 * job's candidate stage targets, not a live count — the note says what the search covers, and a
 * number that moved with every run would be noise.
 */
export const INDEX_GAME_COUNT = 3000
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
