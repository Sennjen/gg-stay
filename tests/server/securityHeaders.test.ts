import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CSP_HEADER,
  STATIC_SECURITY_HEADERS,
  contentSecurityPolicy,
} from '../../server/security/headers'

const VERCEL_CONFIG = resolve(process.cwd(), '.vercel/output/config.json')

const hasCsp = (headers: Record<string, unknown>) =>
  Object.keys(headers).some((name) => name.toLowerCase() === CSP_HEADER)

describe('the Content-Security-Policy has exactly one source', () => {
  /**
   * This is the regression guard for the real failure: `routeRules` headers are compiled by the
   * Vercel preset into a proxy-level route entry, so a CSP here would be applied by the CDN — either
   * replacing the function's hashed policy or intersecting with it. Under both behaviours the two
   * scripts Nuxt inlines are blocked and no page hydrates, in production only. The object asserted
   * here is literally the one `nuxt.config.ts` spreads into `routeRules['/**']`.
   */
  it('routeRules carries no CSP — only the static headers', () => {
    expect(hasCsp(STATIC_SECURITY_HEADERS)).toBe(false)
    expect(Object.keys(STATIC_SECURITY_HEADERS).sort()).toEqual([
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ])
  })

  /**
   * Runs whenever a Vercel build is present in the working tree (`NITRO_PRESET=vercel pnpm build`,
   * which the acceptance list runs). It reads the compiled route table rather than trusting that
   * the rule above is the only way a header can get there.
   */
  it('no route in a compiled Vercel config injects a CSP', () => {
    if (!existsSync(VERCEL_CONFIG)) {
      // Nothing to check without a build; the assertion above already covers the source of truth.
      expect(existsSync(VERCEL_CONFIG)).toBe(false)
      return
    }
    const config = JSON.parse(readFileSync(VERCEL_CONFIG, 'utf-8')) as {
      routes?: { src?: string; headers?: Record<string, unknown> }[]
    }
    const offenders = (config.routes ?? [])
      .filter((route) => route.headers && hasCsp(route.headers))
      .map((route) => route.src)
    expect(offenders).toEqual([])
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

  it('never allows inline or eval scripts, with or without hashes', () => {
    for (const value of [contentSecurityPolicy(), contentSecurityPolicy(["'sha256-abc'"])]) {
      const scriptSrc = value.split('; ').find((entry) => entry.startsWith('script-src'))!
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(scriptSrc).not.toContain('unsafe-eval')
    }
    expect(contentSecurityPolicy(["'sha256-abc'"])).toContain("script-src 'self' 'sha256-abc'")
  })
})
