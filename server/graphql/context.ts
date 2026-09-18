import type { RawgFetch } from '../rawg/rawgFetch'

export interface GraphQLContext {
  rawg: RawgFetch
  /** Current UTC date as YYYY-MM-DD; injected so resolvers stay deterministic in tests. */
  today: string
}
