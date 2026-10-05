# ADR-004: Price and localisation index

Date: 2026-10-05 · Status: accepted

This record describes a decision that is already in the code: it was designed on 2026-09-20 ([week 2A design](../specs/2026-09-20-week2a-price-index-design.md)), extended on 2026-09-30 ([week 2B design](../specs/2026-09-30-week2b-shelves-design.md)) and last changed by the RAWG hedge in #66. Where the designs and the code differ, this record follows the code.

## Context

The catalog is built on RAWG, and RAWG has no prices and no localisation data, so it can neither show them nor filter or sort by them. Steam has both, but no bulk price API for a catalog: `appdetails` with `filters=price_overview` and `cc=ua` answers in hryvnia for up to a hundred app ids per request, `supported_languages` needs one unfiltered request per game, and a game's Steam app id comes from RAWG's per-game store links — one RAWG request per game. None of that can run inside a page request, and a filter such as "under 300 ₴ with Ukrainian text" needs exact totals and paging over the whole set, not a per-page lookup.

## Decision

A faceted index of the most popular games in Upstash Redis, written by a scheduled GitHub Actions job and read by the site through a read-only token.

### What is in it

- **Candidates**: the top of RAWG's most-added order — 75 pages of 40, 3 000 games — plus the games of the studios in `data/ukrainian-studios.json` (25 studios, up to 2 pages per RAWG developer slug, at most 400 games appended beyond the popularity list), flagged `madeInUkraine`.
- **Per game**: one card document with the catalog fields, the Steam price in hryvnia (price, regular price, discount, free), the Ukrainian localisation level (text or audio), the mood tags `/ask` uses and a stored list of 8 similar games (cosine similarity over tags, genres and game modes weighted by inverse document frequency, computed once per full run).
- **Keys**: one set per facet value, one sorted set per sort order (scored by final rank, tie-break applied by the writer) and one per range field (price, discount, Metacritic, rating, release date), all under a version prefix `idx:v{N}:`. Steam app ids (`appid:{rawgId}`) and language records (`lang:{appId}`) live outside the prefix and survive publications: an app id is resolved once and kept.

### How it is refreshed

`.github/workflows/index-refresh.yml` runs `pnpm index:refresh` in three modes: **prices** every six hours (about thirty batched Steam requests over the published documents), **full** nightly at 02:30 UTC (candidates, studio games, new app ids, prices, similar games, and language records that are missing or — up to 300 a run — older than 7 days), and **languages** weekly (the rest of the language sweep, at 40 requests a minute). One run at a time: the writer holds `idx:lock` (30 minute TTL, renewed during long stages) and the job first proves its token may write.

A run writes into a new version nobody reads and then moves the `idx:current` pointer (blue/green). The pointer does not move, and the workflow fails, when the run kept fewer than 50 % of the published version's games, priced none where the published version priced some, or priced fewer than 75 % of what it prices. Prices count as refreshed (`pricesUpdatedAt`) only when at least 90 % of the requested app ids got a definitive answer; a game that had a price and got none back keeps it. The version just replaced is kept whole until the next publication; older ones are deleted.

### How the site reads it

- **Read-only.** A page is answered with `SMEMBERS`, `SUNION`, `ZRANGEBYSCORE`, `ZRANGE`, `HGETALL` and `MGET`; the intersection is done in the function, so the token never needs write permission. A published version is immutable, so its sets are kept in a bounded in-process cache; the pointer is re-read at most every 60 s, and an index-served page is cached for 600 s.
- **Deadline and circuit.** Every call has 1.5 s (`DEFAULT_INDEX_TIMEOUT_MS`; the sitemap's read of all slugs has 10 s). After a failure or a timeout the process skips the index for 30 s, as it does after three consecutive answers slower than 700 ms. Every caller catches: no page fails because of the index.
- **Which path answers a catalog page.** A price ceiling, the free box, a discount floor, a Ukrainian localisation level, made in Ukraine, or a price or discount sort — the index alone, with an exact total, `indexedOnly: true`, and developers, publishers and tags reported in `ignoredFilters`. Anything else — RAWG over its whole catalog, with prices, languages and the made-in-Ukraine flag attached from the index by one read of the page's ids.
- **RAWG hedge.** When RAWG has not answered a page within 2.5 s (`RAWG_HEDGE_MS`) and the index can express the whole filter, the index answers that page instead. The overtaken RAWG request is left to finish and fill the RAWG cache (`waitUntil`), so the next request for it is answered by RAWG.
- **Staleness.** Measured on `pricesUpdatedAt`, not on the last publication: past 7 days the price filters and price sorts are dropped and named in `ignoredFilters` and no price is shown; localisation and made-in-Ukraine keep working. The game page refreshes its own price from Steam when the index copy is older than six hours.

The landing's index shelves, similar games, the game sitemaps and `/ask` retrieval ([ADR-003](003-natural-language-search.md)) read the same index.

## Alternatives considered

- **Asking Steam per request.** One price call per page would be possible; languages and app ids are one request per game, and a price filter still could not be answered — rejected.
- **Running the job on Vercel.** A full run walks 75 RAWG pages and reads languages at 40 requests a minute, about an hour; a serverless function may not run that long.
- **Resolving app ids on every run.** One RAWG request per game; 3 000 a night would exceed RAWG's free monthly quota. The mapping is permanent instead.
- **Indexing only price and language.** Every catalog filter is a facet, so an index-served page applies the whole filter with an exact total, and the index can stand in for a slow RAWG page.
- **Building the result in Redis** (`SUNIONSTORE`/`ZINTERSTORE` into temporary keys, as the design first had it). It needs write permission on the site's token; reading the sets and intersecting in the function does not.
- **A resume cursor for the candidate walk.** A run that died half way could publish an index missing its most popular games; the walk takes about twenty seconds, so every run starts from page one.
- **Interface versus subtitle localisation.** Steam's API reports only "supported" and "full audio"; anything finer means scraping store pages, which this project does not do.

## Consequences

- **Coverage.** Price, discount, localisation and made-in-Ukraine filters, the price sorts and similar games cover only the indexed games, and so does `/ask` unless the question names a title; the catalog says so under the result count. A game outside the index has no price on its card.
- **Two sources for one catalog.** Each page is decided on its own, so a hedged page 1 (index order and total) and page 2 from RAWG can repeat or skip a game and move the pager's total.
- **Staleness.** A card's price is as old as the last price run — six hours when the schedule holds; a language change takes up to a week; a studio added to the list appears after the next nightly run. If the price runs stop, prices disappear after seven days rather than going quietly wrong.
- **Free-tier budget.** The store is Upstash's free tier, so reads are spent carefully (cached sets, cached pages, one read to attach a page's prices) and the job prints its requests, commands and bytes in the run summary to be watched. A failed workflow run and that summary are the only alerting.
- **Operations.** GitHub disables scheduled workflows after sixty days without repository activity; the refresh then stops until it is re-enabled, and the staleness rule is what a visitor sees.
