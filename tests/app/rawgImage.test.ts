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
  ])(
    'picks the smallest CDN size that is at least 75%% of the requested width (%i -> %i)',
    (requested, expected) => {
      expect(rawgImageUrl(src, requested)).toBe(
        `https://media.rawg.io/media/resize/${expected}/-/games/618/abc.jpg`,
      )
    },
  )

  it.each([
    [1280, 'resize/1280'],
    [1700, 'resize/1280'],
  ])(
    'still resizes to 1280 when it covers at least 75%% of the requested width (%i -> %s)',
    (requested, expectedSuffix) => {
      expect(rawgImageUrl(src, requested)).toBe(
        `https://media.rawg.io/media/${expectedSuffix}/-/games/618/abc.jpg`,
      )
    },
  )

  it.each([1920, 2560, 5000])(
    'serves the original, un-resized url when even 1280 would be upscaled by more than the tolerance (%ipx)',
    (requested) => {
      expect(rawgImageUrl(src, requested)).toBe(src)
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
