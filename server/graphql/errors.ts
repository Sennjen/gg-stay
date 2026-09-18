import { GraphQLError } from 'graphql'
// graphql-yoga re-exports @graphql-tools/utils' `createGraphQLError`, which builds the error
// using the exact `GraphQLError` class graphql-yoga's own error masking checks against.
// Constructing errors with `new GraphQLError(...)` from the bare `graphql` package instead can
// yield a *different* class instance under bundlers that resolve `graphql`'s dev/prod
// conditional exports inconsistently across dependencies (a known graphql-js dual-package
// hazard) — that mismatch makes graphql-yoga treat our error as "unexpected" and mask its
// message and extensions.code, even though it is already a well-formed GraphQLError.
import { createGraphQLError } from 'graphql-yoga'
import { UpstreamError, type UpstreamKind } from '../rawg/rawgFetch'

export type ErrorCode =
  'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR' | 'NOT_FOUND'

const CODE_BY_KIND: Record<UpstreamKind, ErrorCode> = {
  RATE_LIMITED: 'UPSTREAM_RATE_LIMITED',
  TIMEOUT: 'UPSTREAM_TIMEOUT',
  ERROR: 'UPSTREAM_ERROR',
  NOT_FOUND: 'NOT_FOUND',
}

const MESSAGE: Record<ErrorCode, string> = {
  UPSTREAM_RATE_LIMITED: 'The data source is rate limiting requests',
  UPSTREAM_TIMEOUT: 'The data source did not respond in time',
  UPSTREAM_ERROR: 'The data source failed',
  NOT_FOUND: 'Not found',
}

export function toGraphQLError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error
  const code = error instanceof UpstreamError ? CODE_BY_KIND[error.kind] : 'UPSTREAM_ERROR'
  return createGraphQLError(MESSAGE[code], { extensions: { code } })
}

export async function withUpstreamErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toGraphQLError(error)
  }
}
