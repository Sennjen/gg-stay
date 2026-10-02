import type { GraphQLContext } from '../graphql/context'
import { useGameIndex } from '../index/index'
import { keepRunning } from './keepRunning'

/**
 * The context one request's resolvers run in — the GraphQL endpoint builds one per request, and so
 * does `/api/ask`, whose candidates come from the same resolvers.
 */
export async function createGraphQLContext(): Promise<GraphQLContext> {
  // One clock read per request: `today` and `now` are the same instant, so how stale the index is
  // and how old a price is are measured against one moment, and no render path reads a clock.
  const now = new Date().toISOString()
  return {
    rawg: useRawg(),
    steam: useSteam(),
    today: now.slice(0, 10),
    now,
    // Never rejects and never remembers a failure — see server/index/index.ts.
    index: await useGameIndex(),
    steamPrices: useSteamPrices(),
    cache: useResolverCache(),
    // Both endpoints get it from here, so an abandoned RAWG request survives on either.
    waitUntil: keepRunning,
  }
}
