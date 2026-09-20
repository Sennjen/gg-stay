import type {
  AgeRatingValue,
  GameModeValue,
  GameSortValue,
  PlaytimeValue,
} from '../../shared/catalog'
import type { IndexRangeField, IndexedGame } from './document'
import { playtimeBucketOf } from './document'

/**
 * Every key name the index uses, in one place. The names are the contract between the reader,
 * the Upstash adapter and the refresh job; the in-memory adapter uses the same names so the two
 * stores stay comparable.
 *
 * A version owns everything under `idx:v{N}:`. The pointer to the live version, the permanent
 * Steam app ids and the job's resume cursors live outside it: they must survive a publication.
 *
 * Two families of sorted sets, and they are not interchangeable:
 *
 * - **order sets**, one per `GameSort` value (`o:PRICE_ASC`, …), scored by the game's final RANK
 *   in that order with the tie-break already applied by the writer. A plain ascending read after
 *   the intersection is therefore the finished page order, in either direction, and no two members
 *   ever tie — which matters because Redis breaks equal scores by member name, not by our rule.
 * - **range sets** (`r:price`, `r:discount`, `r:metacritic`, `r:rating`, `r:released`), scored by
 *   the true value, which is what a `ZRANGEBYSCORE` trim needs.
 *
 * There is no per-year facet: the year range is a trim on `r:released`, as the design says, so a
 * publication does not carry forty keys nothing reads.
 */

/** The pointer to the published version. */
export const CURRENT_VERSION_KEY = 'idx:current'

export function versionPrefix(version: number): string {
  return `idx:v${version}:`
}

export function gameKey(version: number, rawgId: number): string {
  return `${versionPrefix(version)}game:${rawgId}`
}

/** The folded names of the version, one entry per game: what `search` is matched against. */
export function namesKey(version: number): string {
  return `${versionPrefix(version)}names`
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

/** The sorted set of final ranks for one catalog sort. */
export function orderKey(version: number, sort: GameSortValue): string {
  return `${versionPrefix(version)}o:${sort}`
}

/** The sorted set of true values a range filter trims on. */
export function rangeKey(version: number, field: IndexRangeField): string {
  return `${versionPrefix(version)}r:${field}`
}

export function metaKey(version: number): string {
  return `${versionPrefix(version)}meta`
}

/** The game's Steam app id, resolved once and kept forever (empty string: the game has none). */
export function appIdKey(rawgId: number): string {
  return `appid:${rawgId}`
}

/** What Steam said about one app's languages, kept for the life of the index. */
export function languagesKey(appId: string): string {
  return `lang:${appId}`
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

  const bucket = playtimeBucketOf(game.playtime)
  if (bucket) keys.push(playtimeFacetKey(version, bucket))

  if (game.localisation?.text) keys.push(localisationFacetKey(version, 'text'))
  if (game.localisation?.audio) keys.push(localisationFacetKey(version, 'audio'))
  if (game.free) keys.push(freeFacetKey(version))
  if (game.madeInUkraine) keys.push(madeInUkraineFacetKey(version))

  return keys
}
