# GG Stay — Week 1 "Skeleton live" design

Date: 2026-09-18
Status: approved
Scope: the first of four delivery cycles. Each cycle has its own design, plan and implementation.

## Goal

A public URL serving a server-rendered game catalog (`/games`) and game detail page (`/games/[slug]`) in Ukrainian (default) and English, backed by a GraphQL BFF over the RAWG REST API, with CI and preview deployments in place.

## Decisions already made

| Topic           | Decision                                                                           |
| --------------- | ---------------------------------------------------------------------------------- |
| Framework       | Nuxt 4 (Nuxt 3 reached end of life on 2026-07-31), TypeScript strict               |
| GraphQL server  | `graphql-yoga` inside Nitro at `/api/graphql`, SDL-first schema                    |
| Types           | `graphql-codegen`: resolver types for the server, `TypedDocumentNode` for pages    |
| GraphQL client  | `useAsyncData` + `$fetch`; no client-side GraphQL runtime (ADR-002)                |
| Rendering       | SSR for `/games` and `/games/[slug]`; ISR for `/` (ADR-001)                        |
| RAWG fixtures   | Hand-written from RAWG docs first, re-recorded from the live API once a key exists |
| Package manager | pnpm, Node 22                                                                      |
| Hosting         | Vercel via GitHub integration; preview URL per PR                                  |
| Repository      | Public from the first commit; everything committed is in English                   |

## Out of scope for week 1

Home shelves, nightly index and Redis, price / localisation / made-in-Ukraine filters in the UI, screenshot gallery, similar games, JSON-LD, sitemap, Playwright, axe, Lighthouse CI, Sentry, `/ask`.

Index-backed schema fields exist from day one so the schema does not change in week 2: `GameCard.price` and `GameCard.localisation` resolve to `null`, `madeInUkraine` to `false`, `GamePage.indexedOnly` to `false`. Index-backed `GameFilter` inputs are accepted and ignored.

## Project structure

```
app/
  pages/        index.vue · games/index.vue · games/[slug].vue
  components/   GameCard · GameGrid · FilterPanel · filters/* · Pagination · SortSelect
                states/LoadingState · states/EmptyState · states/ErrorState
  composables/  useGql.ts · useGameFilters.ts
  stores/       filters.ts
  graphql/      *.graphql (page operations)
server/
  api/graphql.ts
  graphql/      schema.graphql · resolvers/games.ts · resolvers/game.ts · resolvers/taxonomies.ts · errors.ts
  rawg/         rawgFetch.ts · mappers.ts · filterToParams.ts · lookups.ts
i18n/locales/   uk.json · en.json
tests/          fixtures/rawg/*.json · server/*.test.ts · app/*.test.ts
scripts/        record-fixtures.ts
docs/           adr/ · specs/
```

### Module boundaries

- `rawgFetch(path, params)` — transport only. Adds the API key from server-only `runtimeConfig`, enforces a 4 rps in-process limiter, a 5 s timeout, one retry on 5xx or timeout (never on 429), and caching. Knows nothing about GraphQL.
- `mappers.ts` — pure functions from RAWG payloads to schema types. RAWG field names never travel past this file. Every RAWG field is treated as optional.
- `filterToParams.ts` — pure function from `GameFilter` to RAWG query parameters.
- `lookups.ts` — ESRB → PEGI-style `AgeRating`, RAWG tags → `GameMode`, `Playtime` → hour ranges.
- Resolvers — thin: `filterToParams` → `rawgFetch` → `mappers`. They clamp `pageSize` to 40 and `page` to 500; out-of-range input returns an empty page, not an error.
- `useGql(document, variables)` — the only place pages call `/api/graphql`. Wraps `useAsyncData` with a key derived from the operation name and variables. Returns `{ data, error: { code }, status, refresh }`.
- `useGameFilters()` — the only owner of catalog query parameters. Parses the URL into a typed `GameFilter`, serialises it back with a stable key order, and omits empty and default values so URLs are canonical. Invalid values are dropped silently.
- `stores/filters.ts` (Pinia) — in-memory mirror of the URL state while navigating.

## Data flow

1. A request for `/games?genres=rpg&platforms=4` reaches Nuxt SSR.
2. `useGameFilters` parses the query into a `GameFilter`.
3. `useGql` runs the `Games` operation. On the server `$fetch('/api/graphql')` is a direct Nitro call with no network hop; on the client it is a POST.
4. The resolver builds RAWG parameters, calls `rawgFetch`, maps the result.
5. The HTML response already contains 20 game cards; the Nuxt payload hydrates the page without a second request.

Every filter change is a `router.push`, so back/forward restore filter state; `scrollBehavior` restores the saved scroll position.

### Cache

Nitro storage keyed by normalised URL (sorted parameters, API key excluded).

| Resource                                          | TTL       |
| ------------------------------------------------- | --------- |
| Game lists                                        | 600 s     |
| Game detail                                       | 86 400 s  |
| Taxonomies (genres, platforms, developers search) | 604 800 s |

Stale-if-error: when RAWG fails and an expired entry exists, the expired entry is served.

### Fixture mode

With `RAWG_FIXTURES=1`, `rawgFetch` reads `tests/fixtures/rawg/*.json` instead of calling RAWG. This keeps development and the first deployment unblocked until a RAWG key is available. `scripts/record-fixtures.ts` overwrites the same files with live responses.

## Error handling

`rawgFetch` throws a typed `UpstreamError`. `server/graphql/errors.ts` converts it to a `GraphQLError` with `extensions.code`:

| Upstream condition | Code                    |
| ------------------ | ----------------------- |
| HTTP 429           | `UPSTREAM_RATE_LIMITED` |
| Timeout            | `UPSTREAM_TIMEOUT`      |
| HTTP 5xx           | `UPSTREAM_ERROR`        |
| HTTP 404 on detail | `NOT_FOUND`             |

UI behaviour:

- `ErrorState` selects its message by code.
- `UPSTREAM_RATE_LIMITED` shows "Data source is busy, retrying…" and calls `refresh()` once after 2 s.
- `NOT_FOUND` on `/games/[slug]` raises `createError({ statusCode: 404 })`: a real HTTP 404, the app's not-found page, `noindex`.
- Every data-fetching block has loading (skeleton), empty (active filters plus a "clear filters" action) and error states.
- A game card without index data renders no price or localisation area at all — no placeholder.

## Hydration safety

- Dates and numbers are formatted with `Intl` using an explicit locale and `timeZone: 'UTC'`.
- No `Date.now()` or `Math.random()` in render paths.
- Locale comes from the URL prefix (`prefix_except_default`, `uk` at `/`, `en` at `/en`), never from request headers, so server and client always agree.

## Catalog filters in week 1

Platform, genre, release year or range, upcoming, Metacritic minimum, user rating minimum, playtime, game mode, age rating, store, developer (autocomplete), text search; sort by popularity, rating, Metacritic, release date, name; pagination. Price and discount sorts are present in the schema and hidden in the UI until week 2.

## Testing

Vitest, no network access. Test-first for every unit.

- `rawgFetch`: key injection, limiter, timeout, single retry on 5xx and timeout, no retry on 429, cache hit, stale-if-error, cache key normalisation.
- `filterToParams`, `mappers`, `lookups`: table-driven tests against fixtures, one case per filter.
- Resolver contract tests: real GraphQL operations executed against yoga with `rawgFetch` mocked by fixtures — `games`, `game`, `genres`, `platforms`, `developers`, all four error codes, page clamps, index-backed fields resolving to `null` / `false`.
- `useGameFilters`: URL → filter → URL round trip, invalid values dropped, canonical key order.
- Components (`@vue/test-utils`): `GameCard` without price, empty state, error state, 429 auto-retry with fake timers.
- SSR (`@nuxt/test-utils`): `/games` HTML contains cards, `/en/games` is in English, an unknown slug responds 404.

## CI and deployment

GitHub Actions on every PR and push to `main`: `pnpm install --frozen-lockfile` → codegen with a no-diff check → `eslint` → `vue-tsc --noEmit` → `vitest run`. `main` is protected; changes land through PRs with green CI.

Vercel builds with the Nitro `vercel` preset. The first deployment runs with `RAWG_FIXTURES=1`; once `RAWG_API_KEY` is set in Vercel, fixtures are re-recorded and the flag is removed. Secrets live only in Vercel environment variables and GitHub Secrets; the repository contains `.env.example` only.

## Work order

Each step is one PR with green CI.

1. Scaffold: Nuxt 4, TypeScript strict, ESLint, Prettier, Tailwind, `@nuxt/image`, `@nuxtjs/i18n`, Vitest, CI workflow, GitHub repository, Vercel connection.
2. `rawgFetch`, fixtures, `record-fixtures` script.
3. SDL schema, codegen, `mappers`, `lookups`, `filterToParams`.
4. Resolvers, error mapping, contract tests.
5. `useGql`, `useGameFilters`, Pinia store.
6. `/games`: grid, filters, sort, search, pagination, states.
7. `/games/[slug]`: cover, description, platforms, age rating, playtime, store links, 404.
8. UI strings in `uk` and `en`, date and number formatting, locale switcher, `hreflang`.
9. ADR-001 (rendering strategy), ADR-002 (GraphQL client), minimal README, footer attribution to RAWG.

## Done when

On the Vercel preview deployment:

- A cold request to `/games?genres=rpg&platforms=4&sort=RELEASED_DESC` returns HTML that already contains 20 matching game cards.
- Reloading any filtered URL restores the same filters, sort and page; back/forward restore the previous state.
- A simulated RAWG 429 shows the busy message and one automatic retry; no blank screen, no stack trace.
- A zero-result query shows the empty state with active filters and a clear action.
- An unknown slug responds 404 with the not-found page and `noindex`.
- `/games` renders Ukrainian UI strings, dates and numbers; `/en/games` renders English; game data stays in its original language.
- CI is green: codegen no-diff, ESLint zero errors, `vue-tsc --noEmit`, Vitest.
