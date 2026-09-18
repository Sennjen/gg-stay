import { createSchema, createYoga } from 'graphql-yoga'
import type { GraphQLContext } from './context'
import { resolvers } from './resolvers'
import { typeDefs } from './schema'

const schema = createSchema<GraphQLContext>({ typeDefs, resolvers })

export function createYogaApp(contextFactory: () => GraphQLContext) {
  return createYoga({
    schema,
    graphqlEndpoint: '/api/graphql',
    context: contextFactory,
    graphiql: process.env.NODE_ENV !== 'production',
    logging: false,
    // The BFF is same-origin only.
    cors: false,
  })
}
