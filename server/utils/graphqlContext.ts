import type { GraphQLContext } from '../graphql/context'
import { useGameIndex } from '../index/index'

/**
 * The context one request's resolvers run in — the GraphQL endpoint builds one per request, and so
 * does `/api/ask`, whose candidates come from the same resolvers. `waitUntil` is the request's own
 * hook for work that outlives the response (see `GraphQLContext.waitUntil`), when its caller has
 * one to give.
 */
export async function createGraphQLContext(
  options: { waitUntil?: GraphQLContext['waitUntil'] } = {},
): Promise<GraphQLContext> {
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
    waitUntil: options.waitUntil,
  }
}
