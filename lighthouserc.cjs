/**
 * Lighthouse CI against the fixture-mode production build the `quality` job starts (node preset,
 * `RAWG_FIXTURES=1`). Lighthouse's default mobile profile — simulated slow 4G and a 4x CPU
 * slowdown — three runs per page, median asserted.
 *
 * These thresholds are a regression net for this build, not a statement about production: the
 * production numbers live in docs/perf/README.md. Requests that would leave the machine (RAWG's
 * image CDN, Steam's video CDN) are blocked, so the run measures the app's own HTML, CSS, fonts
 * and JavaScript, needs no network and cannot fail because a third party is slow. Image loading
 * itself is covered by the SSR tests and by the production measurements.
 *
 *   QUALITY_BASE_URL=http://localhost:3000 pnpm exec lhci autorun
 */
const base = process.env.QUALITY_BASE_URL ?? 'http://localhost:3000'
const page = (path) => new URL(path, base).href

const atLeast = (minScore) => ['error', { minScore, aggregationMethod: 'median' }]

module.exports = {
  ci: {
    collect: {
      url: [page('/'), page('/games'), page('/games/the-witcher-3-wild-hunt')],
      numberOfRuns: 3,
      settings: {
        // The runner is a throwaway container; Chrome's sandbox needs privileges it may not have.
        chromeFlags: '--no-sandbox',
        blockedUrlPatterns: [
          '*://media.rawg.io/*',
          '*://*.steamstatic.com/*',
          '*://*.akamaihd.net/*',
        ],
      },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: '.*',
          assertions: {
            'categories:accessibility': atLeast(0.95),
            'categories:best-practices': atLeast(0.95),
            'categories:seo': atLeast(0.95),
            'cumulative-layout-shift': [
              'error',
              { maxNumericValue: 0.1, aggregationMethod: 'median' },
            ],
          },
        },
        // The landing page carries the hero, the cover ring and five shelves; its bar is lower.
        {
          matchingUrlPattern: '^https?://[^/]+/$',
          assertions: { 'categories:performance': atLeast(0.7) },
        },
        { matchingUrlPattern: '/games$', assertions: { 'categories:performance': atLeast(0.85) } },
        {
          matchingUrlPattern: '/games/[^/]+$',
          assertions: { 'categories:performance': atLeast(0.85) },
        },
      ],
    },
    upload: {
      // Kept as files and uploaded by the workflow as an artifact; nothing is sent anywhere.
      target: 'filesystem',
      outputDir: '.lighthouseci/reports',
    },
  },
}
