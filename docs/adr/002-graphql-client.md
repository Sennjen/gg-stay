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
- No GraphQL runtime ships to the browser beyond the query printer, and that is loaded on demand rather than on first load (`app/utils/printDocument.ts`); urql adds roughly 10–12 KB gzipped, Apollo 30–40 KB.
- On the server, `$fetch('/api/graphql')` is a direct Nitro call with no network hop.
- Filter state lives in the URL; a changed filter changes the `useAsyncData` key, which is the refetch.

## Consequences

- **The 120 KB budget in Context is not met on gzip.** Measured on the production build after the
  redesign: `/games` asks for 131.1 KB gzipped (117.5 KB brotli) of first-load JavaScript, broken
  down chunk by chunk in [docs/perf](../perf/README.md#javascript-budget-for-games-measured). The
  client choice is not what missed it — 111 KB of that is Vue, the Nuxt entry and vue-i18n, before
  a single component of this app, and the GraphQL client's own share is the on-demand printer. The
  budget was set before the redesign added i18n message compilation, Pinia, the filter drawer and
  the cover ring, and was never re-checked. It stands as written, with the real number recorded
  next to it; the remaining levers (mounting the filter drawer on open, precompiling the i18n
  messages) are named in the perf notes and each needs its own measurement.
- **The budget is enforced in CI as a ratchet, not as the 120 KB target.** Re-measured on
  2026-10-01 with the same method, after week 2 added prices, localisation badges, the made-in-Ukraine
  filter and similar games: **137 745 bytes gzipped (134.5 KiB)** across eight modules. CI fails
  above **144 633 bytes (141.2 KiB)** — that measurement plus 5 % — checked by
  `scripts/check-bundle-budget.ts` against the production build on every pull request (see
  [docs/perf](../perf/README.md#the-budget-in-ci)). The 120 KB target above stays missed and stays
  written down; the gate exists so the number cannot drift further without someone deciding it
  should. Raising it means a measurement in the perf notes and a line here, in the same change.
- No normalised cache: two queries returning the same game are fetched independently. Acceptable for a catalog.
- Schema drift is caught at compile time: one SDL schema generates both resolver types and operation types, and CI fails when generated files are stale.
- Revisit if user-specific data or mutations are introduced.
