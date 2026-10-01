import { afterEach, describe, expect, it, vi } from 'vitest'
import { speedInsightsAtRuntime, speedInsightsDefault } from '../../app/utils/speedInsights'

/**
 * Loads the real `nuxt.config.ts` under the given build environment, with the `defineNuxtConfig`
 * auto-import stubbed to the identity function (as in securityHeaders.test.ts). The config reads
 * `process.env` when it is evaluated, so every load is a fresh module.
 */
async function loadConfig(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  for (const name of ['VERCEL_ENV', 'RAWG_FIXTURES', 'NUXT_RAWG_FIXTURES']) {
    vi.stubEnv(name, env[name])
  }
  // A Vercel build needs its site URL (shared/siteUrl.ts): production refuses to build without
  // one, and a preview falls back to its own host. Neither is what this file is about.
  vi.stubEnv('NUXT_PUBLIC_SITE_URL', 'https://gg-stay.vercel.app')
  vi.stubEnv('VERCEL_URL', 'gg-stay-git-x.vercel.app')
  const module = await import('../../nuxt.config')
  return module.default as {
    runtimeConfig?: { public?: { speedInsights?: unknown } }
    hooks?: { 'build:manifest'?: (manifest: Record<string, ManifestChunk>) => void }
  }
}

interface ManifestChunk {
  file: string
  isEntry?: boolean
  dynamicImports?: string[]
}

async function buildDefault(env: Record<string, string | undefined>): Promise<unknown> {
  return (await loadConfig(env)).runtimeConfig?.public?.speedInsights
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// Each build environment and what the public runtime config defaults to.
const builds: [string, Record<string, string | undefined>, string][] = [
  ['a Vercel production build', { VERCEL_ENV: 'production' }, '1'],
  ['a Vercel preview build', { VERCEL_ENV: 'preview' }, ''],
  ['a Vercel development build', { VERCEL_ENV: 'development' }, ''],
  ['a local or CI build', { VERCEL_ENV: undefined }, ''],
  [
    'a fixture-mode build, even on Vercel production',
    { VERCEL_ENV: 'production', RAWG_FIXTURES: '1' },
    '',
  ],
  [
    'a Vercel production build with fixtures switched on the runtime way',
    { VERCEL_ENV: 'production', NUXT_RAWG_FIXTURES: '1' },
    '',
  ],
  ['a fixture-mode local build', { RAWG_FIXTURES: '1' }, ''],
]

describe('Speed Insights is on by default only for Vercel production', () => {
  it.each(builds)('%s', async (_, env, expected) => {
    expect(speedInsightsDefault(env)).toBe(expected)
    expect(await buildDefault(env)).toBe(expected)
  })
})

// Fixture mode is decided at runtime too (`NUXT_RAWG_FIXTURES` overrides `rawgFixtures`), so the
// server turns the public flag off for every render in fixture mode, whatever the build baked in
// and whatever `NUXT_PUBLIC_SPEED_INSIGHTS` says. Values arrive as destr parses env overrides.
// tests/e2e/speedInsightsFixtures.test.ts proves the same against a running server.
describe('the runtime flag the page receives', () => {
  it.each<[string, unknown, unknown, unknown]>([
    ['on, not in fixture mode', '1', '', '1'],
    ['forced on by NUXT_PUBLIC_SPEED_INSIGHTS=1', 1, '', 1],
    ['turned off by NUXT_PUBLIC_SPEED_INSIGHTS=0', 0, '', 0],
    ['off by default', '', '', ''],
    ['on, but in fixture mode from the build', '1', '1', ''],
    ['on, but in fixture mode from NUXT_RAWG_FIXTURES=1', '1', 1, ''],
    ['forced on, but in fixture mode', 1, 1, ''],
  ])('%s', (_, flag, fixtures, expected) => {
    expect(speedInsightsAtRuntime(flag, fixtures)).toBe(expected)
  })
})

describe('the build:manifest hook', () => {
  it('drops only the Speed Insights SDK from the entry prefetch list', async () => {
    const hook = (await loadConfig()).hooks?.['build:manifest']
    const manifest: Record<string, ManifestChunk> = {
      'node_modules/nuxt/dist/app/entry.js': {
        file: 'entry.js',
        isEntry: true,
        dynamicImports: [
          'node_modules/@vercel/speed-insights/dist/index.mjs',
          'app/pages/games/[slug].vue',
          'node_modules/@nuxtjs/i18n/plural.js',
        ],
      },
      'app/components/Gallery.vue': {
        file: 'gallery.js',
        dynamicImports: ['node_modules/hls.js/dist/hls.mjs'],
      },
    }
    hook!(manifest)
    expect(manifest['node_modules/nuxt/dist/app/entry.js']!.dynamicImports).toEqual([
      'app/pages/games/[slug].vue',
      'node_modules/@nuxtjs/i18n/plural.js',
    ])
    expect(manifest['app/components/Gallery.vue']!.dynamicImports).toEqual([
      'node_modules/hls.js/dist/hls.mjs',
    ])
  })
})
