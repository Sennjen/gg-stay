# A time budget for the game page

Date: 2026-10-06. Status: approved by the owner in conversation.

## Why

Measured on production on 2026-10-06 (one client in Europe, the `game` query as the page sends it):

- first open of a game page, 30 games: median 1.6 s, p90 3.7 s, maximum 8.6 s; six of thirty over 2.5 s;
- the same pages again, answered from the instance's memory: median 0.57 s;
- nineteen console exclusives with no Steam page show the same tail (8.6 s and 3.9 s), so the tail is RAWG, not Steam.

The cause is in `server/graphql/resolvers/game.ts`. The page asks RAWG three things (the detail, the store links, the screenshots). The transport sends them 250 ms apart (as it did then: since 2026-10-09 the site's limiter has a burst of three, `RAWG_BURST` in `server/utils/rawg.ts`, and the three leave together), gives each 5 s and one retry, and the resolver awaits all three — the two optional ones included — so one slow answer holds the page for up to 10 s. After RAWG it reads the index, then may ask Steam for a live price (5 s, one retry), and the Ukrainian description asks Steam again (5 s, one retry). Nothing bounds the whole. The catalog got its 2.5 s hedge in #66; the game page never did.

## What

The game page stops waiting for what it can do without, and for an indexed game it stops waiting for RAWG altogether after 2.5 s. Every abandoned request keeps running and fills the cache for the next reader.

### 1. The index can find a game by its slug and knows its Steam app id

- A new per-version hash, slug → id, written by the refresh job with every version (full and prices-only runs) beside the names hash, registered so `discardVersion` removes it, and read with a single `HGET`. A published version never changes, so the Upstash adapter remembers the slugs it has found in it — never the ones it has not — in its bounded in-process cache: on an instance that has looked a slug up before, it costs no request. A slug that cannot be one of the index's — empty, longer than 200 characters, or not well-formed text (`isIndexableSlug`) — is answered `null` before anything is sent, and the writer files no such slug. Read port: `idBySlug(slug: string): Promise<number | null>` on `GameIndex`, implemented by the Upstash adapter, the memory index and the deadline/circuit wrapper. A published version that has no such hash answers `null`.
- `IndexedGame.steamAppId?: string`, set by the job from the app id map it already holds in both run modes. Optional: documents written before this change simply lack it.
- The job's run summary keeps reporting true traffic numbers; say in the pull request how many commands per run this adds.

### 2. The `game` resolver

Constants (exported, used by tests): `GAME_DETAIL_HEDGE_MS = 2_500`, `GAME_EXTRAS_BUDGET_MS = 1_500`, `LIVE_PRICE_BUDGET_MS = 1_000`, `STEAM_DESCRIPTION_BUDGET_MS = 1_500`.

1. The three RAWG requests start as today, the detail first. A slug that cannot be a game's — the 200-character, well-formed rule the index files slugs by (section 1) — is answered as "no such game" before RAWG, the index or Steam is asked anything.
2. Beside them, never in front of them, the resolver asks the index for this slug: `idBySlug`, then the document. When the index is unavailable, has failed in this request, or does not know the slug, everything below that needs the document is skipped and the page behaves as described for a game outside the index. The lookup by slug is a head start, not a second source: RAWG says which game the page is about. On a page RAWG answered the game's index entry is therefore still read by the id RAWG gave, as it was before this change — in the usual case that is the very read the lookup by slug has already made — so a version published without the slug hash still gives the page its price, its languages and its similar games.
3. **The detail.** If RAWG's detail arrives within `GAME_DETAIL_HEDGE_MS`, the page is built from it as today. If it has not, and the index holds the game, the page is built from the index document (see 3) and `partial` is `true`; one `console.info` line says so (`[game] RAWG slower than 2500 ms, answered from the index`). If the index does not hold the game, the resolver keeps waiting for RAWG exactly as today, with today's errors. A RAWG failure inside the budget keeps today's behaviour for a game outside the index; for an indexed game a failed detail is answered from the index as well, `partial: true`. RAWG's "no such game" (404) is an answer, not a failure, and is passed on whatever the index holds: the index was built from RAWG's list some time ago, and RAWG is the one that knows whether the game still exists.
4. **Store links and screenshots** are used if they have settled when the page is assembled. The page waits for them only until `GAME_EXTRAS_BUDGET_MS` after the request began; later than that it is assembled without whichever is missing and `partial` is `true`; one `console.info` line names what was late (`[game] RAWG store links and screenshots slower than 1500 ms, answered without them`), so the share of such pages can be read from the log.
5. **The live Steam price** (unchanged rule for when it is needed: an index price older than six hours, or a Steam game the index has never seen). The app id comes from the index document's `steamAppId` when there is one — so the refresh can start beside the RAWG requests, which it does only when the document also lists the game on Steam: a price that would be shown nowhere is not asked for ahead of RAWG — and otherwise from RAWG's store links as today. The page waits for it at most `LIVE_PRICE_BUDGET_MS` from the moment it was started. For a game the page has an index entry for, later than that the index price stands, with its own true timestamp: not a reason for `partial`. A Steam game it has no entry for — one the index does not hold — has no price to stand in: when its live price is still on its way as the page is assembled, the page goes out with the Steam link and no price, `partial` is `true`, and the page's own second request finds the price in the cache; the `console.info` line of rule 4 names it (`[game] Steam price slower than 1000 ms, answered without it`). A price Steam answered about inside the budget — a price, "none", or a failure — leaves nothing to collect and is not a reason for `partial`. A read that fails is warned about once a request (`[game] the live Steam price could not be read: …`) and is Steam's failure, not the index's: `similar` and every later index read of the request go on.
6. **"Steam has no price for this app"** is remembered for one hour under the same cache prefix, so a delisted or regionless game stops costing every reader a Steam request (measured: +1 s on every view of such a page). One hour, not the six a live price is kept for: Steam under load sends the same answer as a soft failure for an app that does have a price, so a wrong "none" must not outlive the hour. Only Steam's own answer about the app counts; one that cannot be read — an empty or non-object body under a 200, a body with nothing readable about the app — is a failed request. A failed request is not remembered.
7. **The Ukrainian description** (`localizedDescription`, field resolver, still asked only when selected): at most `STEAM_DESCRIPTION_BUDGET_MS`, then the existing fallback to the RAWG text. Not a reason for `partial`.
8. Every request the page stopped waiting for is handed to `context.waitUntil` with a no-op catch, as in `games.ts`.
9. `similar`, `localisation` and `madeInUkraine` keep their sources; one request reads the game's index document once.

### 3. A page built from the index document

`id`, `slug`, `name`, `cover`, `released`, `rating`, `ratingsCount`, `metacritic`, `playtime`, `ageRating`, `gameModes`, `platformFamilies`, `localisation`, `madeInUkraine` from the document; `screenshots` is the document's preview image or empty; `stores` is one Steam offer when the document has `steamAppId` and lists Steam among its `stores` (`https://store.steampowered.com/app/{id}/`, price fields as `toSteamOffer` gives them), otherwise empty — the app id says which Steam app the game is, not that RAWG lists the game on Steam, and this page must never show a Steam link the RAWG-built page of the same game would not; `description`, `website` are `null`; `platforms`, `genres`, `tags`, `developers`, `publishers` are empty. Stale index prices are stripped as everywhere else.

### 4. `Game.partial: Boolean!`

`true` when this answer left out something the same query will have a few seconds later — RAWG's own answer about the game (rule 3), its store links or screenshots (rule 4), or the live Steam price of a game the index does not hold (rule 5) — and `false` otherwise. A partial answer must never be stored by a shared cache; nothing in this change caches GraphQL answers, the rule is recorded for the CDN cache planned next.

### 5. The transport shares a request already in flight

`createUpstreamFetch`: two calls for the same cache key and the same limits made while the first is still running share one upstream request. Without this, the page's own retry a few seconds after a hedged answer would start a second slow request instead of collecting the first one's answer. A failed request is not shared with later callers.

### 6. The page

`app/pages/games/[slug].vue`: when `game.partial` is true the page shows one quiet line near the top, announced politely once — uk «Частина даних ще завантажується…», en "Some of this page is still loading…" — and asks again by itself, in the browser only: 3 s after the answer, and once more 6 s after that. A full answer replaces the page content in place and removes the line. If both attempts stay partial, or fail, nothing more is asked and the line changes to a final sentence, announced once like the first — uk «Частина даних не завантажилася. Спробуйте оновити сторінку пізніше.», en "Some of this page didn't load. Try reloading it later."

The line lives in a `role="status"` region that the server and the browser's first render both leave empty; the sentence is put into it once the page is mounted. The server's HTML therefore never carries the sentence — a crawler, or a browser without scripts, keeps the partial page but does not read "still loading" as its text — and a region that is there before its words is one a screen reader announces.

Every section already renders without its data. The cover, the title and the scoreboard stay where they are; what arrives may push what is below it down. One thing arrives inside the scoreboard — the Steam price of a game the index does not hold (rule 5) — and where its cell makes the scoreboard taller, what moves depends on the screen (`DESIGN.md`, "A game page answered in part").

### 7. Where the time went

- `/api/graphql` answers carry a `Server-Timing` header: one entry per upstream this request actually called — `rawg`, `steam`, `index` — with the duration of its slowest call and the number of calls in the description (`rawg;dur=5012;desc="RAWG x3"`), plus `total`. Durations are what the request waited, limiter queue and retries included; a cached answer is not a call, and neither is an index read that sent nothing to the store — a slug the adapter remembers, a read the open circuit refused, an index that is not configured. The browser's network panel shows it under Timing for the requests the browser itself makes: a game opened by a client-side navigation, and a partial page's own retries. On a hard load the page asks inside the server render, and the header stays on that internal answer; the document carries none.
- The transport logs one `console.info` line for each attempt that times out, fails or takes 2 s or longer: source, the cache key's path (never the URL — it carries the API key), attempt number, milliseconds, outcome. This is the evidence for deciding later whether a second, parallel attempt would beat RAWG's slow answers.

## Not in this change

A shared cache at the CDN (next), a page for a game outside the index when RAWG is slow (it keeps waiting), prefetching.

## Constraints

- English only in code, comments, tests, commits and docs; Ukrainian only in `i18n/locales/uk.json`. No AI-assistant attribution anywhere.
- No change to `/games`, `/api/ask` or the landing beyond what the shared transport change implies; their tests stay green.
- The site's Redis token is read-only; the site still never writes to Redis.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:bundle-budget`, `pnpm e2e` pass; GraphQL codegen is re-run and committed.
- Tests drive time with fake timers or controllable promises, as `tests/server/indexResolvers.test.ts` does for the catalog hedge: no real waits.

## After the merge

One manual run of the refresh workflow publishes a version that carries the slug hash and the app ids; until then the page behaves as for games outside the index, with the budgets of rules 4–7 already in force.
