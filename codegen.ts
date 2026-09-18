import type { CodegenConfig } from '@graphql-codegen/cli'

const shared = { useTypeImports: true, enumsAsTypes: true, skipTypename: true }

const config: CodegenConfig = {
  schema: 'server/graphql/schema.ts',
  documents: 'app/graphql/**/*.graphql',
  ignoreNoDocuments: true,
  generates: {
    'server/graphql/__generated__/resolvers-types.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: { ...shared, contextType: '../context#GraphQLContext' },
    },
    'app/graphql/__generated__/operations.ts': {
      plugins: ['typescript-operations', 'typed-document-node'],
      config: shared,
    },
  },
}

export default config
