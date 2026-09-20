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

Measured 2026-09-19 after `42b237b`. One change: the first five covers stay eager (the widest grid's first row), the other fifteen get `loading="lazy"`. The eager count later dropped to two — see "JavaScript budget" below.

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

## JavaScript budget for `/games`, measured

Measured on the production build (`NITRO_PRESET=vercel pnpm build`), by taking the exact set of
modules the served `/games` HTML asks for on a cold load — the entry module plus every
`<link rel="modulepreload">` — and compressing each file. Client assets are byte-identical between
the Vercel and the node-server preset (same hashes), so the numbers hold for the deployed build.

| Chunk         | Contents                                                      |     Raw |     gzip -9 |      brotli |
| ------------- | ------------------------------------------------------------- | ------: | ----------: | ----------: |
| `Cekng0HH.js` | Vue, vue-router and the Nuxt runtime                          | 151 284 |      54 639 |      48 992 |
| `DOz5O-nJ.js` | Nuxt app entry: plugins, runtime config, i18n and Pinia setup |  85 816 |      31 438 |      28 298 |
| `CbKuCzl0.js` | Shared vendor chunk (vue-i18n runtime)                        |  68 998 |      25 317 |      22 700 |
| `BzeBBPG1.js` | Filter drawer and filter panel                                |  32 860 |       9 567 |       8 545 |
| `CJXt-VS0.js` | Header search                                                 |  10 891 |       4 302 |       3 839 |
| `DXPYVjiF.js` | Catalog page and the card components                          |  17 197 |       4 179 |       3 788 |
| `CXv6DRGq.js` | Shared card pieces (platform icons, Metacritic badge)         |   6 239 |       2 187 |       1 932 |
| `B7FXXgH6.js` | Default layout                                                |   3 685 |       1 575 |       1 409 |
| `B0wubvQC.js` | Loading / empty / error states                                |   1 740 |         993 |         863 |
| **Total**     |                                                               |         | **134 197** | **120 366** |

**131.1 KB gzipped, 117.5 KB brotli, against a 120 KB budget.** Over budget on gzip, just under it
on brotli — which is what a modern browser actually receives from Vercel, so the honest statement
is "met for most visitors, missed as stated". ADR-002 has been amended rather than the number
massaged.

What moved and what is left:

- The `graphql` printer is no longer on the critical path. It was imported statically by `useGql`,
  the header search and the developer autocomplete, so roughly 4 KB gzipped of the `graphql`
  package shipped to every page — including `/`, which issues one fixed query, and every
  server-rendered first load, where the payload is already hydrated and no client request happens.
  It is now imported inside the request path (`app/utils/printDocument.ts`): 134.8 KB → 131.1 KB gz.
- `hls.js` is not in any shared chunk and never was: it is imported dynamically by `HeroVideo`. It
  did, however, emit _two_ chunks — a `try`/`catch` around `import('hls.js/light')` with
  `import('hls.js')` as the fallback made Rollup emit the full 574 KB build as well, and the browser
  fetched both. The fallback could never have run (a missing subpath export fails the build, not the
  runtime), so the direct import removes a 574 KB download from the landing page.
- The eager cover count on `/games` dropped from five to two and the first cover now carries
  `fetchpriority="high"`; the first row of every wider layout is in the server HTML and inside the
  viewport, where `loading="lazy"` is not a deferral.
- **The remaining 111 KB gz is framework, i18n and store** — the top three chunks, before a single
  component of this app. The levers left are real but not cheap: mounting the filter drawer only
  when it opens (9.6 KB gz), and precompiling the i18n messages so the runtime compiler can be
  dropped. Neither is a change to make without a measurement of its own.

## Fonts, measured

The stylesheet declared 42 `@font-face` blocks — every family crossed with every weight, both
styles and three subsets — although nothing in the app is italic and `.font-display-heading` never
sets a weight, so Tektur only ever rendered at 400. The `cyrillic-ext` subset carries historic
Slavic letters and ₴, none of which appear in either locale file. After trimming: **12 blocks and 6
font files in the build, down from 42 and 9.**

On a cold `/games` load the browser fetches five files, 108 KB in total: Inter Latin (47 KB) and
Cyrillic (18 KB), JetBrains Mono Latin (31 KB), Tektur Latin (7 KB) and Cyrillic (5 KB). Google
serves one variable file per subset covering every weight, which is why trimming weights changed
the stylesheet but not the download.

Inter — the interface face, needed above the fold on every route — is now preloaded. Measured in a
production build, its Cyrillic file starts at 28 ms instead of 41 ms; the rest still start on
stylesheet parse, with `font-display: swap` covering the gap.
