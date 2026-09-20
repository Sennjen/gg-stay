# GG Stay — Week 2A "Price and localisation index" design

Date: 2026-09-20
Status: approved
Scope: the first of three week 2 cycles. 2B (made in Ukraine, home shelves, similar games) and 2C (SEO, Lighthouse CI, web-vitals, Playwright and axe) have their own designs.

## Goal

Hryvnia prices, discounts and Ukrainian localisation on cards and game pages, and catalog filters and sorts over them — for the 3 000 most popular games, refreshed on a schedule, with exact counts and pagination, and with the site staying up when the index or its job fails.

## Findings that shaped the design

Checked against the live Steam endpoint on 2026-09-20:

- `appdetails?appids=a,b,c&cc=ua&filters=price_overview` accepts many app ids per request and answers in UAH. 3 000 prices are about 30 requests, not 3 000.
- `supported_languages` is not available through `filters=price_overview`; it needs one unfiltered request per app. It changes rarely.
- The API reports, per language, only "supported" and "full audio" (an asterisk). Interface and subtitles are not distinguishable without scraping store pages, which this project does not do. Localisation therefore has two levels: **text** and **audio**.
- A game's Steam app id comes from RAWG's per-game store links: one RAWG request per game. Resolving 3 000 ids nightly would exceed RAWG's free monthly quota, so the mapping is resolved once per game and kept permanently.

## Decisions

| Topic               | Decision                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store               | Upstash Redis over REST (works from serverless functions); free tier                                                                                            |
| Index model         | Faceted index: one card document per game, one set per facet value, one sorted set per sort order. Every catalog filter is indexed, not only price and language |
| Publication         | Versioned key prefix plus a `idx:current` pointer (blue/green). A run publishes only after validation; the previous version expires later                       |
| Job runner          | GitHub Actions on a schedule, a plain Node script reusing the server modules. Vercel function time limits rule out a long run there                             |
| Cadence             | Prices every 6 hours; candidate list daily; languages weekly and immediately for new games                                                                      |
| Localisation levels | `TEXT` and `AUDIO`. `SUBTITLES` is removed from the schema (it was never served)                                                                                |
| Alerting            | A failed workflow run (GitHub notifies the owner) plus a job summary. Sentry is out of scope                                                                    |
| USD tooltip         | Dropped from 2A: a second priced run for little value                                                                                                           |
| Other stores        | Week 4                                                                                                                                                          |

## Data model

All index keys live under a version prefix `idx:v{N}:`.

| Key                                                                                                                                             | Type        | Purpose                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game:{rawgId}`                                                                                                                                 | JSON string | Card document: id, slug, name, cover, release date, platforms, genres, stores, modes, age rating, rating, ratings count, Metacritic, playtime, price, regular price, discount, free flag, localisation, made-in-Ukraine flag, price timestamp |
| `f:genre:{id}` `f:platform:{id}` `f:store:{id}` `f:mode:{X}` `f:age:{X}` `f:playtime:{X}` `f:loc:text` `f:loc:audio` `f:free` `f:ua` `f:priced` | set         | Facets                                                                                                                                                                                                                                        |
| `o:{GameSort}` — one per sort value and direction                                                                                               | sorted set  | Order: the score is the final rank with the tie-break (popularity, then id) already applied, so an ascending range read after intersection is the final order                                                                                 |
| `r:price` `r:discount` `r:metacritic` `r:rating` `r:released`                                                                                   | sorted set  | Ranges: true values (hryvnia, percent, score, rating × 100, days since epoch) for range trims                                                                                                                                                 |
| `names`                                                                                                                                         | hash        | id → lower-cased name, for substring search                                                                                                                                                                                                   |
| `meta`                                                                                                                                          | hash        | `updatedAt`, `pricesUpdatedAt`, game count, run statistics                                                                                                                                                                                    |

Outside the version prefix: `idx:current` (active version), `appid:{rawgId}` (permanent Steam app id, empty string for "has none"), `job:cursor:{stage}` (resume point).

Order and range sets are separate on purpose: one sorted set per field cannot give a direction-independent tie-break on Redis, and millisecond timestamps combined with a tie-break overflow the 53-bit scores Redis stores. Ranks, including locale-aware name order, are computed once per version by a pure planner shared by the writer and both adapters. Games without a price are absent from the price and discount order sets, so price sorts never list them.

## Query

One pipelined round trip per page:

1. For each facet with several selected values, union them (`SUNIONSTORE` into a temporary key); facets are then intersected with each other and with the sort order's sorted set (`ZINTERSTORE`, weights chosen so the sort score survives).
2. Ranges are trimmed on the relevant sorted sets before intersection: price ≤ N, discount ≥ N, Metacritic ≥ N, rating ≥ N, release date range.
3. `ZCARD` gives the exact total; `ZRANGE` (or `ZREVRANGE`) gives the page; `MGET` fetches the card documents.
4. Temporary keys expire after 60 s.

Text search combined with an index filter reads the `names` hash, matches the substring in the application and intersects the matching ids with the rest — a second round trip only when searching; totals stay exact. Upstash has no full-text module and 3 000 names do not need one.

Results are cached in Nitro storage for 600 s under the normalised filter, so repeated views cost no Redis commands.

## Which path serves a request

- **No index filter and no index sort** — RAWG, as today, over the whole catalog. Prices, localisation and the made-in-Ukraine flag are attached with one `MGET` for the ids on the page; games outside the index simply have none.
- **Any of `priceMaxUah`, `free`, `onSaleMinPercent`, `ukrainianLocalisation`, `madeInUkraine`, or a price or discount sort** — the whole request is answered from the index. `indexedOnly: true` makes the UI say the search covers the 3 000 most popular games.
- **`game(slug)`** — reads its index entry; if the price is older than 6 hours it refreshes that one game from Steam live, keeps the index copy on failure and logs a warning.

## Failure behaviour

- Redis unreachable or not configured: the catalog runs on RAWG without prices; the error is logged; no page fails.
- `meta.updatedAt` older than 7 days: `indexStale: true`. Price and discount filters and sorts are hidden, cards show no prices (a stale price is worse than none), a banner explains it, a `priceMaxUah` left in the URL is ignored and its chip is shown struck through with the reason. Everything else works.
- A run that ends with fewer than 50 % of the previous run's games, or with no prices at all, does not move `idx:current`. The workflow fails.
- The job is resumable: each stage records a cursor and continues from it.

## Code boundaries

- `server/index/GameIndex.ts` — the port: `search(filter, sort, page, pageSize)`, `getMany(ids)`, `getOne(id)`, `meta()`.
- `server/index/memoryIndex.ts` — in-memory adapter with the same set semantics; used in tests, in development without credentials and in CI; seeded from fixtures.
- `server/index/upstashIndex.ts` — Upstash adapter.
- `server/index/keys.ts`, `server/index/document.ts` — key names and the card document shape, shared by reader and writer.
- `server/steam/price.ts`, `server/steam/languages.ts` — pure parsers; `server/steam/steamPriceFetch.ts` — batched price transport built on the shared upstream transport.
- `scripts/index/` — the job: `candidates.ts`, `prices.ts`, `languages.ts`, `publish.ts`, `run.ts`.
- One contract test suite runs against both adapters.

## GraphQL changes

- `enum Localisation { ANY TEXT AUDIO }`; `LocalisationInfo { text, audio, source }`.
- `GamesPage` gains `indexStale: Boolean!` and `indexUpdatedAt: String`.
- `GameCard.price`, `GameCard.localisation`, `madeInUkraine`, `GamePage.indexedOnly` stop being placeholders. `madeInUkraine` stays `false` until 2B supplies the studio list.
- Existing query limits apply unchanged; every shipped document must still pass them.

## Interface

**Card** (grid, list, landing rows): a price line under the year and platforms — `1 349 ₴`; on sale an amber `−75 %` chip, the new price and the old one struck through; `Безкоштовно` for free games. A small localisation badge: `UA` for text, `UA` with a speaker glyph for audio, each with a visible-on-hover title and an accessible name that spells it out. A game outside the index has no price line at all. Card heights stay equal within a row.

**Game page**: the scoreboard gains "Ціна в Steam" (price, discount, "оновлено N годин тому") and "Українська" (Текст / Текст і озвучка / Немає). In "Де купити" the Steam link carries its price. Other stores stay plain links until week 4.

**Filters** (drawer): "Ціна" — Безкоштовно, до 300 ₴, до 600 ₴, до 1 000 ₴, own amount; "Знижка" — від 25 %, 50 %, 75 %; "Українська локалізація" — Будь-яка, Текст, Озвучка. Sorts: cheapest first, most expensive first, biggest discount. URL parameters `priceMaxUah`, `free`, `onSaleMinPercent`, `ukrainianLocalisation`, `sort`; the existing URL-is-state mechanism and active chips carry them.

**Notes**: under the result count when the index serves the page — "Пошук серед 3 000 найпопулярніших ігор — ціни й мови ми знаємо лише для них". The stale banner as described above.

**Formatting**: `Intl.NumberFormat` with `currency: 'UAH'`, no fraction digits, through the existing formatters; prices are hryvnia in both locales. "Updated N hours ago" is computed on the server from the timestamp and rounded to hours; no clock reads in render paths.

## Secrets

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The site on Vercel gets a **read-only** token; the write token lives only in GitHub Secrets for the job. `.env.example` lists names only.

## Testing

Vitest, no network, test-first.

- `GameIndex` contract on both adapters: facet intersection, union within a facet, every range, exact totals, paging, every sort, empty result, unpriced games absent from price sorts.
- Steam parsers on recorded fixtures: price, discount, free, unavailable in region, Ukrainian text, Ukrainian audio, no Ukrainian, markup inside the language list.
- Job: full run on fixtures, resume from a cursor, blue/green refusal below 50 %, app ids never re-resolved, the 40 requests per minute limit on a fake clock.
- Resolvers: path selection, `indexedOnly`, `indexStale`, Redis down, one round trip per indexed page (call counter), live refresh on the game page and its failure.
- Components: price line in every state, localisation badge, new filter sections, note, banner.
- SSR acceptance: `/games?priceMaxUah=300&onSaleMinPercent=50&sort=DISCOUNT_DESC`, `/games?ukrainianLocalisation=AUDIO&platforms=4`, a card outside the index, the stale index.

## Work order

Each step is one PR with green CI.

1. `GameIndex` port, in-memory adapter, contract tests, schema changes.
2. Upstash adapter: facets, pipeline, versioned keys and the pointer.
3. Steam price and language parsers, batched price transport.
4. The refresh job, its workflow, blue/green publication, resume.
5. Resolvers: path selection, price attachment on RAWG pages, stale handling, live refresh on the game page.
6. Interface: price line and badge on cards; scoreboard and "Де купити" on the game page.
7. Interface: filter sections, sorts, the "top 3 000" note, the stale banner.
8. SSR acceptance tests, ADR-003, README; credentials and the first live run; production check and a Lighthouse measurement.

## Done when

On production, with a live index:

- `/games?priceMaxUah=300&onSaleMinPercent=50&sort=DISCOUNT_DESC` returns server-rendered cards that all cost at most 300 ₴ with at least 50 % off, ordered by discount, with an exact total and working pagination, and the "top 3 000" note.
- `/games?ukrainianLocalisation=AUDIO&platforms=4` shows only PC games with Ukrainian audio, each with the badge.
- The default catalog still covers all of RAWG, with prices on the cards the index knows.
- A Steam game's page shows its UAH price, discount, update time and localisation.
- With Redis credentials removed, every page still renders.
- The scheduled workflow has completed a run and published a version; a deliberately truncated run does not replace it.
- Lighthouse for `/games` and `/games/[slug]` is recorded in `docs/perf/` next to the previous step.
