import type { RawgFetch } from '../rawg/rawgFetch'
import type { SteamFetch } from '../steam/steamFetch'

export interface GraphQLContext {
  rawg: RawgFetch
  steam: SteamFetch
  /** Current UTC date as YYYY-MM-DD; injected so resolvers stay deterministic in tests. */
  today: string
}
