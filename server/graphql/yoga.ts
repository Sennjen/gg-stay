import { parse } from 'graphql'
import { createGraphQLError, createSchema, createYoga, type Plugin } from 'graphql-yoga'
import type { GraphQLContext } from './context'
import { checkQueryLength, checkQueryLimits, QUERY_TOO_COMPLEX } from './queryLimits'
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
 * Order matters and is deliberate: the raw length is capped BEFORE `parse()`, so an oversized body
 * never reaches the parser; the structural limits run after, on a document that is already known to
 * be small. A document that fails to parse is left alone — yoga's own parsing reports the syntax
 * error, in its own shape.
 */
const queryLimitsPlugin: Plugin<GraphQLContext> = {
  onParams({ params, setResult }) {
    if (!params.query) return

    const reject = (message: string, code: string) =>
      setResult({ errors: [createGraphQLError(message, { extensions: { code } })] })

    const tooLong = checkQueryLength(params.query)
    if (tooLong) return reject(tooLong.message, tooLong.code)

    let document
    try {
      document = parse(params.query)
    } catch {
      return
    }

    try {
      const violation = checkQueryLimits(document, { allowIntrospection: !isProduction() })
      if (violation) reject(violation.message, violation.code)
    } catch {
      // The limiter is bounded and iterative, so this should be unreachable — but the one thing it
      // must never do is turn a hostile document into an HTTP 500. Anything unexpected here is
      // treated as "too complex to analyse", which is both the safe answer and an honest one.
      reject('Query could not be analysed within its cost budget', QUERY_TOO_COMPLEX)
    }
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
