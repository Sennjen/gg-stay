import {
  AGE_RATINGS,
  GAME_MODES,
  LOCALISATIONS,
  PLATFORM_FAMILIES,
  PLAYTIMES,
  UI_SORTS,
  MAX_PRICE_UAH,
  MAX_SEARCH_LENGTH,
  METACRITIC_STEPS,
  PLATFORM_OPTIONS,
  USER_RATING_MIN,
  type GameSortValue,
  type PlatformFamilyValue,
} from '../../shared/catalog'
import {
  DEFAULT_SORT,
  parseFilterQuery,
  serializeFilterState,
  type CatalogFilter,
} from '../../shared/filterUrl'
import { isMoodTag, type MoodTag } from '../../shared/moodTags'
import { platformFamiliesFromIds } from '../rawg/lookups'
import type { AskLocale, AskParse } from './schemas'

/**
 * A parse answer made safe to run, and the catalog link of what it understood.
 *
 * Nothing a model says reaches a resolver as it was said. Every genre is checked against the live
 * taxonomy, every number is clamped or snapped to a value the catalog's own controls can set, and
 * the result is then put through the catalog URL layer (`serializeFilterState` and back through
 * `parseFilterQuery`), so the filter the answer reports is exactly the one `/games` would parse
 * from `catalogUrl` — the chips the page renders and the catalog the link opens cannot disagree.
 */

/** Longest `similarTo` title kept; the same cap as a catalog search term. */
const MAX_TITLE_LENGTH = MAX_SEARCH_LENGTH
/** Longest interpretation line kept: one sentence. */
export const MAX_INTERPRETATION_LENGTH = 200
/** At most this many mood tags; the prompt asks for the most defining ones first. */
export const MAX_TAGS = 3
/** At most this many genres: a query naming more is describing, not filtering. */
const MAX_GENRES = 5
/** The rating threshold the catalog offers is "4 and up"; anything from 3.5 rounds to it. */
const RATING_ROUNDS_UP_FROM = 3.5
const MIN_YEAR = 1970
const MAX_YEAR = 2100

export interface UnderstoodQuery {
  filter: CatalogFilter
  sort: GameSortValue
  /** A game title for a "like X" query, to be resolved against the index. */
  similarTo: string | null
  /**
   * Mood and sub-genre tags (`shared/moodTags.ts`), most defining first. The catalog has no tag
   * filter, so they shape the candidates but never the filter or its link.
   */
  tags: MoodTag[]
  /** One sentence in the query's language, or `null` when the model gave none. */
  interpretation: string | null
}

export interface Taxonomy {
  /** The genre slugs the catalog knows right now; empty when they could not be read. */
  genres: readonly string[]
}

/** The platform ids the catalog's drawer offers for these families, in the drawer's order. */
function platformIdsOf(families: readonly PlatformFamilyValue[]): number[] {
  const wanted = new Set(families)
  return PLATFORM_OPTIONS.filter((option) =>
    platformFamiliesFromIds([option.id]).some((family) => wanted.has(family)),
  ).map((option) => option.id)
}

function oneLine(value: string | null, max: number): string | null {
  const text = value?.replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return text ? text : null
}

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S*/gi

/**
 * Free text from the model — the interpretation and the reasons — as one plain line: whitespace
 * collapsed, cut to `max`, and without anything that looks like a link. The text is shown on
 * shareable pages and cached, and a query can steer it; a link is the one thing in it that could
 * send a visitor somewhere.
 */
export function modelLine(value: string | null, max: number): string | null {
  return oneLine(value?.replace(URL_LIKE, ' ') ?? null, max)
}

/** Every code the parse schema knows: none of them belongs in a sentence a visitor reads. */
const ENUM_CODES: ReadonlySet<string> = new Set([
  ...GAME_MODES,
  ...AGE_RATINGS,
  ...PLAYTIMES,
  ...LOCALISATIONS,
  ...PLATFORM_FAMILIES,
  ...UI_SORTS,
])
/** Anything spelled like a code: capitals joined by underscores. */
const SNAKE_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
/** A sum of money, in either order: "25 грн", "499 ₴", "UAH 300", "₴99". */
const PRICE = /\d[\d\s.,]*\s*(?:₴|грн|гривн|гривен|гривень|uah|hryvni|hryvnia)|(?:₴|uah)\s*\d/i
/** Platform and store names; the filter has already guaranteed the platform. */
const PLATFORM_NAME = /\b(?:Nintendo|Switch|PlayStation|PS[3-5]|Xbox|Steam|iOS|Android)\b/

/**
 * A reason worth showing, or `null`. A reason that only echoes the request — a price, a platform,
 * a code from the parse schema — tells the visitor nothing they did not type; the prompt forbids
 * it, and this is what holds when the model does it anyway.
 */
export function plainReason(reason: string | null): string | null {
  if (!reason) return null
  const tokens = reason.split(/[^A-Za-z0-9_]+/)
  if (tokens.some((token) => ENUM_CODES.has(token))) return null
  if (SNAKE_CODE.test(reason) || PRICE.test(reason) || PLATFORM_NAME.test(reason)) return null
  return reason
}

function whole(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value)
}

function year(value: number | null): number | undefined {
  const rounded = whole(value)
  return rounded !== null && rounded >= MIN_YEAR && rounded <= MAX_YEAR ? rounded : undefined
}

function metacriticStep(value: number | null): number | undefined {
  const rounded = whole(value)
  if (rounded === null) return undefined
  const capped = Math.min(rounded, 100)
  return [...METACRITIC_STEPS].reverse().find((step) => step <= capped)
}

function ratingMin(value: number | null): number | undefined {
  if (value === null || value < RATING_ROUNDS_UP_FROM || value > 5) return undefined
  return USER_RATING_MIN
}

function priceCeiling(value: number | null): number | undefined {
  const rounded = whole(value)
  if (rounded === null || rounded < 1) return undefined
  return Math.min(rounded, MAX_PRICE_UAH)
}

function discountFloor(value: number | null): number | undefined {
  const rounded = whole(value)
  if (rounded === null || rounded < 1) return undefined
  return Math.min(rounded, 99)
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined
}

export function sanitiseParse(parse: AskParse, taxonomy: Taxonomy): UnderstoodQuery {
  const knownGenres = new Set(taxonomy.genres)
  const genres = [...new Set(parse.genres.map((slug) => slug.trim().toLowerCase()))].filter(
    (slug) => knownGenres.has(slug),
  )

  const platforms = platformIdsOf(parse.platforms)

  let yearFrom = year(parse.yearFrom)
  let yearTo = year(parse.yearTo)
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    ;[yearFrom, yearTo] = [yearTo, yearFrom]
  }

  const free = parse.free === true ? true : undefined
  const similarTo = oneLine(parse.similarTo, MAX_TITLE_LENGTH)
  let search = oneLine(parse.searchText, MAX_SEARCH_LENGTH)
  // A "like Hades" query is not a search for Hades: the game is resolved on its own, and searching
  // for its title as well would leave nothing but the game itself.
  if (search && similarTo && search.toLowerCase() === similarTo.toLowerCase()) search = null

  const candidate: CatalogFilter = {
    search: search ?? undefined,
    genres: nonEmpty(genres.slice(0, MAX_GENRES)),
    platforms: nonEmpty(platforms),
    yearFrom,
    yearTo,
    metacriticMin: metacriticStep(parse.metacriticMin),
    ratingMin: ratingMin(parse.ratingMin),
    playtime: parse.playtime ?? undefined,
    gameModes: nonEmpty([...new Set(parse.gameModes)]),
    ageRating: nonEmpty([...new Set(parse.ageRating)]),
    // The drawer makes "free" and a price ceiling exclusive; free is the narrower of the two.
    priceMaxUah: free ? undefined : priceCeiling(parse.priceMaxUah),
    free,
    onSaleMinPercent: discountFloor(parse.onSaleMinPercent),
    ukrainianLocalisation: parse.ukrainianLocalisation ?? undefined,
    madeInUkraine: parse.madeInUkraine === true ? true : undefined,
  }

  // Through the URL layer and back: whatever the catalog would not accept from a link is dropped
  // here too, and the field order is the one the catalog itself produces.
  const canonical = parseFilterQuery(
    serializeFilterState({ filter: candidate, sort: parse.sort ?? DEFAULT_SORT, page: 1 }),
  )

  return {
    filter: canonical.filter,
    sort: canonical.sort,
    similarTo,
    tags: [...new Set(parse.tags)].filter(isMoodTag).slice(0, MAX_TAGS),
    interpretation: modelLine(parse.interpretation, MAX_INTERPRETATION_LENGTH),
  }
}

/**
 * The `/games` link of a filter, in the visitor's locale (`/games` for Ukrainian, `/en/games` for
 * English, as the i18n strategy prefixes every locale but the default). Commas stay readable, as
 * they do in the links the catalog itself writes.
 */
export function catalogUrl(filter: CatalogFilter, sort: GameSortValue, locale: AskLocale): string {
  const query = new URLSearchParams(serializeFilterState({ filter, sort, page: 1 }))
    .toString()
    .replaceAll('%2C', ',')
  const path = locale === 'en' ? '/en/games' : '/games'
  return query ? `${path}?${query}` : path
}
