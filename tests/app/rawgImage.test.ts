import { describe, expect, it } from 'vitest'
import { rawgImageUrl } from '~/utils/rawgImage'

const src = 'https://media.rawg.io/media/games/618/abc.jpg'

describe('rawgImageUrl', () => {
  it('rewrites to the smallest supported width that covers the request', () => {
    expect(rawgImageUrl(src, 300)).toBe(
      'https://media.rawg.io/media/resize/420/-/games/618/abc.jpg',
    )
    expect(rawgImageUrl(src, 640)).toBe(
      'https://media.rawg.io/media/resize/640/-/games/618/abc.jpg',
    )
    expect(rawgImageUrl(src, 5000)).toBe(
      'https://media.rawg.io/media/resize/1280/-/games/618/abc.jpg',
    )
  })
  it('leaves the url alone without a width, for other hosts, and when already resized', () => {
    expect(rawgImageUrl(src)).toBe(src)
    expect(rawgImageUrl('https://example.com/media/a.jpg', 300)).toBe(
      'https://example.com/media/a.jpg',
    )
    const resized = 'https://media.rawg.io/media/resize/420/-/games/618/abc.jpg'
    expect(rawgImageUrl(resized, 640)).toBe(resized)
  })
})
