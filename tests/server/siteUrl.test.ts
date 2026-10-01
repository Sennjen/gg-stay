import { describe, expect, it } from 'vitest'
import { DEV_SITE_URL, parseSiteUrl } from '../../shared/siteUrl'

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
})
