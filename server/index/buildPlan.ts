import { GAME_SORTS, type GameSortValue } from '../../shared/catalog'
import type { IndexedGame } from './document'
import { INDEX_RANGE_FIELDS, daysSinceEpoch, foldName, rangeValueOf } from './document'
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

export function buildIndexPlan(version: number, games: readonly IndexedGame[]): IndexPlan {
  const docs = new Map(games.map((game) => [game.id, game]))
  const names = new Map(games.map((game) => [game.id, foldName(game.name)]))

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
      if (left.popularity !== right.popularity) return right.popularity - left.popularity
      return left.id - right.id
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

  return { docs, facets, orders, ranges, names }
}
