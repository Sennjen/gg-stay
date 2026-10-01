import { describe, expect, it } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

// A Vercel production build, which bakes Speed Insights on, with fixture mode left off at build
// time and switched on at runtime only — the case a build-time check cannot see. Recorded data must
// never be reported as field metrics, so the page must still be told Speed Insights is off, even
// with NUXT_PUBLIC_SPEED_INSIGHTS=1 forcing it on.
process.env.VERCEL_ENV = 'production'
// A Vercel production build refuses to build without its public origin (shared/siteUrl.ts).
process.env.NUXT_PUBLIC_SITE_URL = 'https://gg-stay.vercel.app'
delete process.env.RAWG_FIXTURES
delete process.env.NUXT_RAWG_FIXTURES

describe('Speed Insights in fixture mode switched on at runtime', async () => {
  await setup({
    server: true,
    browser: false,
    env: { NUXT_RAWG_FIXTURES: '1', NUXT_PUBLIC_SPEED_INSIGHTS: '1' },
  })

  it('tells every page Speed Insights is off', async () => {
    for (const path of ['/', '/games', '/games/the-witcher-3-wild-hunt']) {
      const html = await $fetch<string>(path)
      // Fixture data proves the runtime switch took effect.
      expect(html).toContain('The Witcher 3: Wild Hunt')
      expect(html).toMatch(/speedInsights:\s*""/)
    }
  })
})
