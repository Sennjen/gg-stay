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

  it('rejects null and undefined', () => {
    expect(safeExternalUrl(null)).toBeNull()
    expect(safeExternalUrl(undefined)).toBeNull()
  })
})
