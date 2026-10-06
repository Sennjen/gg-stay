import { cachedIndexPage, indexFailed, indexState, toIndexQuery, warnIndexOnce } from '../indexPath'
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
 * It costs what a landing shelf costs — the request's shared metadata read and one page through
 * the page cache — and it is an extra, never a requirement: no index, stale prices, a failed read
 * or an empty list all answer `null`, and nothing here throws.
 *
 * The answer is worked out once per request. The field is not behind the alias limit that guards
 * the RAWG-backed root fields, so a document that repeats it under a dozen aliases must still cost
 * one page read, not a dozen.
 */
export const dealOfTheDay: QueryResolvers['dealOfTheDay'] = (_parent, _args, context) => {
  let deal = deals.get(context)
  if (!deal) {
    deal = pickDeal(context)
    deals.set(context, deal)
  }
  return deal
}

// Keyed by the context object, which yoga builds once per request.
const deals = new WeakMap<GraphQLContext, Promise<GameCard | null>>()

async function pickDeal(context: GraphQLContext): Promise<GameCard | null> {
  const state = await indexState(context)
  // A deal is a price claim, so stale prices mean no deal at all rather than one without a price.
  if (state.meta === null || state.stale || indexFailed(context)) return null

  const query = toIndexQuery({
    filter: { onSaleMinPercent: DEAL_MIN_DISCOUNT_PERCENT, metacriticMin: DEAL_MIN_METACRITIC },
    sort: 'DISCOUNT_DESC',
    page: 1,
    pageSize: DEAL_POOL_SIZE,
    today: context.today,
  })
  let candidates: GameCard[]
  try {
    const page = await cachedIndexPage(context, query, state.version)
    // `free: false` is not a filter the index applies, so free games are dropped here.
    candidates = page.items.filter((card) => card.price != null && !card.price.isFree)
  } catch (error) {
    warnIndexOnce(context, 'the deal of the day could not be read', error)
    return null
  }
  if (candidates.length === 0) return null

  const day = dayNumber(context.today)
  if (!Number.isFinite(day)) return null
  return candidates[day % candidates.length] ?? null
}
