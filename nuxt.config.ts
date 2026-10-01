import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { STATIC_SECURITY_HEADERS } from './server/security/headers'
import { speedInsightsDefault } from './app/utils/speedInsights'
import { PREVIEW_ROBOTS, isPreviewDeployment, parseSiteUrl } from './shared/siteUrl'

// Validated, because every canonical, hreflang, sitemap and JSON-LD URL is built on it: a malformed
// value — or none at all on a Vercel production build — fails the build here instead of shipping
// `https://host;/games` or `http://localhost:3000/games` links. See `shared/siteUrl.ts`.
const siteUrl = parseSiteUrl(process.env.NUXT_PUBLIC_SITE_URL, {
  vercelEnv: process.env.VERCEL_ENV,
  vercelUrl: process.env.VERCEL_URL,
})
// A preview deployment is a full copy of the site; it must never be indexed beside production.
const previewDeployment = isPreviewDeployment(process.env.VERCEL_ENV)

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: true },
  telemetry: false,
  modules: ['@nuxt/eslint', '@nuxt/fonts', '@nuxt/image', '@nuxtjs/i18n', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  hooks: {
    // The renderer prefetches every dynamic import of the entry on every page. The Speed Insights
    // SDK is imported after hydration and only for visitors it may measure (see
    // app/plugins/speed-insights.client.ts), so prefetching it would download it for everyone else
    // too — on every deployment where it is off, and for visitors who sent Do Not Track. The key is
    // matched by substring: if a Nuxt or bundler upgrade renames it, or the import moves out of the
    // entry, this silently stops working, and the e2e test that fetches every script a page loads,
    // preloads or prefetches (tests/e2e/ssr.test.ts) is the guard that fails.
    'build:manifest'(manifest) {
      for (const chunk of Object.values(manifest)) {
        if (!chunk.isEntry) continue
        chunk.dynamicImports = chunk.dynamicImports?.filter(
          (source) => !source.includes('@vercel/speed-insights'),
        )
      }
    },
  },
  fonts: {
    // Weights and styles are declared to match what the app actually renders, because every
    // declared combination becomes an `@font-face` block in the render-blocking stylesheet even
    // when no element ever selects it. Nothing in the app is italic, and `.font-display-heading`
    // never sets a weight (Tailwind's preflight resets headings to `font-weight: inherit`), so
    // Tektur only ever renders at 400 — the 500/600/700 faces were 9 dead blocks.
    // `cyrillic-ext` is dropped: it carries historic Slavic letters, the Abkhaz/Ossetian
    // extensions and ₴, and none of them appear in this app's copy (checked against both locale
    // files). A stray glyph from a third-party game title falls back to the system face, which is
    // what the fallback chain is for. Three fewer files in the build per family, and it leaves
    // Inter with exactly the two files a first paint needs — see `preload` below.
    defaults: { styles: ['normal'], subsets: ['latin', 'cyrillic'] },
    families: [
      // Hero headlines, section titles and the logo — see DESIGN.md.
      { name: 'Tektur', provider: 'google', weights: [400], display: 'swap' },
      // The interface face: 400 body, 500 `font-medium`, 600 `font-semibold`. Google serves one
      // variable file per subset covering every weight, so this is two files — the Latin and the
      // Cyrillic one — and both are needed above the fold on every route. They are the only fonts
      // preloaded: the display and mono faces are used further down the page and `font-display:
      // swap` already renders their text in the fallback in the meantime.
      {
        name: 'Inter',
        provider: 'google',
        weights: [400, 500, 600],
        display: 'swap',
        preload: true,
      },
      // Bare numerals. 500 is kept although no element selects it: the Metacritic badge is
      // `font-numeric font-semibold`, and CSS weight matching resolves 600 to the 500 face — with
      // 400 alone the browser would synthesise a bolder one instead, changing how it renders.
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500], display: 'swap' },
    ],
  },
  typescript: { strict: true },
  runtimeConfig: {
    rawgApiKey: process.env.RAWG_API_KEY ?? '',
    rawgFixtures: process.env.RAWG_FIXTURES ?? '',
    // The price and localisation index. Server-side only, and deliberately not under `public`:
    // even the read-only token must never reach the browser. Without both values the site serves
    // no prices — unless `rawgFixtures` is on, which is the one configuration where the in-memory
    // index seeded from the recorded fixture answers, so development and CI need no credentials.
    upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL ?? '',
    upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
    // How long one index call may take before the page gives up on it; see `withDeadline`.
    indexTimeoutMs: process.env.INDEX_TIMEOUT_MS ?? '',
    // Past this an answer counts as slow, and three slow ones in a row close the index for a
    // while; see `withCircuit`.
    indexSlowMs: process.env.INDEX_SLOW_MS ?? '',
    // Test-only: publish the seeded fixture index with old prices, so the stale banner and the
    // filters it takes away can be looked at in a browser. Read in the fixture-mode seed path
    // alone (`useGameIndex`) — it cannot affect a deployment that has real credentials.
    indexFixtureStale: process.env.INDEX_FIXTURE_STALE ?? '',
    public: {
      // Vercel Speed Insights: on for Vercel production builds only; `NUXT_PUBLIC_SPEED_INSIGHTS`
      // (0 or 1) overrides it at runtime. See app/plugins/speed-insights.client.ts.
      speedInsights: speedInsightsDefault(process.env),
      // Pages say `noindex` in their own robots meta too on a preview (`robotsFor`), so the page and
      // the header never disagree.
      previewDeployment,
    },
  },
  routeRules: {
    // Static headers only. The Content-Security-Policy is deliberately NOT here: the Vercel preset
    // compiles a routeRules header into a proxy-level entry in `.vercel/output/config.json`, and a
    // hash-free `script-src 'self'` applied there would block the scripts Nuxt inlines and leave
    // every page unhydrated in production. It is sent from `server/plugins/csp.ts` instead.
    // On a preview, `X-Robots-Tag` keeps every response — pages, sitemap, images — out of the
    // index; it is a static header, so the CDN may apply it as well.
    '/**': {
      headers: previewDeployment
        ? { ...STATIC_SECURITY_HEADERS, 'X-Robots-Tag': PREVIEW_ROBOTS }
        : STATIC_SECURITY_HEADERS,
    },
    '/': { isr: 600 },
    '/en': { isr: 600 },
  },
  image: {
    provider: 'rawg',
    providers: { rawg: { provider: '~/providers/rawg' } },
    screens: { sm: 420, md: 640, lg: 1280 },
  },
  nitro: {
    // Vercel compresses at its edge; a node-server build serves `public/` itself and, without
    // this, sends every script and stylesheet uncompressed. The quality gates in CI (Lighthouse,
    // the bundle budget's server) run a node-server build, so it gets precompressed gzip and
    // brotli copies to match what production transfers — as does a plain local `pnpm build`,
    // whose preset is node-server without `NITRO_PRESET` being set. Off for any Vercel build
    // (named, or detected on Vercel itself), so the Vercel output is unchanged.
    compressPublicAssets: !process.env.NITRO_PRESET?.startsWith('vercel') && !process.env.VERCEL,
    // graphql ships an ESM and a CJS build and picks one by export condition. Dependency tracing
    // copies only the build that the build machine's Node resolves (ESM, via "module-sync"), while
    // the serverless runtime resolves the "node" condition and fails with ERR_MODULE_NOT_FOUND on
    // graphql/index.js. Tracing the CJS entry as well makes the function work under either.
    externals: {
      traceInclude: ['node_modules/graphql/index.js'],
    },
    serverAssets: [
      {
        baseName: 'rawg-fixtures',
        dir: fileURLToPath(new URL('./tests/fixtures/rawg', import.meta.url)),
      },
      {
        baseName: 'steam-fixtures',
        dir: fileURLToPath(new URL('./tests/fixtures/steam', import.meta.url)),
      },
      {
        baseName: 'index-fixtures',
        dir: fileURLToPath(new URL('./tests/fixtures/index', import.meta.url)),
      },
    ],
  },
  i18n: {
    defaultLocale: 'uk',
    strategy: 'prefix_except_default',
    detectBrowserLanguage: false,
    baseUrl: siteUrl,
    locales: [
      { code: 'uk', language: 'uk-UA', name: 'Українська', file: 'uk.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
  },
})
