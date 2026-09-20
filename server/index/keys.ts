import type {
  AgeRatingValue,
  GameModeValue,
  GameSortValue,
  PlaytimeValue,
} from '../../shared/catalog'
import type { IndexSortField, IndexedGame } from './document'
import { playtimeBucketOf, releaseYearOf } from './document'

/**
 * Every key name the index uses, in one place. The names are the contract between the reader,
 * the Upstash adapter and the refresh job; the in-memory adapter uses the same names so the two
 * stores stay comparable.
 *
 * A version owns everything under `idx:v{N}:`. The pointer to the live version, the permanent
 * Steam app ids and the job's resume cursors live outside it: they must survive a publication.
 */

/** The pointer to the published version. */
export const CURRENT_VERSION_KEY = 'idx:current'

export function versionPrefix(version: number): string {
  return `idx:v${version}:`
}

export function gameKey(version: number, rawgId: number): string {
  return `${versionPrefix(version)}game:${rawgId}`
}

export function genreFacetKey(version: number, genre: string): string {
  return `${versionPrefix(version)}f:genre:${genre}`
}

export function platformFacetKey(version: number, platformId: number): string {
  return `${versionPrefix(version)}f:platform:${platformId}`
}

export function storeFacetKey(version: number, store: string): string {
  return `${versionPrefix(version)}f:store:${store}`
}

export function gameModeFacetKey(version: number, mode: GameModeValue): string {
  return `${versionPrefix(version)}f:mode:${mode}`
}

export function ageRatingFacetKey(version: number, rating: AgeRatingValue): string {
  return `${versionPrefix(version)}f:age:${rating}`
}

export function yearFacetKey(version: number, year: number): string {
  return `${versionPrefix(version)}f:year:${year}`
}

export function playtimeFacetKey(version: number, bucket: PlaytimeValue): string {
  return `${versionPrefix(version)}f:playtime:${bucket}`
}

export function localisationFacetKey(version: number, level: 'text' | 'audio'): string {
  return `${versionPrefix(version)}f:loc:${level}`
}

export function freeFacetKey(version: number): string {
  return `${versionPrefix(version)}f:free`
}

export function madeInUkraineFacetKey(version: number): string {
  return `${versionPrefix(version)}f:ua`
}

/** Games whose price is known; the price filters and sorts start from this set. */
export function pricedFacetKey(version: number): string {
  return `${versionPrefix(version)}f:priced`
}

export function sortKey(version: number, field: IndexSortField): string {
  return `${versionPrefix(version)}s:${field}`
}

export function metaKey(version: number): string {
  return `${versionPrefix(version)}meta`
}

/** The game's Steam app id, resolved once and kept forever (empty string: the game has none). */
export function appIdKey(rawgId: number): string {
  return `appid:${rawgId}`
}

/** The resume point of one job stage. */
export function cursorKey(stage: string): string {
  return `job:cursor:${stage}`
}

/** Every facet set a game belongs to. The writer adds the game to exactly these keys. */
export function facetKeysOf(version: number, game: IndexedGame): string[] {
  const keys: string[] = [
    ...game.genres.map((genre) => genreFacetKey(version, genre)),
    ...game.platforms.map((platform) => platformFacetKey(version, platform)),
    ...game.stores.map((store) => storeFacetKey(version, store)),
    ...game.gameModes.map((mode) => gameModeFacetKey(version, mode)),
  ]
  if (game.ageRating) keys.push(ageRatingFacetKey(version, game.ageRating))

  const year = releaseYearOf(game)
  if (year !== null) keys.push(yearFacetKey(version, year))

  const bucket = playtimeBucketOf(game.playtime)
  if (bucket) keys.push(playtimeFacetKey(version, bucket))

  if (game.localisation?.text) keys.push(localisationFacetKey(version, 'text'))
  if (game.localisation?.audio) keys.push(localisationFacetKey(version, 'audio'))
  if (game.free) keys.push(freeFacetKey(version))
  if (game.madeInUkraine) keys.push(madeInUkraineFacetKey(version))
  if (game.priceUah !== null) keys.push(pricedFacetKey(version))

  return keys
}

const SORT_FIELDS: Record<GameSortValue, IndexSortField> = {
  POPULARITY_DESC: 'popularity',
  RATING_DESC: 'rating',
  METACRITIC_DESC: 'metacritic',
  RELEASED_DESC: 'released',
  RELEASED_ASC: 'released',
  NAME_ASC: 'name',
  PRICE_ASC: 'price',
  PRICE_DESC: 'price',
  DISCOUNT_DESC: 'discount',
}

/** The sorted set a catalog sort reads. */
export function sortFieldOf(sort: GameSortValue): IndexSortField {
  return SORT_FIELDS[sort]
}

/** Whether a catalog sort reads its sorted set from the high scores down. */
export function sortDescendingOf(sort: GameSortValue): boolean {
  return sort.endsWith('_DESC')
}
