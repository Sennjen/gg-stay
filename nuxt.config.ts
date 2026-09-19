import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: true },
  telemetry: false,
  modules: ['@nuxt/eslint', '@nuxt/fonts', '@nuxt/image', '@nuxtjs/i18n', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  fonts: {
    families: [
      {
        name: 'Tektur',
        provider: 'google',
        subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
        weights: [400, 500, 600, 700],
        display: 'swap',
      },
      {
        name: 'Inter',
        provider: 'google',
        subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
        weights: [400, 500, 600],
        display: 'swap',
      },
      {
        name: 'JetBrains Mono',
        provider: 'google',
        subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
        weights: [400, 500],
        display: 'swap',
      },
    ],
  },
  typescript: { strict: true },
  runtimeConfig: {
    rawgApiKey: process.env.RAWG_API_KEY ?? '',
    rawgFixtures: process.env.RAWG_FIXTURES ?? '',
  },
  routeRules: {
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
