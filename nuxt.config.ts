import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { STATIC_SECURITY_HEADERS } from './server/security/headers'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: true },
  telemetry: false,
  modules: ['@nuxt/eslint', '@nuxt/fonts', '@nuxt/image', '@nuxtjs/i18n', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
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
  },
  routeRules: {
    // Static headers only. The Content-Security-Policy is deliberately NOT here: the Vercel preset
    // compiles a routeRules header into a proxy-level entry in `.vercel/output/config.json`, and a
    // hash-free `script-src 'self'` applied there would block the scripts Nuxt inlines and leave
    // every page unhydrated in production. It is sent from `server/plugins/csp.ts` instead.
    '/**': { headers: STATIC_SECURITY_HEADERS },
    '/': { isr: 600 },
    '/en': { isr: 600 },
  },
  image: {
    provider: 'rawg',
    providers: { rawg: { provider: '~/providers/rawg' } },
    screens: { sm: 420, md: 640, lg: 1280 },
  },
  nitro: {
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
    baseUrl: process.env.NUXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
    locales: [
      { code: 'uk', language: 'uk-UA', name: 'Українська', file: 'uk.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
  },
})
