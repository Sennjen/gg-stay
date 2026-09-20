import type { AppIdMap } from './appIds'
import { isoNow, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'

/**
 * Stage 3: hryvnia prices. `appdetails?filters=price_overview` takes a hundred app ids per
 * request, so 3 000 games cost about thirty requests, not 3 000 — the batching is the transport's
 * (`server/steam/steamPriceFetch.ts`), and this stage hands it the whole list at once.
 *
 * Three answers come back and each means something different:
 *
 * - a price — attached, with the moment it was read;
 * - nothing, for a game that was priced before and is free — kept free. The batched call cannot
 *   tell a free game from one Steam will not sell in Ukraine (both arrive as `data: []`), and
 *   losing the free flag on every price run would be a worse lie than keeping it; the language
 *   stage is what confirms it from `is_free`;
 * - nothing, for anything else — the price is cleared rather than left to age. The design is
 *   explicit that a stale price is worse than none, and a game with no price simply shows none.
 *
 * Games with no Steam app id are never touched: they have no price to find here.
 */

export interface PricesResult {
  /** App ids sent to Steam. */
  requested: number
  /** Games that came out of this stage with a price (free counts as priced). */
  priced: number
}

export async function refreshPrices(
  deps: JobDeps,
  games: IndexedGame[],
  appIds: AppIdMap,
): Promise<PricesResult> {
  const withPage = games.flatMap((game) => {
    const appId = appIds.get(game.id)
    return appId ? [{ game, appId }] : []
  })
  const requested = new Set(withPage.map((entry) => entry.appId))

  if (requested.size === 0) {
    deps.log('prices: no Steam app ids to price')
    return { requested: 0, priced: 0 }
  }

  const prices = await deps.steam.fetchPrices([...requested])
  const readAt = isoNow(deps.clock)

  for (const { game, appId } of withPage) {
    const price = prices.get(appId) ?? null
    if (price) {
      game.priceUah = price.priceUah
      game.regularPriceUah = price.regularPriceUah
      game.discountPercent = price.discountPercent
      game.free = price.isFree
      game.priceUpdatedAt = readAt
      continue
    }
    if (game.free) {
      game.priceUah = 0
      game.regularPriceUah = 0
      game.discountPercent = 0
      game.priceUpdatedAt = readAt
      continue
    }
    game.priceUah = null
    game.regularPriceUah = null
    game.discountPercent = 0
    game.priceUpdatedAt = null
  }

  const priced = games.filter((game) => game.priceUah !== null).length
  deps.log(`prices: ${priced} of ${requested.size} Steam pages priced`)
  return { requested: requested.size, priced }
}
