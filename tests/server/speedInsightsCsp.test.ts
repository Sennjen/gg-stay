import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../../server/security/headers'

/**
 * Vercel Speed Insights loads `/_vercel/speed-insights/script.js` and posts its reports to
 * `/_vercel/speed-insights/vitals`, both on the page's own origin, so the policy needs no new
 * source for it. These assertions pin that: if `script-src` or `connect-src` ever stop allowing
 * the page's own origin, the measurement silently stops and nothing else would notice.
 */
describe('the policy allows Speed Insights without naming it', () => {
  const directive = (policy: string, name: string) =>
    policy
      .split('; ')
      .find((entry) => entry.startsWith(`${name} `))
      ?.split(' ')
      .slice(1) ?? []

  it.each([[[]], [["'sha256-abc'", "'sha256-def'"]]])(
    'allows same-origin scripts and requests (hashes: %j)',
    (hashes) => {
      const policy = contentSecurityPolicy(hashes)
      expect(directive(policy, 'script-src')).toContain("'self'")
      expect(directive(policy, 'connect-src')).toContain("'self'")
    },
  )

  it('names no Vercel script host, which only a development build would load', () => {
    expect(contentSecurityPolicy()).not.toContain('vercel-scripts.com')
  })
})
