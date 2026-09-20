import { describe, expect, it, vi } from 'vitest'
import {
  API_CONTENT_SECURITY_POLICY,
  CSP_HEADER,
  STATIC_SECURITY_HEADERS,
  contentSecurityPolicy,
} from '../../server/security/headers'

const hasCsp = (headers: Record<string, unknown>) =>
  Object.keys(headers).some((name) => name.toLowerCase() === CSP_HEADER)

/**
 * Loads the real `nuxt.config.ts`, with the `defineNuxtConfig` auto-import stubbed to the identity
 * function so the module can be evaluated outside the Nuxt build. This reads the config the build
 * actually uses, rather than an object a test hopes the config still spreads.
 */
async function loadNuxtConfig() {
  vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
  const module = await import('../../nuxt.config')
  return module.default as {
    routeRules?: Record<string, { headers?: Record<string, unknown> }>
    nitro?: { routeRules?: Record<string, { headers?: Record<string, unknown> }> }
  }
}

describe('the Content-Security-Policy has exactly one source', () => {
  /**
   * This is the regression guard for the real failure: `routeRules` headers are compiled by the
   * Vercel preset into a proxy-level route entry in `.vercel/output/config.json`, so a CSP there
   * would be applied by the CDN — either replacing the function's hashed policy or intersecting
   * with it. Under both behaviours the two scripts Nuxt inlines are blocked and no page hydrates,
   * in production only.
   *
   * It asserts against the loaded config, not against the exported header object, so re-adding a
   * CSP anywhere in `routeRules` fails here even if it is written inline or comes from elsewhere.
   * `scripts/check-vercel-headers.mjs` makes the same assertion against the compiled output in CI,
   * where the built artifact exists.
   */
  it('no route rule in the real nuxt config sets a CSP', async () => {
    const config = await loadNuxtConfig()
    const ruleSets = [config.routeRules ?? {}, config.nitro?.routeRules ?? {}]
    const offenders = ruleSets.flatMap((rules) =>
      Object.entries(rules)
        .filter(([, rule]) => rule?.headers && hasCsp(rule.headers))
        .map(([pattern]) => pattern),
    )
    expect(offenders).toEqual([])
  })

  it('the route rules still carry the four static headers', async () => {
    const config = await loadNuxtConfig()
    expect(Object.keys(config.routeRules?.['/**']?.headers ?? {}).sort()).toEqual([
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
  })

  it('the header object the route rules spread carries no CSP either', () => {
    expect(hasCsp(STATIC_SECURITY_HEADERS)).toBe(false)
    expect(Object.keys(STATIC_SECURITY_HEADERS).sort()).toEqual([
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
  })
})

describe('the policy itself', () => {
  const policy = contentSecurityPolicy()
  const directive = (name: string) =>
    policy.split('; ').find((entry) => entry.startsWith(`${name} `))

  it('allows the blob: media source hls.js attaches to the video element', () => {
    // hls.attachMedia(video) sets video.src = URL.createObjectURL(mediaSource). A blob in a media
    // context is governed by media-src, not worker-src; without it the trailer silently never
    // plays on every engine that is not Safari (which takes the native HLS path instead).
    expect(directive('media-src')).toContain('blob:')
    expect(directive('worker-src')).toContain('blob:')
  })

  it('keeps every Steam and RAWG host the app actually reaches', () => {
    expect(directive('media-src')).toContain('https://video.akamai.steamstatic.com')
    expect(directive('connect-src')).toContain('https://video.akamai.steamstatic.com')
    expect(directive('img-src')).toContain('https://media.rawg.io')
    expect(directive('img-src')).toContain('https://api.rawg.io')
  })

  it('gives the JSON endpoint a policy that allows nothing at all', () => {
    // It loads nothing and hosts no document, so an allow-list would only be a larger surface.
    expect(API_CONTENT_SECURITY_POLICY).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(API_CONTENT_SECURITY_POLICY).not.toContain('self')
  })

  it('never allows inline or eval scripts, with or without hashes', () => {
    for (const value of [contentSecurityPolicy(), contentSecurityPolicy(["'sha256-abc'"])]) {
      const scriptSrc = value.split('; ').find((entry) => entry.startsWith('script-src'))!
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(scriptSrc).not.toContain('unsafe-eval')
    }
    expect(contentSecurityPolicy(["'sha256-abc'"])).toContain("script-src 'self' 'sha256-abc'")
  })
})
