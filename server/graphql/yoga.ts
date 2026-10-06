import { parse } from 'graphql'
import { createGraphQLError, createSchema, createYoga, type Plugin } from 'graphql-yoga'
import type { GraphQLContext } from './context'
import {
  checkNestingDepth,
  checkQueryLength,
  checkQueryLimits,
  QUERY_TOO_COMPLEX,
} from './queryLimits'
import { resolvers } from './resolvers'
import { typeDefs } from './schema'
import { createServerTiming, writeServerTiming, type ServerTiming } from './serverTiming'

const schema = createSchema<GraphQLContext>({ typeDefs, resolvers })

const isProduction = () => process.env.NODE_ENV === 'production'

/**
 * Rejects over-costly operations before anything reaches a resolver (and therefore before a single
 * upstream call is made). The check runs in `onParams` rather than as a validation rule on purpose:
 * a validation failure is an HTTP 400, while every other error this endpoint produces is a GraphQL
 * error inside an HTTP 200 body (see `server/graphql/errors.ts`). Setting the result here keeps the
 * client's error handling uniform — one shape, one status, `extensions.code` carries the reason.
 *
 * Order matters and is deliberate, and every step before `parse()` is there because `parse()`
 * itself is not safe on arbitrary input:
 *
 *  1. The raw byte length is capped, so an oversized body never reaches the parser.
 *  2. The raw bracket nesting is capped, because graphql-js parses by recursive descent and a
 *     document nested a couple of thousand levels deep — which fits easily inside the byte cap —
 *     overflows the call stack inside the parser.
 *  3. Only then is the document parsed, and the structural limits run on something already known
 *     to be small and shallow.
 *
 * A document that fails to parse with a *syntax* error is left alone: yoga's own parsing reports it
 * in its own shape. Anything else a parse can throw — a `RangeError` from the recursion above all —
 * is turned into `QUERY_TOO_COMPLEX`, because `setResult` short-circuits and yoga never gets to
 * parse the same document a second time and overflow on it. An unauthenticated request must not be
 * able to produce an HTTP 500 from this endpoint, whatever the shape of its body.
 */
const queryLimitsPlugin: Plugin<GraphQLContext> = {
  onParams({ params, setResult }) {
    if (!params.query) return

    const reject = (message: string, code: string) =>
      setResult({ errors: [createGraphQLError(message, { extensions: { code } })] })

    const tooLong = checkQueryLength(params.query)
    if (tooLong) return reject(tooLong.message, tooLong.code)

    const tooDeep = checkNestingDepth(params.query)
    if (tooDeep) return reject(tooDeep.message, tooDeep.code)

    let document
    try {
      document = parse(params.query)
    } catch (error) {
      // A `RangeError` here is the parser running out of stack, not a malformed document. The name
      // is checked rather than `instanceof`, which is unreliable across the realms a bundler can
      // leave in play (see the dual-package note in server/graphql/errors.ts).
      const name = (error as { name?: string } | null)?.name
      if (name === 'RangeError') {
        return reject('Query is nested too deeply to parse', QUERY_TOO_COMPLEX)
      }
      // A real syntax error: let yoga report it.
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

/**
 * Says on every answer where its time went (`server/graphql/serverTiming.ts`).
 *
 * The timing starts when the request arrives and the header is written when its answer is ready,
 * so `total` covers everything this endpoint did for it: building the context, parsing, the
 * resolvers. It is on every answer the endpoint gives — an error inside an HTTP 200 and a refused
 * operation as much as a page — and on those it simply names fewer upstreams, down to none.
 *
 * The request is what ties the two ends together, and the context factory to both: yoga hands the
 * same `Request` to every hook of one request, and nothing else here is per request. A request
 * these hooks never saw has no entry, and its answer no header.
 *
 * Neither hook can throw. The server adapter does not catch what these two raise, and an answer
 * must never be lost to its own timing.
 */
function serverTimingPlugin(timings: WeakMap<Request, ServerTiming>): Plugin<GraphQLContext> {
  return {
    onRequest({ request }) {
      timings.set(request, createServerTiming())
    },
    onResponse({ request, response }) {
      const timing = timings.get(request)
      if (timing) writeServerTiming(response.headers, timing)
    },
  }
}

/**
 * The GraphQL endpoint below HTTP. `contextFactory` builds the context one request's resolvers run
 * in, and is handed that request's timing: a factory that wants its upstream calls named in the
 * answer's `Server-Timing` header wraps its context with it (`timedContext`), and one that does
 * not gets a header with the total alone.
 */
export function createYogaApp(
  contextFactory: (timing: ServerTiming) => GraphQLContext | Promise<GraphQLContext>,
) {
  const timings = new WeakMap<Request, ServerTiming>()
  return createYoga({
    schema,
    graphqlEndpoint: '/api/graphql',
    context: ({ request }) => contextFactory(timings.get(request) ?? createServerTiming()),
    // GraphiQL and introspection are separate switches in graphql-yoga: turning the UI off still
    // leaves the SDL readable. `queryLimitsPlugin` closes the second half in production.
    graphiql: !isProduction(),
    logging: false,
    // The BFF is same-origin only.
    cors: false,
    // Array request bodies (query batching) are rejected by graphql-yoga itself with HTTP 400;
    // leaving `batching` unset keeps that default, so one request can never fan out into many.
    plugins: [queryLimitsPlugin, serverTimingPlugin(timings)],
  })
}
