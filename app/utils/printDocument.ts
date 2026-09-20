import type { TypedDocumentNode } from '@graphql-typed-document-node/core'

/**
 * Serialises a generated document to the query string the BFF expects, loading `graphql`'s printer
 * on demand.
 *
 * A static `import { print } from 'graphql/language/printer'` put roughly 8 KB (gzipped) of the
 * `graphql` package into a chunk every page imported — including the landing page, which only ever
 * issues one fixed query, and the server-rendered first load, where the result is already in the
 * payload and no client-side request happens at all. Importing it inside the request path moves
 * those bytes off the first load entirely: they are fetched only when the visitor actually
 * triggers a query from the client (a search, a filter change, a client-side navigation).
 *
 * The printed result is memoised per document: the documents are module-level constants, so the
 * same one is printed on every call otherwise.
 */
const printed = new WeakMap<object, string>()

export async function printDocument(document: TypedDocumentNode<unknown, never>): Promise<string> {
  const cached = printed.get(document)
  if (cached) return cached
  const { print } = await import('graphql/language/printer')
  const query = print(document)
  printed.set(document, query)
  return query
}
