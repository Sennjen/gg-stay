import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A Vercel preview is a full copy of the site on its own host; a search engine that finds one must
 * not index it beside production. Loads the real `nuxt.config.ts` under each `VERCEL_ENV`, the way
 * `securityHeaders.test.ts` does, so the assertion is on the config the build uses.
 */
interface LoadedConfig {
  routeRules: Record<string, { headers?: Record<string, string> }>
  runtimeConfig: { public: { previewDeployment: boolean } }
  i18n: { baseUrl: string }
}

async function loadNuxtConfig(env: Record<string, string>): Promise<LoadedConfig> {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  const module = await import('../../nuxt.config')
  return module.default as unknown as LoadedConfig
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('indexing per deployment', () => {
  it('sends noindex on every response of a preview, and tells the pages', async () => {
    const config = await loadNuxtConfig({
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'gg-stay-git-x.vercel.app',
      NUXT_PUBLIC_SITE_URL: '',
    })
    expect(config.routeRules['/**']!.headers!['X-Robots-Tag']).toBe('noindex, nofollow')
    expect(config.runtimeConfig.public.previewDeployment).toBe(true)
    expect(config.i18n.baseUrl).toBe('https://gg-stay-git-x.vercel.app')
  })

  it('sends no robots header in production', async () => {
    const config = await loadNuxtConfig({
      VERCEL_ENV: 'production',
      NUXT_PUBLIC_SITE_URL: 'https://gg-stay.vercel.app',
    })
    expect(config.routeRules['/**']!.headers!).not.toHaveProperty('X-Robots-Tag')
    expect(config.runtimeConfig.public.previewDeployment).toBe(false)
    expect(config.i18n.baseUrl).toBe('https://gg-stay.vercel.app')
  })

  it('fails a production build that lost its site URL', async () => {
    await expect(
      loadNuxtConfig({ VERCEL_ENV: 'production', NUXT_PUBLIC_SITE_URL: '' }),
    ).rejects.toThrow(/NUXT_PUBLIC_SITE_URL is required/)
  })
})
