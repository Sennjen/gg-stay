import { GAME_SORTS, type GameSortValue } from '../../shared/catalog'
import type { IndexedGame } from './document'
import {
  INDEX_RANGE_FIELDS,
  daysSinceEpoch,
  foldName,
  isIndexableSlug,
  rangeValueOf,
} from './document'
import { facetKeysOf, orderKey, rangeKey } from './keys'

/**
 * Everything one published version consists of, derived from the games alone. Both adapters write
 * exactly this — the Upstash one with `MSET`/`SADD`/`ZADD`/`HSET`, the in-memory one into maps —
 * so the two stores cannot drift apart in what a publication contains.
 *
 * The ranks in `orders` already carry the contract's tie-break (popularity descending, then id
 * ascending), which is why every order set is read ascending whatever direction its sort names.
 */
export interface IndexPlan {
  /** The card documents, by id. */
  docs: Map<number, IndexedGame>
  /** Facet key → the ids in it. */
  facets: Map<string, number[]>
  /** Order key → `[id, rank]`, rank being a dense 0…n-1. */
  orders: Map<string, [number, number][]>
  /** Range key → `[id, value]`, the true value a trim compares against. */
  ranges: Map<string, [number, number][]>
  /** Id → folded name, the pairs written under `namesKey`. */
  names: Map<number, string>
  /**
   * Slug → id, the pairs written under `slugsKey`: how a game page that knows only its slug finds
   * its document. The slug is the document's own, spelled exactly as the document spells it — not
   * folded, not trimmed — because the reader matches it exactly too. A slug the reader would not
   * look up at all (`isIndexableSlug`) is not here: its game is in `docs` like any other and can
   * simply not be found by its slug.
   */
  slugs: Map<string, number>
}

/**
 * The games a sort ranks. Absence is how a game is kept out of an order: a game with no price is
 * not in the price and discount orders, and a game with no release date is not in the release
 * orders, so those sorts cannot list it at all.
 */
function membersOf(sort: GameSortValue, games: readonly IndexedGame[]): IndexedGame[] {
  if (sort === 'PRICE_ASC' || sort === 'PRICE_DESC' || sort === 'DISCOUNT_DESC') {
    return games.filter((game) => game.priceUah !== null)
  }
  if (sort === 'RELEASED_ASC' || sort === 'RELEASED_DESC') {
    return games.filter((game) => game.released !== null)
  }
  return [...games]
}

/** The value a sort orders by, before the tie-break. `NAME_ASC` is handled by the collator. */
function primaryOf(sort: GameSortValue, game: IndexedGame): number {
  switch (sort) {
    case 'POPULARITY_DESC':
      return game.popularity
    case 'RATING_DESC':
      return game.rating ?? 0
    case 'METACRITIC_DESC':
      return game.metacritic ?? 0
    case 'RELEASED_ASC':
    case 'RELEASED_DESC':
      return daysSinceEpoch(game.released!)
    case 'PRICE_ASC':
    case 'PRICE_DESC':
      return game.priceUah!
    case 'DISCOUNT_DESC':
      return game.discountPercent
    case 'NAME_ASC':
      return 0
  }
}

/**
 * The contract's tie-break, on its own: the more popular game first, then the lower id. Every
 * order ends on it, and it also decides which game keeps a slug two of them claim.
 */
function byPopularityThenId(left: IndexedGame, right: IndexedGame): number {
  if (left.popularity !== right.popularity) return right.popularity - left.popularity
  return left.id - right.id
}

/**
 * Which game each slug leads to. RAWG gives every game a slug of its own, so in practice this is
 * one entry per document — but a hash field holds a single id, and an index that quietly let the
 * last game listed win would answer differently for the same games in a different order. So the
 * rule is written down: a slug two games claim belongs to the more popular one, then to the lower
 * id. Built from the stored documents, so every slug here is the slug of a document of the version.
 *
 * A slug no lookup would be made for — empty, longer than `MAX_SLUG_LENGTH`, or not well-formed
 * text — is left out, by the same test the Upstash adapter applies before it asks its store. RAWG
 * writes no such slug; leaving one out keeps the table to what can be found in it, and keeps out
 * of the store a field its transport could not carry.
 */
function slugOwners(docs: ReadonlyMap<number, IndexedGame>): Map<string, number> {
  const slugs = new Map<string, number>()
  for (const game of [...docs.values()].sort(byPopularityThenId)) {
    if (isIndexableSlug(game.slug) && !slugs.has(game.slug)) slugs.set(game.slug, game.id)
  }
  return slugs
}

export function buildIndexPlan(version: number, games: readonly IndexedGame[]): IndexPlan {
  const docs = new Map(games.map((game) => [game.id, game]))
  const names = new Map(games.map((game) => [game.id, foldName(game.name)]))
  const slugs = slugOwners(docs)

  const facets = new Map<string, number[]>()
  for (const game of games) {
    for (const key of facetKeysOf(version, game)) {
      const ids = facets.get(key)
      if (ids) ids.push(game.id)
      else facets.set(key, [game.id])
    }
  }

  // One collator for the whole publication: `NAME_ASC` is a locale-aware order, and Redis can only
  // sort by score, so the order has to become a number here.
  const collator = new Intl.Collator('uk', { numeric: true, sensitivity: 'variant' })
  const orders = new Map<string, [number, number][]>()
  for (const sort of GAME_SORTS) {
    const descending = sort.endsWith('_DESC')
    const ordered = membersOf(sort, games).sort((left, right) => {
      if (sort === 'NAME_ASC') {
        const byName = collator.compare(left.name, right.name)
        if (byName !== 0) return byName
      } else {
        const leftValue = primaryOf(sort, left)
        const rightValue = primaryOf(sort, right)
        if (leftValue !== rightValue) {
          return descending ? rightValue - leftValue : leftValue - rightValue
        }
      }
      return byPopularityThenId(left, right)
    })
    orders.set(
      orderKey(version, sort),
      ordered.map((game, rank) => [game.id, rank]),
    )
  }

  const ranges = new Map<string, [number, number][]>()
  for (const field of INDEX_RANGE_FIELDS) {
    const entries: [number, number][] = []
    for (const game of games) {
      const value = rangeValueOf(game, field)
      if (value !== null) entries.push([game.id, value])
    }
    ranges.set(rangeKey(version, field), entries)
  }

  return { docs, facets, orders, ranges, names, slugs }
}
