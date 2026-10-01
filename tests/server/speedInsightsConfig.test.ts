import { afterEach, describe, expect, it, vi } from 'vitest'
import { speedInsightsDefault, speedInsightsWanted } from '../../app/utils/speedInsights'

/**
 * Loads the real `nuxt.config.ts` under the given build environment, with the `defineNuxtConfig`
 * auto-import stubbed to the identity function (as in securityHeaders.test.ts). The config reads
 * `process.env` when it is evaluated, so every load is a fresh module.
 */
async function buildDefault(env: Record<string, string | undefined>): Promise<unknown> {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  for (const name of ['VERCEL_ENV', 'RAWG_FIXTURES']) vi.stubEnv(name, env[name])
  const module = await import('../../nuxt.config')
  const config = module.default as { runtimeConfig?: { public?: { speedInsights?: unknown } } }
  return config.runtimeConfig?.public?.speedInsights
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
  ['a fixture-mode local build', { RAWG_FIXTURES: '1' }, ''],
]

describe('Speed Insights is on by default only for Vercel production', () => {
  it.each(builds)('%s', async (_, env, expected) => {
    expect(speedInsightsDefault(env)).toBe(expected)
    expect(await buildDefault(env)).toBe(expected)
  })
})

describe('NUXT_PUBLIC_SPEED_INSIGHTS overrides the build default at runtime', () => {
  // Nuxt replaces the public value with the env override, parsed by destr: "0" → 0, "1" → 1.
  const effective = (env: Record<string, string | undefined>, override?: number) =>
    speedInsightsWanted({
      enabled: override ?? speedInsightsDefault(env),
      dev: false,
      navigator: { doNotTrack: null },
    })

  it.each(builds)('%s: no override loads it only where the default is on', (_, env, expected) => {
    expect(effective(env)).toBe(expected === '1')
  })

  it.each(builds)('%s: NUXT_PUBLIC_SPEED_INSIGHTS=0 turns it off', (_, env) => {
    expect(effective(env, 0)).toBe(false)
  })

  it.each(builds)('%s: NUXT_PUBLIC_SPEED_INSIGHTS=1 forces it on', (_, env) => {
    expect(effective(env, 1)).toBe(true)
  })
})
