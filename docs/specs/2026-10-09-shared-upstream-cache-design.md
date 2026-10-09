# A cache of upstream answers that every instance shares

Date: 2026-10-09. Status: approved by the owner in conversation.

## Why

What RAWG and Steam answer is kept in the memory of the one function instance that asked. A new instance, a cold start or a deployment asks again, and RAWG is the slow part of a first open: measured on production on 2026-10-09, sixty first opens of game pages took 1.46 s at the median and up to 3.0 s, while the same pages asked again from the instance that had them took 0.25–0.32 s. The README lists it under Known gaps: "there is no shared response cache".

A cache at the CDN was considered first and set aside. A response cached by time is only there while a page is asked for more often than its lifetime, which this site's traffic does not do; Vercel's ISR cache is durable but belongs to one deployment — this project deploys several times a day — and serves a stale page without a bound on its age. Both hide the slow path; neither shortens it. A shared cache of the upstream answers shortens it, for server renders and client-side navigations alike, and stays useful if a page cache is added later.

## What

Vercel's Runtime Cache (`getCache()` from `@vercel/functions`, already a dependency): regional, shared by every instance of the function in its region, kept across deployments, separate for production and preview, evicted least-recently-used when full, 2 MB an item. On the Hobby plan every project of the team shares one cache, so every key is namespaced.

### 1. Two levels behind the transport's existing cache port

`createUpstreamFetch` keeps its port (`cache.get` / `cache.set` of `UpstreamCacheEntry`). Behind it, for the RAWG transport and the Steam app-details transport (`server/utils/rawg.ts`, `server/utils/steam.ts`):

- **Read.** The instance's memory first, exactly as today. On a miss there, or when memory holds only an entry past its `expiresAt`, the shared cache is asked; an entry it has is copied into memory and returned (the newer of the two wins when both exist).
- **Write.** Memory at once, as today. The shared cache is written without being awaited: the write is handed to the request's keep-alive (`server/utils/keepRunning.ts`) with a no-op catch, so it can neither delay nor fail an answer.
- **A shared read has `SHARED_CACHE_DEADLINE_MS = 150`.** Slower than that, or failing, it is a miss. After a failure the shared cache is left alone for `SHARED_CACHE_PAUSE_MS = 30_000` and one warning is logged per pause — a store that is down must cost a request one deadline, not one per upstream call.
- **How long the shared cache keeps an entry** is its own number, longer than the freshness the transport reads from `expiresAt`: the entry has to outlive its freshness to be a stale-if-error fallback, and to be served while it is refreshed (section 2). `sharedTtl = max(freshness, the request's stale window) + 1 day`, capped at 8 days.
- **Keys** are `gg-stay` (namespace) + a schema version + the transport's source + the same hash the memory cache uses. The schema version is a constant in code, with a comment: the cache outlives deployments, so any change to what is stored under a key — a projection, a new field the code relies on — must change it.
- **An entry larger than 1.5 MB serialized is not written** to the shared cache (the platform's limit is 2 MB); memory keeps it.
- **Only on Vercel.** The shared level exists when the function runs on Vercel (`process.env.VERCEL`) and not in fixture mode. Development, tests, the CI quality gates and the refresh job have memory alone, as today. Nothing in `scripts/**` changes.
- The live Steam price the game page keeps (`steam-price:` entries of the resolver cache, six hours for a price and one hour for "none") goes through the same two levels, with its own lifetimes and no stale use: an expired price is a miss, as today. Index-served catalog pages (`cache:resolvers`) stay in memory: the index is a few milliseconds away.

### 2. A game's description and screenshots may be a week old while they are refreshed

RAWG's `games/{slug}`, `games/{slug}/stores` and `games/{slug}/screenshots`, and Steam's app details, stay fresh for 24 hours as today. Past that, and up to `STALE_WHILE_REVALIDATE_SECONDS = 7 days` after they were stored, the transport answers with the stored body at once and refreshes it in the background: one refresh per key at a time (the in-flight sharing of #71), kept alive past the response, its failure logged like any attempt and otherwise silent — the stale entry stays. Past seven days it is a miss.

None of these answers carries a price: prices come from the index and from Steam's price endpoint, whose lifetimes do not change. RAWG lists (`games`), the taxonomies and Steam prices keep exactly today's lifetimes and get no stale window.

A caller can tell: the transport's "came from the cache" signal (added in #71) still says cached for a stale answer, and `Server-Timing` does not count it as a call.

### 3. `Server-Timing` names the shared cache

`cache;dur=<slowest shared read, ms>;desc="Cache <hits> of <reads>"`, present only when the request read the shared cache. Memory hits are not reads. This is how a first open served from another instance's work can be told from one that asked RAWG.

## Not in this change

Any page or response cache at the CDN; a stale window for catalog lists; storing game details in the index; the pacing of RAWG requests (a separate change follows, measured on its own).

## Constraints

- English only in code, comments, tests, commits and docs. No AI-assistant attribution anywhere.
- No behaviour change off Vercel: fixture mode, tests and the job behave byte for byte as before.
- The site never writes to Redis; this cache is Vercel's, not the index's.
- Nothing cached may contain a secret: the cache key and the stored body never include the RAWG API key or a URL that carries it.
- A partial GraphQL answer is not an upstream answer and is not stored anywhere by this change.
- `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm check:bundle-budget`, `pnpm e2e` and the Vercel-preset build with `pnpm check:vercel-headers` pass. Tests drive time with fake timers or controllable promises.

## After the merge

Measured on production, recorded in `docs/perf`: sixty game pages opened once, then the same sixty opened again after a new deployment (new instances, empty memory) — the second pass is the effect of the shared cache. The Runtime Cache panel of the project (Observability) shows reads, writes and the hit rate; the Hobby plan's included amount is not documented, so the first day's numbers are checked against it.
