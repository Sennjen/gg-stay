import { MAX_PAGE_SIZE } from '../../../shared/catalog'
import {
  cachedIndexPage,
  INDEX_STALE_AFTER_MS,
  indexFailed,
  indexState,
  oncePerRequest,
  toIndexQuery,
  warnIndexOnce,
} from '../indexPath'
import type { GraphQLContext } from '../context'
import type { GameCard, QueryResolvers } from '../__generated__/resolvers-types'

/** The smallest discount that counts as a deal worth greeting a visitor with. */
export const DEAL_MIN_DISCOUNT_PERCENT = 50

/** A deal is only offered on a game critics liked: the same floor as the "good" Metacritic band. */
export const DEAL_MIN_METACRITIC = 75

/** How many of the biggest discounts the day's game is picked from. */
export const DEAL_POOL_SIZE = 20

const DAY_MS = 86_400_000

/** Whole days since the epoch for a `YYYY-MM-DD` UTC date: tomorrow's number is today's plus one. */
function dayNumber(today: string): number {
  return Math.floor(Date.parse(`${today}T00:00:00.000Z`) / DAY_MS)
}

/**
 * The one game the mascot offers today, from the index alone: among the well-reviewed games at
 * half price or better, the twenty biggest discounts, and of those the one the UTC date points at.
 * The date is `context.today`, so every visitor sees the same game all day, the next day moves to
 * the next game in the list, and no clock is read here.
 *
 * "The same game all day" holds for one published list. A publication during the day can reorder
 * or resize it, and the date then points at another game; a list that changes length between two
 * days can repeat or skip one. Copy around the deal should promise "today", not more.
 *
 * It costs what a landing shelf costs — the request's shared metadata read and one page through
 * the page cache — and it is an extra, never a requirement: no index, stale prices, a failed read
 * or an empty list all answer `null`, and nothing here throws.
 *
 * The answer is worked out once per request. The field is not behind the alias limit that guards
 * the RAWG-backed root fields, so a document that repeats it under a dozen aliases must still cost
 * one page read, not a dozen.
 */
export const dealOfTheDay: QueryResolvers['dealOfTheDay'] = (_parent, _args, context) =>
  oncePerRequest(context, 'dealOfTheDay', () => pickDeal(context))

/**
 * Whether a card may be announced as a deal. The index only applies the discount and the score;
 * the rest is decided here, on what the card already carries.
 *
 * - It costs money: `free: false` is not a filter the index applies, and a paid game given away
 *   at −100 % is not a deal to state a price for either.
 * - Its own price is fresh. An index whose prices are fresh as a whole still holds games whose
 *   price was carried forward, old timestamp and all, because the store stopped answering for
 *   them — a sale that ended weeks ago would otherwise top the list for ever. The window is the
 *   one the index itself is held to.
 */
function isDeal(card: GameCard, now: number): boolean {
  const price = card.price
  if (!price || price.isFree || price.bestUah <= 0) return false
  const age = now - Date.parse(price.updatedAt)
  return Number.isFinite(age) && age <= INDEX_STALE_AFTER_MS
}

async function pickDeal(context: GraphQLContext): Promise<GameCard | null> {
  const day = dayNumber(context.today)
  if (!Number.isFinite(day)) return null

  const state = await indexState(context)
  // A deal is a price claim, so stale prices mean no deal at all rather than one without a price.
  if (state.meta === null || state.stale || indexFailed(context)) return null

  // The largest page the index serves, not just the pool: the cards that fail `isDeal` are dropped
  // after the read, and the pool is the first twenty that are left. Still one page, one read.
  const query = toIndexQuery({
    filter: { onSaleMinPercent: DEAL_MIN_DISCOUNT_PERCENT, metacriticMin: DEAL_MIN_METACRITIC },
    sort: 'DISCOUNT_DESC',
    page: 1,
    pageSize: MAX_PAGE_SIZE,
    today: context.today,
  })
  let pool: GameCard[]
  try {
    const page = await cachedIndexPage(context, query, state.version)
    const now = Date.parse(context.now)
    pool = page.items.filter((card) => isDeal(card, now)).slice(0, DEAL_POOL_SIZE)
  } catch (error) {
    warnIndexOnce(context, 'the deal of the day could not be read', error)
    return null
  }
  if (pool.length === 0) return null
  return pool[day % pool.length] ?? null
}
