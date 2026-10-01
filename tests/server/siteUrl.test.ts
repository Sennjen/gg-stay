import { describe, expect, it } from 'vitest'
import { DEV_SITE_URL, isPreviewDeployment, parseSiteUrl } from '../../shared/siteUrl'

describe('parseSiteUrl', () => {
  it('accepts an absolute https origin and returns it unchanged', () => {
    expect(parseSiteUrl('https://gg-stay.vercel.app')).toBe('https://gg-stay.vercel.app')
  })

  it('accepts an http origin with a port, for local and preview builds', () => {
    expect(parseSiteUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('lowercases the host the way a browser would', () => {
    expect(parseSiteUrl('https://GG-Stay.Vercel.App')).toBe('https://gg-stay.vercel.app')
  })

  it('falls back to the development origin when nothing is set', () => {
    expect(parseSiteUrl(undefined)).toBe(DEV_SITE_URL)
    expect(parseSiteUrl('')).toBe(DEV_SITE_URL)
  })

  const rejected: [string, string][] = [
    // The value production actually carried: every canonical read `https://gg-stay.vercel.app;/…`.
    ['a trailing semicolon', 'https://gg-stay.vercel.app;'],
    ['a trailing slash', 'https://gg-stay.vercel.app/'],
    ['leading whitespace', ' https://gg-stay.vercel.app'],
    ['trailing whitespace', 'https://gg-stay.vercel.app '],
    ['a trailing newline', 'https://gg-stay.vercel.app\n'],
    ['a path', 'https://gg-stay.vercel.app/uk'],
    ['a query', 'https://gg-stay.vercel.app?ref=1'],
    ['a fragment', 'https://gg-stay.vercel.app#top'],
    ['a trailing comma', 'https://gg-stay.vercel.app,'],
    ['quotes around it', '"https://gg-stay.vercel.app"'],
    ['credentials', 'https://user:pass@gg-stay.vercel.app'],
    ['a non-http scheme', 'ftp://gg-stay.vercel.app'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['no scheme at all', 'gg-stay.vercel.app'],
    ['a protocol-relative URL', '//gg-stay.vercel.app'],
  ]

  it.each(rejected)('refuses %s with a message that names the variable and the value', (_, raw) => {
    expect(() => parseSiteUrl(raw)).toThrow(/NUXT_PUBLIC_SITE_URL/)
    expect(() => parseSiteUrl(raw)).toThrow(JSON.stringify(raw))
  })

  it('says what a valid value looks like', () => {
    expect(() => parseSiteUrl('https://gg-stay.vercel.app;')).toThrow(
      /absolute http\(s\) origin.*https:\/\/example\.com/,
    )
  })

  it('names the punycode form when a host is written in Unicode', () => {
    expect(() => parseSiteUrl('https://ґґ.ua')).toThrow(/punycode \(xn--\)/)
  })
})

describe('parseSiteUrl on a Vercel build', () => {
  it('falls back to localhost wherever Vercel is not building: local, CI, tests', () => {
    expect(parseSiteUrl(undefined, {})).toBe(DEV_SITE_URL)
    expect(parseSiteUrl(undefined, { vercelEnv: 'development' })).toBe(DEV_SITE_URL)
  })

  it('refuses to build production without a site URL', () => {
    // The silent failure this guards against: every canonical, hreflang and sitemap URL pointing
    // at localhost because the variable went missing from the Vercel project.
    expect(() => parseSiteUrl(undefined, { vercelEnv: 'production' })).toThrow(
      /NUXT_PUBLIC_SITE_URL is required on a Vercel production build/,
    )
    expect(() => parseSiteUrl('', { vercelEnv: 'production' })).toThrow(/required/)
  })

  it.each([
    ['plain http', 'http://gg-stay.vercel.app'],
    ['localhost', 'https://localhost'],
    ['localhost with a port', 'https://localhost:3000'],
    ['a loopback address', 'https://127.0.0.1:3000'],
    ['the IPv6 loopback', 'https://[::1]'],
  ])('refuses %s on production', (_, raw) => {
    expect(() => parseSiteUrl(raw, { vercelEnv: 'production' })).toThrow(/production/)
  })

  it('accepts the public https origin on production', () => {
    expect(parseSiteUrl('https://gg-stay.vercel.app', { vercelEnv: 'production' })).toBe(
      'https://gg-stay.vercel.app',
    )
  })

  it('links a preview without a site URL to the deployment it is on', () => {
    // The variable is set for Production only; a preview is its own host.
    expect(
      parseSiteUrl(undefined, {
        vercelEnv: 'preview',
        vercelUrl: 'gg-stay-git-x-sennjen.vercel.app',
      }),
    ).toBe('https://gg-stay-git-x-sennjen.vercel.app')
  })

  it('still validates the host Vercel gives a preview', () => {
    expect(() => parseSiteUrl(undefined, { vercelEnv: 'preview', vercelUrl: 'bad;host' })).toThrow(
      /VERCEL_URL/,
    )
    expect(() => parseSiteUrl(undefined, { vercelEnv: 'preview' })).toThrow(/VERCEL_URL/)
  })

  it('prefers a site URL set for previews over the deployment host', () => {
    expect(
      parseSiteUrl('https://preview.example.com', {
        vercelEnv: 'preview',
        vercelUrl: 'x.vercel.app',
      }),
    ).toBe('https://preview.example.com')
  })
})

describe('isPreviewDeployment', () => {
  it('is true on a Vercel preview build only', () => {
    expect(isPreviewDeployment('preview')).toBe(true)
    expect(isPreviewDeployment('production')).toBe(false)
    expect(isPreviewDeployment('development')).toBe(false)
    expect(isPreviewDeployment(undefined)).toBe(false)
  })
})
