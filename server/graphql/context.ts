import type { GameIndex } from '../index/GameIndex'
import type { RawgFetch } from '../rawg/rawgFetch'
import type { SteamFetch } from '../steam/steamFetch'
import type { SteamPriceFetch } from '../steam/steamPriceFetch'

/**
 * A key/value cache with a per-entry lifetime, for results a resolver computes rather than for an
 * upstream response: index-served catalog pages (600 s) and the single Steam price the game page
 * refreshes live (6 h). Declared structurally so a test can pass a Map-backed one.
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
}
