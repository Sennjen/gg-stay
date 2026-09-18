import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint', '@nuxt/image', '@nuxtjs/i18n', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  typescript: { strict: true },
  runtimeConfig: {
    rawgApiKey: process.env.RAWG_API_KEY ?? '',
    rawgFixtures: process.env.RAWG_FIXTURES ?? '',
  },
  routeRules: {
    '/': { isr: 600 },
    '/en': { isr: 600 },
  },
  nitro: {
    serverAssets: [
      {
        baseName: 'rawg-fixtures',
        dir: fileURLToPath(new URL('./tests/fixtures/rawg', import.meta.url)),
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
