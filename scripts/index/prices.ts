import type { AppIdMap } from './appIds'
import { assertWithinFailureBudget, isoNow, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import type { SteamPrice } from '../../server/steam/price'

/**
 * Stage 3: hryvnia prices. `appdetails?filters=price_overview` takes a hundred app ids per
 * request, so 3 000 games cost about thirty requests, not 3 000.
 *
 * The job chunks the list itself rather than handing the whole thing to the transport, because a
 * chunk is the unit of failure: the transport would fail all thirty on one, and thirty chunks
 * answered by twenty-nine is a far better run than no run at all. A chunk that fails leaves its
 * games exactly as they were.
 *
 * Nothing here ever drops a price silently. Steam under load answers HTTP 200 with
 * `{"<appid>":{"success":false}}`, which arrives as an unparseable entry and is indistinguishable
 * from "not sold in Ukraine", so a game that had a price and gets no price back keeps the price
 * and the timestamp it had: a run that quietly emptied 40 % of the catalog's price lines would
 * pass every gate and tell nobody. What changes is the count of definitive answers, which decides
 * whether `meta.pricesUpdatedAt` may move at all (`PRICES_ANSWERED_RATIO`) and, through the
 * publication gate, whether the run may be published.
 *
 * A game already known to be free keeps its zero price when the batched call says nothing: the
 * batched call cannot see `is_free`, and the language stage is what confirms it.
 */

/** Steam's documented ceiling for `appids` on one `appdetails` call. */
export const PRICE_CHUNK_SIZE = 100

/** Below this share of answered ids, the run's prices are not fresh enough to claim they are. */
export const PRICES_ANSWERED_RATIO = 0.9

export interface PricesResult {
  /** App ids sent to Steam. */
  requested: number
  /**
   * App ids this run has a definitive answer for: a price came back, or none did and the game had
   * none to lose. An id whose chunk failed, and an id that stopped being priced without saying so,
   * are both unanswered — those are the two shapes of a Steam outage.
   */
  answered: number
  /** App ids in chunks that failed outright. */
  failures: number
  /** Games that came out of this stage with a price (free counts as priced). */
  priced: number
  /** Games that kept the price they already had because this run could not confirm one. */
  kept: number
  /** Whether the run may claim its prices are fresh. */
  fresh: boolean
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export interface PricesOptions {
  /** App ids per request; the default is Steam's own ceiling. */
  chunkSize?: number
}

export async function refreshPrices(
  deps: JobDeps,
  games: IndexedGame[],
  appIds: AppIdMap,
  options: PricesOptions = {},
): Promise<PricesResult> {
  const withPage = games.flatMap((game) => {
    const appId = appIds.get(game.id)
    return appId ? [{ game, appId }] : []
  })
  const requested = [...new Set(withPage.map((entry) => entry.appId))]

  if (requested.length === 0) {
    deps.log('prices: no Steam app ids to price')
    return { requested: 0, answered: 0, failures: 0, priced: 0, kept: 0, fresh: false }
  }

  const prices = new Map<string, SteamPrice | null>()
  const answered = new Set<string>()
  let failures = 0

  for (const ids of chunk(requested, options.chunkSize ?? PRICE_CHUNK_SIZE)) {
    try {
      for (const [appId, price] of await deps.steam.fetchPrices(ids)) {
        prices.set(appId, price)
        answered.add(appId)
      }
    } catch {
      failures += ids.length
      deps.log(`prices: a chunk of ${ids.length} app ids failed, keeping their current prices`)
    }
  }
  assertWithinFailureBudget('prices', failures, requested.length)

  const readAt = isoNow(deps.clock)
  const unresolved = new Set<string>()
  let kept = 0

  for (const { game, appId } of withPage) {
    if (!answered.has(appId)) {
      // The chunk never came back. Nothing is known, so nothing changes.
      unresolved.add(appId)
      if (game.priceUah !== null) kept += 1
      continue
    }
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
    if (game.priceUah !== null) {
      // Free, not sold here, or a soft failure — indistinguishable. Keep what we had, timestamp
      // and all, so a Steam wobble cannot empty the catalog's price lines, and do not count it as
      // an answer: enough of these and the run may not claim its prices are fresh.
      unresolved.add(appId)
      kept += 1
      continue
    }
    game.priceUah = null
    game.regularPriceUah = null
    game.discountPercent = 0
    game.priceUpdatedAt = null
  }

  const priced = games.filter((game) => game.priceUah !== null).length
  const resolved = requested.length - unresolved.size
  const fresh = resolved >= requested.length * PRICES_ANSWERED_RATIO
  deps.log(
    `prices: ${resolved} of ${requested.length} app ids answered, ${priced} games priced, ${kept} kept their previous price${
      fresh ? '' : ' — too few answers to call the prices fresh'
    }`,
  )
  return { requested: requested.length, answered: resolved, failures, priced, kept, fresh }
}
