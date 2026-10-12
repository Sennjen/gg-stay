import { describe, expect, it } from 'vitest'
import { FEATURED_PINS, activePin, type FeaturedPin } from '../../server/graphql/featuredPin'
import { contentSecurityPolicy } from '../../server/security/headers'

function pin(overrides: Partial<FeaturedPin> = {}): FeaturedPin {
  return {
    rawgId: 1,
    until: '2026-11-30',
    clipUrl: 'https://example.test/clip.mp4',
    clipCredit: 'Studio',
    ...overrides,
  }
}

describe('activePin', () => {
  it('holds through its last day and not a day longer', () => {
    const pins = [pin()]
    expect(activePin('2026-10-12', pins)).toBe(pins[0])
    expect(activePin('2026-11-30', pins)).toBe(pins[0])
    expect(activePin('2026-12-01', pins)).toBeNull()
  })

  it('is null when nothing is pinned', () => {
    expect(activePin('2026-10-12', [])).toBeNull()
  })

  it('takes the first pin still in force', () => {
    const expired = pin({ rawgId: 1, until: '2026-09-30' })
    const current = pin({ rawgId: 2, until: '2026-11-30' })
    const later = pin({ rawgId: 3, until: '2026-12-31' })
    expect(activePin('2026-10-12', [expired, current, later])).toBe(current)
  })
})

describe('FEATURED_PINS', () => {
  it('ends every pin on a real calendar day', () => {
    for (const { until } of FEATURED_PINS) {
      expect(new Date(`${until}T00:00:00Z`).toISOString().slice(0, 10)).toBe(until)
    }
  })

  // A clip from an origin the policy does not name is blocked by the browser without a word: the
  // poster stays, nothing fails, and the pin looks as if it had worked.
  it('names only clips the media policy lets a page play', () => {
    const mediaSrc =
      contentSecurityPolicy()
        .split('; ')
        .find((directive) => directive.startsWith('media-src ')) ?? ''
    for (const { clipUrl } of FEATURED_PINS) {
      expect(mediaSrc.split(' ')).toContain(new URL(clipUrl).origin)
    }
  })
})
