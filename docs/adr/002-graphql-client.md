# ADR-002: GraphQL client

Date: 2026-09-18 · Status: accepted

## Context

Pages consume a single GraphQL endpoint served by the same Nitro server. Constraints: at most 120 KB of gzipped JavaScript on the first load of `/games`, SSR on every route, all filter state in the URL.

## Options

1. `useAsyncData` + `$fetch`, typed with `graphql-codegen` (`TypedDocumentNode`).
2. `@urql/vue`.
3. Apollo Client.

## Decision

Option 1, wrapped in a single `useGql` composable.

## Reasons

- The app is read-only: no mutations, subscriptions or optimistic updates. A client-side GraphQL cache has nothing to do.
- Caching already happens on the server. A second cache in the browser would be a second source of truth.
- Nuxt transfers `useAsyncData` results to the client in its payload. urql's `ssrExchange` would duplicate that mechanism and add a hydration-mismatch risk.
- No GraphQL runtime ships to the browser beyond the query printer; urql adds roughly 10–12 KB gzipped, Apollo 30–40 KB.
- On the server, `$fetch('/api/graphql')` is a direct Nitro call with no network hop.
- Filter state lives in the URL; a changed filter changes the `useAsyncData` key, which is the refetch.

## Consequences

- No normalised cache: two queries returning the same game are fetched independently. Acceptable for a catalog.
- Schema drift is caught at compile time: one SDL schema generates both resolver types and operation types, and CI fails when generated files are stale.
- Revisit if user-specific data or mutations are introduced.
