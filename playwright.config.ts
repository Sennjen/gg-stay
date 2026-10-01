import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke flows in a real browser against the fixture-mode production build (node preset,
 * `RAWG_FIXTURES=1`): `pnpm build` with `NITRO_PRESET=node-server`, then `pnpm e2e`. In CI the
 * `quality` job has already started that server for Lighthouse, and it is reused here; locally the
 * `webServer` block starts it when nothing answers yet. These are not part of `pnpm test` — Vitest
 * keeps the unit, component and SSR suites, which need no browser.
 */
const baseURL = process.env.QUALITY_BASE_URL ?? 'http://localhost:3000'
const isCi = Boolean(process.env.CI)

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'uk-UA',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node .output/server/index.mjs',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      PORT: new URL(baseURL).port || '80',
      RAWG_FIXTURES: '1',
      NUXT_RAWG_FIXTURES: '1',
      NUXT_PUBLIC_SITE_URL: baseURL,
    },
  },
})
