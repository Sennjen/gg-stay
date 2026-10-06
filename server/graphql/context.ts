import type { GameIndex } from '../index/GameIndex'
import type { RawgFetch } from '../rawg/rawgFetch'
import type { SteamFetch } from '../steam/steamFetch'
import type { SteamPriceFetch } from '../steam/steamPriceFetch'

/**
 * A key/value cache with a per-entry lifetime, for results a resolver computes rather than for an
 * upstream response: index-served catalog pages (600 s) and what the game page's live Steam read
 * found for one app, a price or none (6 h). Declared structurally so a test can pass a Map-backed
 * one.
 */
export interface ResolverCache {
  get: <T>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, ttlSeconds: number) => Promise<void>
}

export interface GraphQLContext {
  rawg: RawgFetch
  steam: SteamFetch
  /** Current UTC date as YYYY-MM-DD; injected so resolvers stay deterministic in tests. */
  today: string
  /**
   * The same moment as an ISO timestamp. One clock read per request serves both, so everything a
   * response says about age — how stale the index is, how old a price is — is measured against a
   * single instant, and nothing in a render path ever reads a clock of its own.
   */
  now: string
  index: GameIndex
  steamPrices: SteamPriceFetch
  cache: ResolverCache
  /**
   * Keeps `work` running after the response has been sent. A serverless platform may freeze a
   * function the moment it has answered, and a resolver that deliberately stops waiting for
   * something — the catalog no longer waiting for a slow RAWG page, the game page no longer
   * waiting for anything past its budget — hands it over here, so that the response still reaches
   * the cache it was headed for. The site passes `keepRunning` (`server/utils/keepRunning.ts`); a
   * test passes a spy, or nothing, in which case the work is simply left running. Nothing here
   * catches, so what is handed over must already have its rejection handled — which is what
   * `leaveRunning` (`server/graphql/budget.ts`) is for.
   */
  waitUntil?: (work: Promise<unknown>) => void
}
