import { describe, expect, it } from 'vitest'
import { rawgImageUrl } from '~/utils/rawgImage'

const src = 'https://media.rawg.io/media/games/618/abc.jpg'

describe('rawgImageUrl', () => {
  it.each([
    [300, 420],
    [420, 420],
    [560, 420],
    [640, 640],
    [840, 640],
    [1000, 1280],
    [1280, 1280],
    [5000, 1280],
  ])(
    'picks the smallest CDN size that is at least 75%% of the requested width (%i -> %i)',
    (requested, expected) => {
      expect(rawgImageUrl(src, requested)).toBe(
        `https://media.rawg.io/media/resize/${expected}/-/games/618/abc.jpg`,
      )
    },
  )
  it('leaves the url alone without a width, for other hosts, and when already resized', () => {
    expect(rawgImageUrl(src)).toBe(src)
    expect(rawgImageUrl('https://example.com/media/a.jpg', 300)).toBe(
      'https://example.com/media/a.jpg',
    )
    const resized = 'https://media.rawg.io/media/resize/420/-/games/618/abc.jpg'
    expect(rawgImageUrl(resized, 640)).toBe(resized)
  })
})
