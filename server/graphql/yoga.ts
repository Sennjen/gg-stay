import { parse } from 'graphql'
import { createGraphQLError, createSchema, createYoga, type Plugin } from 'graphql-yoga'
import type { GraphQLContext } from './context'
import { checkQueryLimits } from './queryLimits'
import { resolvers } from './resolvers'
import { typeDefs } from './schema'

const schema = createSchema<GraphQLContext>({ typeDefs, resolvers })

const isProduction = () => process.env.NODE_ENV === 'production'

/**
 * Rejects over-costly operations before anything reaches a resolver (and therefore before a single
 * upstream call is made). The check runs in `onParams` rather than as a validation rule on purpose:
 * a validation failure is an HTTP 400, while every other error this endpoint produces is a GraphQL
 * error inside an HTTP 200 body (see `server/graphql/errors.ts`). Setting the result here keeps the
 * client's error handling uniform — one shape, one status, `extensions.code` carries the reason.
 *
 * A document that fails to parse is left alone: yoga's own parsing reports the syntax error.
 */
const queryLimitsPlugin: Plugin<GraphQLContext> = {
  onParams({ params, setResult }) {
    if (!params.query) return
    let document
    try {
      document = parse(params.query)
    } catch {
      return
    }
    const violation = checkQueryLimits(document, { allowIntrospection: !isProduction() })
    if (!violation) return
    setResult({
      errors: [createGraphQLError(violation.message, { extensions: { code: violation.code } })],
    })
  },
}

export function createYogaApp(contextFactory: () => GraphQLContext) {
  return createYoga({
    schema,
    graphqlEndpoint: '/api/graphql',
    context: contextFactory,
    // GraphiQL and introspection are separate switches in graphql-yoga: turning the UI off still
    // leaves the SDL readable. `queryLimitsPlugin` closes the second half in production.
    graphiql: !isProduction(),
    logging: false,
    // The BFF is same-origin only.
    cors: false,
    // Array request bodies (query batching) are rejected by graphql-yoga itself with HTTP 400;
    // leaving `batching` unset keeps that default, so one request can never fan out into many.
    plugins: [queryLimitsPlugin],
  })
}
