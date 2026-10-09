# A cache of upstream answers that every instance shares

Date: 2026-10-09. Status: approved by the owner in conversation.

## Why

What RAWG and Steam answer is kept in the memory of the one function instance that asked. A new instance, a cold start or a deployment asks again, and RAWG is the slow part of a first open: measured on production on 2026-10-09, sixty first opens of game pages took 1.46 s at the median and up to 3.0 s, while the same pages asked again from the instance that had them took 0.25–0.32 s. The README lists it under Known gaps: "there is no shared response cache".

A cache at the CDN was considered first and set aside. A response cached by time is only there while a page is asked for more often than its lifetime, which this site's traffic does not do; Vercel's ISR cache is durable but belongs to one deployment — this project deploys several times a day — and serves a stale page without a bound on its age. Both hide the slow path; neither shortens it. A shared cache of the upstream answers shortens it, for server renders and client-side navigations alike, and stays useful if a page cache is added later.

## What

Vercel's Runtime Cache (`getCache()` from `@vercel/functions`, already a dependency): regional, shared by every instance of the function in its region, kept across deployments, separate for production and preview, evicted least-recently-used when full, 2 MB an item. On the Hobby plan every project of the team shares one cache, so every key is namespaced.

### 1. Two levels behind the transport's existing cache port

`createUpstreamFetch` keeps its port (`cache.get` / `cache.set` of `UpstreamCacheEntry`). Behind it, for the RAWG transport and the Steam app-details transport (`server/utils/rawg.ts`, `server/utils/steam.ts`):

- **Which answers.** The shared level takes only an answer that is fresh for a day or longer and whose request carries nothing a visitor typed: RAWG's `games/{slug}`, `games/{slug}/stores` and `games/{slug}/screenshots` (and a game's other sub-paths, such as `movies`), the taxonomies when asked without `search`, any RAWG list asked with a lifetime of a day or more and no `search` (the landing's), Steam's app details, and the live price (below). A RAWG list with the ten-minute lifetime, and every request that carries `search` — the catalog's search, the header's suggestions, the developer filter's autocomplete — stay in the instance's memory alone, exactly as before this change. The reason is cost. The Runtime Cache is metered, a write costs ten times a read, and what the Hobby plan includes is not documented. A ten-minute list is the largest body there is and is stale before another instance has much chance to want it; a typed term has a key space nobody bounds, each key of it read once, written once and almost never asked for again; and when the store fills, least-recently-used eviction would take the game pages this cache exists for before the lists. The rule is one function (`isShareable` in `server/upstream/createUpstreamFetch.ts`), decided per request where its ttl is known and told to the cache with every read and write.
- **Read.** The instance's memory first, exactly as today. On a miss there, or when memory holds only an entry past its `expiresAt`, the shared cache is asked; an entry it has is copied into memory and returned (the newer of the two wins when both exist).
- **Write.** Memory at once, as today. The shared cache is written without being awaited: the write is handed to the request's keep-alive (`server/utils/keepRunning.ts`) with its failure caught, so it can neither delay nor fail an answer. A write that fails does not pause the shared cache — a quota can refuse writes while reads still work — but it is logged: one warning per `SHARED_CACHE_PAUSE_MS` per process, so that it is never silent.
- **Requests still go out in the order they were asked for.** The transport spaces its requests, and a caller sends first what it needs most: the game page asks for the game before its store links and its screenshots. Three reads of a shared cache come back in any order, so a call takes its place in the limiter's line the moment it is made, before its cache is read, and gives the place up when a cache answers; a call that has to ask its upstream waits for the calls made before it to have decided. The reads themselves are not queued: they are all out at once.
- **A shared read has `SHARED_CACHE_DEADLINE_MS = 150`.** Slower than that, or failing, it is a miss. After a failure the shared cache is left alone for `SHARED_CACHE_PAUSE_MS = 30_000` and one warning is logged per pause — a store that is down must cost a request one deadline, not one per upstream call.
- **How long the shared cache keeps an entry** is its own number, longer than the freshness the transport reads from `expiresAt`: the entry has to outlive its freshness to be a stale-if-error fallback, and to be served while it is refreshed (section 2). `sharedTtl = max(freshness, the request's stale window) + 1 day`, capped at 8 days.
- **Keys** are `gg-stay` (namespace) + a schema version + the transport's source + the same hash the memory cache uses. The schema version is a constant in code, with a comment: the cache outlives deployments, so any change to what is stored under a key — a projection, a new field the code relies on — must change it.
- **No body is kept with RAWG's pagination links as RAWG sent them.** A RAWG list ends in `next` and `previous`, the request's own address with another page number, so each repeats every parameter of the request: the API key, and a visitor's search. The site cuts both to the address without its query before the transport sees the body (`withoutLinkQueries`, applied in `server/utils/rawg.ts`), so neither the instance's memory nor the shared cache holds them; the one reader of `next` only tests whether it is there. The refresh job's own wiring is not touched. The schema version went to `v2` with this: entries a preview wrote before it are never read again, and age out within eight days.
- **An entry larger than 1.5 MB serialized is not written** to the shared cache (the platform's limit is 2 MB); memory keeps it.
- **Only on Vercel.** The shared level exists when the function runs on Vercel (`process.env.VERCEL`) and not in fixture mode. Development, tests, the CI quality gates and the refresh job have memory alone, as today. Nothing in `scripts/**` changes.
- The live Steam price the game page keeps (`steam-price:` entries of the resolver cache, six hours for a price and one hour for "none") goes through the same two levels, with its own lifetimes and no stale use: an expired price is a miss, as today. Index-served catalog pages (`cache:resolvers`) stay in memory: the index is a few milliseconds away.

### 2. What RAWG says about a game may be a week old while it is refreshed

RAWG's `games/{slug}`, `games/{slug}/stores` and `games/{slug}/screenshots` stay fresh for 24 hours as today. Past that, and up to `STALE_WHILE_REVALIDATE_SECONDS = 7 days` after they were stored, the transport answers with the stored body at once and refreshes it in the background: one refresh per key at a time (the in-flight sharing of #71), kept alive past the response, its failure logged like any attempt and otherwise silent — the stale entry stays. Past seven days it is a miss.

A refresh is not started while the limiter is backed up by more than two seconds (`REFRESH_BACKLOG_LIMIT_MS = 2_000`). It is the one request in the limiter's line that nobody is waiting for, and the only optional one — the entry it would replace can be served for days yet — but it takes a slot like any other, and stale answers are handed over in milliseconds: a walk over stale pages queues refreshes far faster than the limiter lets them out. Twelve stale game pages asked for at once left thirty-six refreshes and put a cold page's first request nine seconds away, past the 2.5 s the game page gives RAWG; forty such views filled the function's thirty seconds. With the bound a visitor's request has two seconds of refreshes in front of it at the most, and no refresh outlives by much the answer that set it off. The refresh that was not started leaves the entry as it is, and the next view of it tries again. A refresh stands at the end of the line, behind every call made before its answer was handed over.

None of these answers carries a price: prices come from the index and from Steam's price endpoint, whose lifetimes do not change. RAWG lists (`games`), the taxonomies, Steam's app details and Steam prices keep exactly today's lifetimes and get no stale window.

Steam's app details are left out on purpose. The response that carries the Ukrainian description also carries the trailer's address, which Steam signs for a time it does not document: a copy served a week after it was stored may hold a trailer that no longer plays. So they stay fresh for 24 hours and are then a miss, with the stored copy only the stale-if-error fallback it is today. They still go through both cache levels (section 1), so one instance's request spares the others for that day.

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

What the panel should show, per request, so that the first day has something to be compared with. A game page in Ukrainian asks RAWG three things, Steam for its page about the app and, when the index price is older than six hours or missing, Steam for the live price; an English page does not ask for Steam's page.

| Request                                                                        | Shared reads                                                                                                            | Shared writes                                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A game page, first open anywhere                                               | up to 5                                                                                                                 | up to 5, one per upstream answer                                                 |
| The same instance again, inside the lifetimes                                  | 0                                                                                                                       | 0                                                                                |
| A new instance, entries fresh                                                  | up to 5                                                                                                                 | 0                                                                                |
| A new instance, RAWG's entries 1–7 days old                                    | up to 5                                                                                                                 | 3 behind the answer, plus Steam's page and the price, which were asked for again |
| The same instance, memory expired, the refresh not landed yet                  | 3 per view                                                                                                              | 3 per refresh                                                                    |
| A slug RAWG does not know                                                      | 3, every time: a 404 stores nothing                                                                                     | 0                                                                                |
| A catalog page RAWG answers                                                    | 0 for the list; the taxonomies (`genres`, `platforms`) once per instance                                                | 0 for the list; a taxonomy once a week                                           |
| A catalog page the index answers                                               | 0                                                                                                                       | 0                                                                                |
| A search term: the catalog's, the header's suggestions, the developer filter's | 0                                                                                                                       | 0                                                                                |
| The landing page (rendered every ten minutes at most)                          | about 7 on a new instance: four day-long lists, the featured game's clips and store links, Steam's page for its trailer | each of them once a day                                                          |
| `/api/ask`                                                                     | `genres`, once per instance                                                                                             | `genres`, once a week                                                            |

A crawler's pass over the sitemap's 6 500 game pages — some 3 270 games in two languages — is about 23 000 reads: three for every page and Steam's page for the Ukrainian half, with the live price only where the index's is older than six hours. A first pass writes about 13 000 entries, three RAWG answers and Steam's page for each game, and so does any pass more than a day after the last, when all of them are asked for again (RAWG's behind the answer). An instance's memory of 500 entries does not help a walk. A catalog walk and a search cost the shared cache nothing.
