import { describe, expect, it } from 'vitest'
import { safeExternalUrl } from '../../shared/url'

describe('safeExternalUrl', () => {
  const accepted: [string, string][] = [
    ['https://store.steampowered.com/app/292030', 'https://store.steampowered.com/app/292030'],
    ['http://example.com/path?a=1#b', 'http://example.com/path?a=1#b'],
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['https://example.com/ігри', 'https://example.com/%D1%96%D0%B3%D1%80%D0%B8'],
  ]

  it.each(accepted)('accepts %s', (input, expected) => {
    expect(safeExternalUrl(input)).toBe(expected)
  })

  const rejected: [string, string][] = [
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript: leading whitespace', '   javascript:alert(1)'],
    ['javascript: leading control characters', 'javascript:alert(1)'],
    ['javascript: leading newline and tab', '\n\tjavascript:alert(1)'],
    // Whitespace INSIDE the scheme, which is the form that defeats a naive `startsWith` check:
    // the WHATWG parser strips the tab/newline and then fails on what is left.
    ['javascript: newline inside the scheme', 'java\nscript:alert(1)'],
    ['javascript: tab inside the scheme', 'java\tscript:alert(1)'],
    ['javascript: carriage return inside the scheme', 'ja\rvascript:alert(1)'],
    ['data: newline inside the scheme', 'da\nta:text/html,<script>alert(1)</script>'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///etc/passwd'],
    ['protocol-relative', '//evil.example.com/x'],
    ['path-relative', '/games/x'],
    ['bare host', 'evil.example.com'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['not a url at all', 'not a url'],
  ]

  it.each(rejected)('rejects %s', (_label, input) => {
    expect(safeExternalUrl(input)).toBeNull()
  })

  it('drops credentials from the authority rather than passing them through', () => {
    expect(safeExternalUrl('https://user:pass@example.com/path')).toBe('https://example.com/path')
    expect(safeExternalUrl('https://user@example.com/')).toBe('https://example.com/')
  })

  it('rejects null and undefined', () => {
    expect(safeExternalUrl(null)).toBeNull()
    expect(safeExternalUrl(undefined)).toBeNull()
  })
})
