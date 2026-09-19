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
