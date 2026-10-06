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

## Step 3 — no trailer on phones, prioritised cover, fewer fonts, valid image sizes

Measured 2026-09-20 on commit `4072111`. Same method. Changes since the regression above: the hero trailer is not created below 768 px, on connections slower than 4G or with Save-Data; the first catalog cover has `fetchpriority="high"` and only two covers load eagerly; only the font faces that render are shipped and only the interface face is preloaded; image `sizes` are written in the syntax `@nuxt/image` expects, so the emitted `srcset` is valid; card queries select only rendered fields; the GraphQL printer is loaded on demand.

| Page            | Performance | LCP   | CLS | TBT   | Page weight | Accessibility | Best practices | SEO |
| --------------- | ----------- | ----- | --- | ----- | ----------- | ------------- | -------------- | --- |
| `/` (landing)   | 82          | 4.1 s | 0   | 70 ms | 0.8 MB      | 100           | 100            | 100 |
| `/games`        | 98          | 2.3 s | 0   | 30 ms | 0.75 MB     | 100           | 100            | 100 |
| `/games/[slug]` | 93          | 2.9 s | 0   | 20 ms | 0.5 MB      | 100           | 100            | 100 |

Individual runs — landing: 82 / 82 / 79; catalog: 98 / 98 / 90; game page: 95 / 92 / 93. Reports: [landing](step3-after-fixes/home.report.html), [catalog](step3-after-fixes/catalog.report.html), [game page](step3-after-fixes/detail.report.html).

| Page      | After redesign      | Step 3              |
| --------- | ------------------- | ------------------- |
| Landing   | 69 / 7.5 s / 7.2 MB | 82 / 4.1 s / 0.8 MB |
| Catalog   | 83 / 4.2 s          | 98 / 2.3 s          |
| Game page | 86 / 3.5 s          | 93 / 2.9 s          |

The catalog is now faster than it was before the redesign (96). The landing page is still the slowest, and the report says why: the hero poster is requested through a `<link rel="preload">` that carries no `fetchpriority`, so Chrome fetches the LCP image at **Low** priority, and the LCP breakdown shows 1.1 s of resource load delay plus 0.9 s of render delay. That is the next step.

## Step 4 — hero preload at high priority: fixed, and not the bottleneck

Measured 2026-09-20 on commit `cffb751`, landing page only. One change: the hero poster's `<link rel="preload">` now carries `fetchpriority="high"`.

| Landing | Performance  | LCP (simulated)   | LCP (observed, unthrottled) | Hero request priority |
| ------- | ------------ | ----------------- | --------------------------- | --------------------- |
| Step 3  | 82 / 82 / 79 | 4.1 / 4.1 / 4.9 s | 2.39 / 2.32 s               | Low                   |
| Step 4  | 80 / 79 / 80 | 4.6 / 4.9 / 4.5 s | 1.53 / 1.44 / 2.33 s        | High                  |

Report: [landing](step4-hero-preload/home.report.html).

The request priority is fixed and the unthrottled paint came earlier in two runs out of three, but the score did not move: the difference between 82 and 80 is run-to-run noise. Lighthouse's simulated LCP is a model of the whole dependency chain on a slow phone, and in that model the poster was never waiting on bandwidth — it is 45 KB and arrives with the first wave of requests either way. The breakdown is the same in both steps: about 1.1 s of load delay and 0.9 s of render delay, which is the render-blocking stylesheet plus main-thread work during hydration on a 4x-slowed CPU.

The change stays: a Low-priority LCP image is wrong regardless of what the model says, and it is one attribute. The landing page's remaining cost is first render, not the image; that is where the next step would go (the 9 KB blocking stylesheet and the amount of JavaScript evaluated before first paint).

## Step 5 — after the price index went live

Measured 2026-09-30 on commit `4d6289d`, ten days after hryvnia prices, discount chips and localisation badges reached the cards and the game page (a Redis index of 3 000 games, read with a 1.5 s deadline, beside the RAWG request). Same method, plus one new page: a catalog query answered entirely from the index.

| Page                                    | Performance | LCP   | CLS   | TBT   | Page weight | Accessibility | Best practices | SEO |
| --------------------------------------- | ----------- | ----- | ----- | ----- | ----------- | ------------- | -------------- | --- |
| `/` (landing)                           | 80          | 5.2 s | 0     | 80 ms | 0.8 MB      | 100           | 100            | 100 |
| `/games`                                | 97          | 2.4 s | 0     | 20 ms | 0.76 MB     | 100           | 100            | 100 |
| `/games/[slug]`                         | 92          | 2.9 s | 0.001 | 20 ms | 0.5 MB      | 100           | 100            | 100 |
| `/games?priceMaxUah=600&sort=PRICE_ASC` | 91          | 3.0 s | 0     | 0 ms  | 0.78 MB     | 100           | 100            | 100 |

Individual runs — landing: 68 / 81 / 80; catalog: 84 / 97 / 97; game page: 92 / 85 / 92; indexed catalog: 95 / 90 / 91. Reports: [landing](step5-price-index/home.report.html), [catalog](step5-price-index/catalog.report.html), [game page](step5-price-index/detail.report.html), [indexed catalog](step5-price-index/catalog-indexed.report.html).

The price layer cost nothing measurable: every page is within run-to-run noise of step 4, and page weight did not move (the price line is a few hundred bytes of HTML per card; no new JavaScript on the default catalog). Server response time stayed at 30–40 ms on cached pages; one cold game page answered in 274 ms, which includes the live Steam price refresh. The page served entirely from the index scores 91 — slightly below the RAWG-served catalog because its first cover comes from a different, uncached set of images.

## Step 6 — end of week 3

Measured 2026-10-05 on commit `21bc902`, after the landing shelves, similar games, the SEO work, Speed Insights and natural-language search had all shipped. Same method and the same tool versions as step 5 (Lighthouse 13.5.0, headless Chrome 154), plus one new page: `/ask` in its idle state, before a question is asked.

| Page                                    | Performance | LCP   | CLS   | TBT   | Page weight | Accessibility | Best practices | SEO |
| --------------------------------------- | ----------- | ----- | ----- | ----- | ----------- | ------------- | -------------- | --- |
| `/` (landing)                           | 92          | 3.2 s | 0     | 80 ms | 1.40 MB     | 100           | 100            | 100 |
| `/games`                                | 95          | 2.7 s | 0     | 20 ms | 0.78 MB     | 100           | 100            | 100 |
| `/games/[slug]`                         | 93          | 2.9 s | 0.001 | 30 ms | 0.71 MB     | 100           | 100            | 100 |
| `/games?priceMaxUah=600&sort=PRICE_ASC` | 94          | 2.8 s | 0     | 10 ms | 0.81 MB     | 100           | 100            | 69  |
| `/ask`                                  | 99          | 1.7 s | 0     | 0 ms  | 0.31 MB     | 100           | 100            | 100 |

Individual runs — landing: 91 / 92 / 93 (LCP 2.8 / 3.2 / 3.1 s); catalog: 89 / 95 / 97 (LCP 3.6 / 2.7 / 2.5 s); game page: 92 / 93 / 97 (LCP 3.3 / 2.9 / 2.5 s); indexed catalog: 96 / 94 / 87 (LCP 2.5 / 2.8 / 3.6 s); ask: 96 / 99 / 99 (LCP 2.3 / 1.7 / 1.8 s). Reports: [landing](step6-week3-close/home.report.html), [catalog](step6-week3-close/catalog.report.html), [game page](step6-week3-close/detail.report.html), [indexed catalog](step6-week3-close/catalog-indexed.report.html), [ask](step6-week3-close/ask.report.html).

The catalog, the game page and the indexed catalog are within run-to-run noise of step 5 (97, 92 and 91 there); single runs on those pages still spread by up to nine points. The landing is not within noise: all three runs scored 91–93 against 68 / 81 / 80 in step 5, with a simulated LCP of 3.2 s instead of 5.2 s, although the page got heavier — 1.40 MB against 0.8 MB, nearly all of the difference in images, since five shelves replaced the two rows after step 5. In every run of this step the LCP element is the hero poster; in step 5's median run it was a 420 px card cover. Which change moved it was not isolated, so this is recorded as a measurement, not as the result of an optimisation.

Two other differences are real and expected. The indexed catalog's SEO score is 69 because a filtered catalog page has been `noindex, follow` since the SEO work, and Lighthouse counts a page that blocks indexing as failing `is-crawlable`; that is the intended behaviour, not a regression. The game page grew from 0.5 MB to 0.71 MB, again in images: it now carries a row of similar games. Script transfer in these runs is about 176 KB on every page against 158 KB in step 5, which includes the Speed Insights script that only a measured visitor downloads. Server response time was 30–40 ms in fourteen of the fifteen runs and 119 ms in one.

### Catalog response time

Lighthouse does not show what a visitor waits for on a catalog page RAWG has not answered before. That was measured separately: the GraphQL `games` query against production, wall-clock time from one client.

- **2026-10-02, before #66.** A page whose RAWG response was not cached took 2.7–10.4 s: `genres=shooter&yearFrom=2010` 7.0 s, `genres=shooter&yearFrom=2010&yearTo=2015` 10.4 s — RAWG's 5 s timeout plus one retry. The same pages from the cache took 0.5 s. A cold function start adds 3–4.7 s to any page.
- **#66.** RAWG gets 2.5 s (`RAWG_HEDGE_MS`); after that the index answers the page if it can express the filter, and the overtaken RAWG request finishes in the background and fills the cache.
- **2026-10-05, after #66.** 13 uncached filter combinations answered in 0.6–1.7 s, all of them by RAWG. RAWG was fast that day, so the hedge did not fire in production during the measurement. It is covered by tests only (`tests/server/indexResolvers.test.ts`); its effect on a slow RAWG page has not been observed on the live site.

## Step 7 — after the mascot

Measured 2026-10-06 on commit `a7ba405`, the day Gege reached production: a still face in the header on every page, a greeter on the landing page (client-only, mounted after hydration, rises two seconds later) and a redesigned `/ask`. Same method and the same tool versions as step 6 (Lighthouse 13.5.0, headless Chrome 154), the two pages the change touches.

| Page          | Performance | LCP   | CLS | TBT   | Page weight | Accessibility | Best practices | SEO |
| ------------- | ----------- | ----- | --- | ----- | ----------- | ------------- | -------------- | --- |
| `/` (landing) | 83          | 4.1 s | 0   | 50 ms | 1.41 MB     | 100           | 100            | 100 |
| `/ask`        | 96          | 2.3 s | 0   | 0 ms  | 0.32 MB     | 100           | 100            | 100 |

Individual runs — landing: 83 / 80 / 91 (LCP 4.1 / 4.5 / 3.2 s); ask: 99 / 96 / 95 (LCP 1.7 / 2.3 / 2.4 s). Reports: [landing](step7-after-mascot/home.report.html), [ask](step7-after-mascot/ask.report.html). A second set of three landing runs, taken minutes later to see how stable the first was: 80 / 78 / 91 (LCP 4.6 / 4.6 / 3.3 s).

Against step 6 the landing median is nine points lower (92 → 83) with LCP at 4.1 s instead of 3.2 s, which is outside the 91–93 spread of that step. `/ask` went from 99 to 96 and from 1.7 s to 2.3 s; step 6's own runs were 96 / 99 / 99, so that is inside its spread, though all three runs sit at its low end.

What the mascot itself costs is in the reports, and it is small:

- **Transfer, landing.** Scripts 175.6 → 184.1 KB (18 → 21 requests), stylesheets 11.3 → 14.1 KB (4 → 7), the document 15.4 → 16.5 KB; 16 KB more in total.
- **Before first paint.** One more render-blocking stylesheet, `GegeMascot.css` (0.65 KB, for the header face, so on every page), and 0.5 KB more in `entry.css`. Ten modules are preloaded in the first wave instead of nine; modules do not block rendering.
- **The greeter.** Its chunk (4.4 KB), its stylesheet (1.1 KB) and its one `dealOfTheDay` request are all sent after the load event, as designed.
- **Main thread and layout.** TBT 50 ms (80 ms in step 6), CLS 0. The LCP element is still the hero poster, still requested at High priority with the first wave.

None of that explains nine points, and the runs say where they went. The six landing runs fall into two groups that download and execute the same things. In the two that scored 91 the page painted 0.5 s after the navigation started (observed, unthrottled: 483 and 478 ms) and the result is step 6's: 91, LCP 3.2–3.3 s. In the four that scored 78–83 the requests and the main-thread work are the same, and the load event comes at 0.7–1.3 s — but the first frame was presented at 1.5 s in three runs and at 2.5 s in one, after the load event, with the main thread idle. A trace of such a run on `/ask` shows the compositor reporting a dropped frame at every vsync from the moment the document committed, and no main-thread frame requested until 1.47 s, half a second after hydration had finished. Lighthouse builds its simulated FCP and LCP on the observed paint, so a late frame costs 0.3–0.6 s of FCP and 0.8–1.4 s of LCP in the model.

The same late frame is in step 6's raw runs, before the mascot existed: `/ask` run 1 (first paint at 1 497 ms with the load event at 652 ms — it scored 96 with LCP 2.3 s, exactly today's median) and the indexed catalog's run 3 (1 510 ms against 564 ms, the 87 in that step). That was 2 runs in 15. Today it was 4 of 6 on the landing, 5 of 6 on `/ask` (two of the three above and three more taken for the trace) and 1 of 4 on `/games`, measured as a control at 93 / 94 / 90 / 92. Ten of those twelve late frames landed between 1.49 and 1.53 s after the navigation started, whatever the load time (0.56–1.25 s), which points at a timer in the browser rather than at work in the page. It did not appear in five runs against a trivial control page, or in six runs against a local production build of this same commit (node-server preset, fixture data; first paint at 45–76 ms).

So this step records a lower landing median and does not attribute it to the mascot: the mascot's measured cost is 16 KB and one 0.65 KB stylesheet, and the points were lost to a late first frame that predates it. It does not clear the mascot either — the late frame was far more frequent than on 2026-10-05 and its cause was not established, so "more frequent because of the change" is not excluded by anything here. Nothing was changed in the page. The honest reading of the table is "91 with LCP 3.2 s when the first frame is on time, as in step 6; 78–83 when it is not".

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

## The budget in CI

Measured 2026-10-01 on the fixture-mode production build (`NITRO_PRESET=node-server`, the build
the CI quality gates serve), with the same method: the `/games` HTML's entry module plus every
`<link rel="modulepreload">`, each file compressed at gzip level 9 (Node's zlib, which comes out a
few hundred bytes above `gzip -9` on the same files). The file names are this build's: the entry
chunk carries the build-time site URL, so its hash (and a few bytes) differ from build to build.

| Chunk         | Contents (roughly)                                              |     Raw | gzip -9 (zlib) |
| ------------- | --------------------------------------------------------------- | ------: | -------------: |
| `Cekng0HH.js` | Vue, vue-router and the Nuxt runtime                            | 151 284 |         54 771 |
| `CI_eMhvL.js` | Nuxt app entry: plugins, runtime config, i18n and Pinia setup   |  85 910 |         31 481 |
| `Kun-GnWH.js` | Shared vendor chunk (vue-i18n runtime)                          |  68 998 |         25 331 |
| `DXbnfhkA.js` | Catalog page, filter drawer and filter panel                    |  43 084 |         11 937 |
| `CTUlQ6Bv.js` | Game card                                                       |  12 756 |          4 409 |
| `ZGwyw13W.js` | Default layout and header search                                |  11 083 |          4 396 |
| `ByVzPUUs.js` | Shared card pieces (platforms, Metacritic, price, localisation) |  20 932 |          4 325 |
| `BjKjnDbI.js` | Loading / empty / error states                                  |   1 959 |          1 095 |
| **Total**     |                                                                 | 396 006 |    **137 745** |

**137 745 bytes (134.5 KiB) gzipped**, up from 131.1 KB in the measurement above: week 2 added
prices, discount chips, localisation badges, the made-in-Ukraine filter and the price and
localisation sections of the drawer. The framework chunks did not move; the growth is the
catalog's own components.

`pnpm check:bundle-budget` repeats this measurement against a running production build and fails
above **144 633 bytes (141.2 KiB)** — today's size plus 5 %. It runs in the `quality` job of CI on
every pull request, beside Lighthouse CI and the Playwright flows (below). The 120 KB target in
ADR-002 is still missed and still recorded there; this number only stops further drift.

The Vercel Speed Insights loader (#52) adds about 0.4 KB gzip to the `/games` first load, inside
the 5 % headroom.

Re-measured 2026-10-05 on commit `21bc902` with the same build and command: **140 974 bytes
(137.7 KiB) gzipped** over eleven modules, 3 229 bytes above the 2026-10-01 measurement and 3 659
bytes under the budget. The budget itself has not been raised.

## Quality gates in CI

Every pull request builds the app once more with the node preset in fixture mode, starts it in the
job, and runs three gates against it:

- **Bundle budget** — the measurement above.
- **Playwright smoke flows with axe** (`pnpm e2e`): landing → a shelf's "Усі ігри" → catalog;
  catalog → filter drawer → price and localisation change the count → a game; the screenshot
  lightbox opened, paged and closed from the keyboard; the locale switch keeping the page. axe runs
  on every page and dialog state and fails on any moderate, serious or critical violation (the spec
  asks for serious and critical; no moderate finding remains, so moderate is held too); any console
  error fails a flow. Screenshots and traces of a failure are uploaded as an artifact.
- **Lighthouse CI** (`lighthouserc.cjs`): mobile profile, three runs per page, median asserted —
  performance ≥ 85 on `/games`, ≥ 80 on the game page and ≥ 70 on `/`; accessibility, best
  practices and SEO ≥ 95; CLS ≤ 0.1. Reports are uploaded as an artifact.

These thresholds are a regression net for this fixture build, not a claim about production — the
production numbers are the tables above. They run on shared CI runners, where ±5 points between
runs is normal noise; the game page measured 89 locally, so its bar is 80 rather than 85, which
would flap on noise without catching anything more. Requests that would leave the runner are blocked in both
browsers: Lighthouse refuses RAWG's image CDN and Steam's video CDN, and the Playwright flows answer
RAWG images with a local placeholder. The gates need no secrets and no network, and a slow third
party cannot fail them; image loading is covered by the SSR tests and the production runs here.

A node-server build serves its own static files, so it precompresses them (gzip and brotli) to
transfer what Vercel's edge transfers; the Vercel build is unchanged. Measured locally on
2026-10-01 against this build, the medians were:

| Page            | Performance | LCP   | CLS | TBT   | Accessibility | Best practices | SEO |
| --------------- | ----------- | ----- | --- | ----- | ------------- | -------------- | --- |
| `/` (landing)   | 82          | 4.0 s | 0   | 40 ms | 100           | 100            | 100 |
| `/games`        | 92          | 2.7 s | 0   | 0 ms  | 100           | 100            | 100 |
| `/games/[slug]` | 89          | 3.2 s | 0   | 10 ms | 100           | 100            | 100 |

Running the gates surfaced two real defects. First, `<NuxtImg>` renders an inline
`onerror="this.setAttribute('data-error', 1)"` on every server-rendered image, and the page's CSP
blocked it — a CSP violation in the console for every image that failed to load, which would have
cost best practices in production whenever RAWG lost a cover. The page policy now allows exactly
that handler body (`'unsafe-hashes'` plus its sha256); any other inline handler is still blocked.

Second, axe flagged `landmark-unique` (moderate) on every page: the header and the footer each held
a navigation landmark named "Мова", indistinguishable in a screen reader's landmark list. The
footer's is now "Мова сайту (внизу сторінки)" / "Site language (footer)", which leaves no axe
finding of any impact on the visited pages.

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
