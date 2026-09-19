# GG Stay

[![CI](https://github.com/Sennjen/gg-stay/actions/workflows/ci.yml/badge.svg)](https://github.com/Sennjen/gg-stay/actions/workflows/ci.yml)

A server-rendered video game catalog built for Ukrainian players: Ukrainian-first interface, practical filters, and a GraphQL layer over the [RAWG](https://rawg.io) API.

**Live:** https://gg-stay.vercel.app

## Status

Week 1 (skeleton: catalog, game detail, Ukrainian and English UI, CI, preview
deployments) is done, and so is the visual redesign: a cinematic landing
page, a cover-first catalog with a filter drawer, and a restyled game page
share one dark design system (tokens and component inventory in
[DESIGN.md](DESIGN.md)). Steam trailers (with a RAWG-clip fallback) and
Ukrainian game descriptions (from each title's Steam store page, where one
exists) are live.

| Next   | Scope                                                                               |
| ------ | ----------------------------------------------------------------------------------- |
| Week 2 | Nightly Steam index (UAH prices, Ukrainian localisation), SEO, Lighthouse CI        |
| Week 3 | Natural-language search with validated structured output and deterministic fallback |
| Week 4 | Cross-store prices                                                                  |

## Architecture

```mermaid
flowchart LR
  B[Browser] -->|HTML + hydration| N[Nuxt 4 SSR]
  N -->|GraphQL| G[Nitro BFF /api/graphql]
  G -->|REST + key, cached| R[RAWG API]
  G -->|REST, cached, trailers + UA descriptions| S[Steam Store API]
```

- The browser never calls RAWG or Steam directly; both API surfaces are only reached from the server.
- Resolvers are thin: `filterToParams` → `rawgFetch` → `postFilter` → `mappers`. RAWG field names stop at the mapper.
- `rawgFetch` adds a 4 rps limiter, a 5 s timeout, one retry on 5xx or timeout, a cache (lists 10 min, detail 24 h, taxonomies 7 days) and stale-if-error; `steamFetch` follows the same shape.
- All catalog filter state lives in the URL, parsed and serialised by pure functions.

## Landing page

- A full-bleed hero: the featured game's poster is the LCP element, with an
  optional Steam or RAWG trailer that loads after the page goes idle, muted,
  looping, with a visible pause control and a static poster fallback under
  `prefers-reduced-motion`.
- A cover ring of the catalog's most-added titles — pause on hover, drag or
  arrow-key rotation, click through to a game page; a static marquee below
  768 px and under reduced motion.
- "Why GG Stay", new-releases and top-rated rows, and a closing call to action.

## Catalog and game page

- A slide-out filter drawer (left panel ≥ 1024 px, bottom sheet below):
  platform, genre, year range, Metacritic, player rating, playtime, game
  mode, age rating, store and developer, all as active filter chips.
- A header search with a debounced instant-results dropdown, keyboard
  navigable, that reuses the catalog's own search query.
- Grid or list view (a local preference, not part of the URL).
- The game page carries a scoreboard row, a keyboard- and screen-reader-
  accessible screenshot gallery/lightbox, and store links.

Decisions are recorded in [docs/adr](docs/adr); the week 1 design is in
[docs/specs](docs/specs); the redesign design is in
[docs/specs/2026-09-19-redesign-design.md](docs/specs/2026-09-19-redesign-design.md).

## Performance

Lighthouse (mobile) is measured on `/` and `/games` after each performance
change lands, with the report and numbers recorded in
[docs/perf](docs/perf/README.md).

## Development

```bash
pnpm install
cp .env.example .env   # RAWG_FIXTURES=1 serves recorded fixtures, no API key needed
pnpm dev
```

| Command                           | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `pnpm test`                       | Unit, component and SSR tests (no network access)      |
| `pnpm typecheck`                  | `vue-tsc` over app and server                          |
| `pnpm lint` / `pnpm format:check` | ESLint and Prettier                                    |
| `pnpm codegen`                    | Regenerate GraphQL types; CI fails when they are stale |

## Known gaps

- Player rating, playtime and age rating filters are applied after fetching a page, because RAWG has no query parameters for them. A filtered page can hold fewer than 20 games and the total count reflects the unfiltered query.
- Selecting several game modes widens the result set rather than narrowing it, because RAWG treats comma-separated tags as OR.
- The response cache is in memory per server instance until the shared Redis store lands in week 2.
- Fixture mode ignores filters that RAWG would apply server-side.
- Steam trailer URLs carry a signed query string; how long that signature stays valid is undocumented by Steam, so a cached trailer link could go stale before its own cache entry expires. Not yet observed in practice.
- There are no prices yet — `PriceSummary`/`StoreOffer` price fields exist in the schema but resolve to `null` until the nightly Steam index (week 2) fills them in.

## Attribution

Game data and images are provided by [RAWG](https://rawg.io) and [Steam](https://store.steampowered.com). Names and images belong to their respective owners. On the Ukrainian site, the game description comes from Steam's Ukrainian store page when the publisher provides one; otherwise it falls back to RAWG's English text.

## License

MIT
