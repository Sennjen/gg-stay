# GG Stay — Week 2C "SEO, quality gates, field metrics" design

Date: 2026-10-01
Status: approved
Scope: the last week 2 cycle.

## Goal

Search engines get correct, Ukrainian-first metadata for every page; every pull request is checked for performance, bundle size, accessibility and the main user flows; real visitors' Core Web Vitals are collected and published.

## Found on production before starting

- Every canonical and hreflang link read `https://gg-stay.vercel.app;/…` — a trailing semicolon in `NUXT_PUBLIC_SITE_URL`. Fixed in Vercel by the owner; the build will now refuse an invalid site URL.
- `sitemap.xml` and `robots.txt` answer 404. No JSON-LD. The game page's meta description is RAWG's English text even when the page shows a Ukrainian Steam description. Filtered and paginated catalog pages are indexable. The catalog title lacks the site name.

## 1. SEO

- **Site URL validation.** `nuxt.config.ts` parses the site URL: it must be an absolute `http(s)` origin with no path, query, trailing slash, whitespace or punctuation; otherwise the build fails with a clear message (development falls back to localhost as today).
- **Titles and descriptions.** Every page: `<title>` ends with "— GG Stay" (landing keeps its own); descriptions in the page's language — the game page uses the same Ukrainian Steam description the page shows when it has one, trimmed to ~160 characters on a word boundary; the catalog describes the active filters in words when there are any ("Ігри з українською озвучкою для ПК…").
- **Indexing rules.** Catalog: canonical without query string (already); `noindex, follow` when any filter or a page beyond 1 is in the URL. Error page: `noindex` (already). Game page: indexable.
- **Open Graph / Twitter.** `og:type`, `og:url` (canonical), `og:site_name`, `og:locale` (+ alternate), `og:image` with width/height (the 1280 cover variant), `twitter:card=summary_large_image`. Landing gets a static share image.
- **JSON-LD.** Game page: `VideoGame` with `name`, `url`, `image`, `description`, `datePublished`, `genre`, `gamePlatform`, `publisher`, `author` (developers), `aggregateRating` (when RAWG has ≥ 5 ratings; scale 0–5), `offers` (Steam price in UAH with `availability` and `url`, only when the index has a fresh price), `inLanguage`. Landing: `WebSite` with a `SearchAction` pointing at `/games?search={search_term_string}`. Emitted with a nonce/hash compatible with the existing CSP (JSON-LD is not executed, but `script-src` still applies — use `type="application/ld+json"` and confirm the CSP does not block or warn).
- **Sitemap.** `/sitemap.xml` as a sitemap index → `/sitemaps/static.xml` (landing, catalog, both locales) and `/sitemaps/games-<n>.xml` (≤ 5 000 URLs each) generated from the published index (`allGames`-style read through the reader; a new reader method `allSlugs()` returning `{ slug, updatedAt }` is acceptable), every URL with `xhtml:link` alternates for uk/en and `lastmod`. Cached 6 h. Index unavailable → static sitemap only.
- **robots.txt.** Allow all, disallow `/api/`, point at the sitemap.
- **SEO test** (Vitest SSR, per page type: landing, catalog plain, catalog filtered, catalog page 2, game page, 404, `/en` variants): unique title, description present and in the right language, canonical correct and absolute, hreflang pair, robots rules, OG tags, JSON-LD parses and has the required fields.

## 2. Quality gates in CI

- **Lighthouse CI** in GitHub Actions against a production build started in the job (fixture mode, node preset — Vercel previews are behind login): mobile profile, 3 runs per URL (`/`, `/games`, a game page), assertions: performance ≥ 85 on `/games` and the game page, ≥ 70 on `/`, accessibility/best-practices/SEO ≥ 95, CLS ≤ 0.1. Reports uploaded as an artifact. Thresholds are a regression net for this fixture build, not a claim about production — the production numbers stay in `docs/perf/`.
- **Bundle budget**: a script measures the gzip size of the JS the `/games` HTML loads on first visit (entry + modulepreloads) in the production build; CI fails above the budget. Budget = today's measured size + 5 %, recorded in ADR-002 (the original 120 KB target stays documented as missed).
- **Playwright smoke flows + axe** against the same local production build: (1) landing → shelf "Усі ігри" → catalog; (2) catalog → open filter drawer → apply price + localisation → result count changes → open a game; (3) game page → gallery lightbox opens/closes with keyboard; (4) locale switch uk ↔ en keeps the page. `@axe-core/playwright` on every visited page: zero serious/critical violations. Runs on every PR.

## 3. Field metrics (web-vitals)

- Client: the `web-vitals` library, loaded after hydration; LCP, INP, CLS, FCP, TTFB sent in ONE beacon on `visibilitychange`/`pagehide` (`navigator.sendBeacon`), with page type (landing/catalog/game/other), locale, device class (mobile/desktop by viewport), connection effective type; no IDs, no URLs with queries, no personal data. Sampling rate configurable (default 100 %).
- Server: `POST /api/vitals` validates strictly (known metric names, numeric ranges, payload ≤ 1 KB), rate-limits per IP in-process, and records into a **separate** Upstash database (`VITALS_REDIS_REST_URL` / `VITALS_REDIS_REST_TOKEN`; the price index keeps its read-only token): per day × metric × page type × device, a fixed-bucket histogram via one pipelined `HINCRBY` batch per beacon, keys expire after 35 days. Missing credentials → 204 and nothing stored.
- Summary: `GET /api/vitals/summary` returns p75 per metric per page type × device for the last 28 days from the histograms (cached 10 min), and README gets a "Field metrics" section linking to it with the latest numbers. Accepts no parameters.
- CSP: `connect-src 'self'` already covers the beacon.

## Work order

Three parallel PRs: SEO; CI quality gates (Lighthouse CI, bundle budget, Playwright + axe); field metrics. Each touches `nuxt.config.ts` lightly — conflicts are resolved at merge.
