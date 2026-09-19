# Performance measurements

Lighthouse, mobile profile (simulated slow 4G, 4x CPU slowdown), run against production at https://gg-stay.vercel.app. Three runs per page; the table shows the median run, and the saved report is that run.

## Baseline — end of week 1

Measured 2026-09-19 on commit `4553413`, before any performance work. Pages are server-rendered with explicit image dimensions and nothing else: no lazy loading, no `fetchpriority`, no preloading, no code splitting.

| Page                             | Performance | LCP   | FCP   | CLS | TBT   | Accessibility | Best practices | SEO |
| -------------------------------- | ----------- | ----- | ----- | --- | ----- | ------------- | -------------- | --- |
| `/games/the-witcher-3-wild-hunt` | 95          | 2.4 s | 1.6 s | 0   | 4 ms  | 100           | 100            | 100 |
| `/games` (catalog, 20 cards)     | 77          | 5.5 s | 1.6 s | 0   | 31 ms | 98            | 100            | 100 |

Individual runs — detail: 95 / 95 / 99 (LCP 2.5 / 2.4 / 0.9 s); catalog: 96 / 77 / 77 (LCP 2.7 / 5.5 / 5.5 s).

Reports: [detail](baseline-week1/detail.report.html), [catalog](baseline-week1/catalog.report.html).

### What the catalog report shows

- The page transfers about 3.4 MB, of which 3.3 MB is 20 cover images — 165 KB each on average, up to 304 KB.
- Every card requests the 1280 px variant. The `srcset` offers 420 px and, for 2x screens, 840 px; the image provider rounds 840 up to the next size the RAWG CDN serves, which is 1280. A 420 px slot on a 2x phone downloads a 1280 px image.
- All 20 images load eagerly, including the ones far below the fold, and compete with the LCP image for bandwidth.
- JavaScript transfer is 129 KB, slightly over the 120 KB budget set for this page.

These are the inputs for week 2. Each optimisation lands as its own commit with a before/after measurement added to this file.

## Step 1 — right-sized cover images

Measured 2026-09-19 after `238ce0e`. One change: the image provider picks the smallest RAWG CDN size that covers at least 75 % of the requested width, so a 2x request for 840 px resolves to 640 px instead of 1280 px.

| Catalog `/games` | Before | After   |
| ---------------- | ------ | ------- |
| Performance      | 77     | 89      |
| LCP              | 5.5 s  | 3.3 s   |
| Page weight      | 3.4 MB | 1.1 MB  |
| Images           | 3.3 MB | 0.99 MB |
| CLS              | 0      | 0       |

Individual runs: 88 / 95 / 89 (LCP 3.4 / 2.8 / 3.3 s). Report: [catalog](step1-image-size/catalog.report.html).

## Step 2 — lazy-loaded covers below the first row

Measured 2026-09-19 after `42b237b`. One change: the first four covers stay eager, the other sixteen get `loading="lazy"`.

| Catalog `/games` | Before | After  |
| ---------------- | ------ | ------ |
| Performance      | 89     | 96     |
| LCP              | 3.3 s  | 2.4 s  |
| TBT              | 52 ms  | 20 ms  |
| Page weight      | 1.1 MB | 1.1 MB |
| CLS              | 0      | 0      |

Individual runs: 96 / 90 / 98 (LCP 2.0 / 3.2 / 2.4 s). Report: [catalog](step2-lazy-covers/catalog.report.html).

Page weight did not change in the lab run: Lighthouse's tall emulated viewport and the browser's generous lazy-loading distance still fetch all twenty covers. The gain comes from priority — lazy images no longer compete with the first row, so the LCP image arrives about a second earlier. On a real phone, covers far below the fold are not requested until the user scrolls.

## Summary so far

| Catalog `/games` | Baseline | Step 1 | Step 2 |
| ---------------- | -------- | ------ | ------ |
| Performance      | 77       | 89     | 96     |
| LCP              | 5.5 s    | 3.3 s  | 2.4 s  |
| Page weight      | 3.4 MB   | 1.1 MB | 1.1 MB |

## After the redesign — a regression, measured

Measured 2026-09-19 on commit `4caa0c4`: the full visual redesign (landing page with a Steam trailer and the cover ring, self-hosted fonts, new cards, filter drawer, header search, game page with a gallery). Same method: Lighthouse mobile, three runs per page on production, median reported.

| Page            | Performance | LCP   | CLS | TBT    | Page weight | Accessibility | Best practices | SEO |
| --------------- | ----------- | ----- | --- | ------ | ----------- | ------------- | -------------- | --- |
| `/` (landing)   | 69          | 7.5 s | 0   | 121 ms | 7.2 MB      | 100           | 100            | 100 |
| `/games`        | 83          | 4.2 s | 0   | 26 ms  | 1.3 MB      | 100           | 100            | 100 |
| `/games/[slug]` | 86          | 3.5 s | 0   | 19 ms  | 0.5 MB      | 100           | 100            | 100 |

Individual runs — landing: 63 / 69 / 69; catalog: 83 / 81 / 89; game page: 93 / 86 / 85. Reports: [landing](after-redesign/home.report.html), [catalog](after-redesign/catalog.report.html), [game page](after-redesign/detail.report.html).

The catalog dropped from 96 to 83 and the game page from 95 to 86; accessibility went up to 100 on every page and layout shift stayed at zero. What the reports show:

- **Landing: the trailer is the problem on phones.** 5.9 MB of the 7.2 MB is HLS video segments, fetched on an emulated slow 4G phone, and Lighthouse picks the `<video>` as the LCP element at 7.5 s — the poster paints early, then the video's first frame replaces it as the largest paint. The video is deferred until idle and capped at 720p, but it should not load at all on small screens or slow connections.
- **Catalog: the LCP cover has no fetch priority.** The first card's image is discoverable and eager but competes with four other eager covers, 118 KB of fonts and 153 KB of JavaScript (129 KB before the redesign; the budget for this page is 120 KB).
- **Every page** now loads three font families (118 KB) and has about 0.5–0.75 s of render-blocking CSS in the simulated profile.

These are the inputs for the next optimisation steps; each will land as its own commit with a measurement here.
