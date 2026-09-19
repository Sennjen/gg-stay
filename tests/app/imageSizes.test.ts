import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CoverRing from '~/components/CoverRing.vue'
import GameCard from '~/components/GameCard.vue'
import GameHero from '~/components/GameHero.vue'
import GameRow from '~/components/GameRow.vue'
import HeroFeatured from '~/components/HeroFeatured.vue'
import ScreenshotGallery from '~/components/ScreenshotGallery.vue'
import ScreenshotGalleryLightbox from '~/components/ScreenshotGalleryLightbox.vue'

/**
 * `@nuxt/image` accepts `breakpoint:value` pairs, not CSS media queries, and it fails silently on
 * the wrong syntax: a bare `33vw` yields a single `0w` candidate, which is an invalid descriptor
 * that voids the whole srcset, and a `(max-width: …)` string collapses to one fixed width. Both
 * bugs shipped once already, and neither is visible in the input string — so these tests assert
 * what the components actually EMIT, through the real Nuxt runtime and the real `rawg` provider.
 *
 * Repeated CDN urls at different descriptors are expected and correct: `rawgImageUrl` snaps a
 * requested width down to the nearest variant that still covers 75% of it.
 */

const COVER = 'https://media.rawg.io/media/games/618/abc.jpg'
const SHOT = 'https://media.rawg.io/media/screenshots/1/shot.jpg'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  metacritic: 92,
  cover: { url: COVER },
  screenshots: [{ url: SHOT }],
  platformFamilies: ['PC'] as const,
}

/** Parses a srcset into `[url, descriptor]` pairs. */
function parseSrcset(srcset: string | undefined) {
  return (srcset ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, descriptor] = entry.split(/\s+/)
      return { url: url!, descriptor: descriptor! }
    })
}

/** Every widths-based srcset must be strictly ascending and free of zero-width candidates. */
function expectAscendingWidths(srcset: string | undefined) {
  const widths = parseSrcset(srcset).map(({ descriptor }) => {
    expect(descriptor).toMatch(/^\d+w$/)
    return Number.parseInt(descriptor, 10)
  })
  expect(widths.length).toBeGreaterThan(1)
  expect(widths.every((width) => width > 0)).toBe(true)
  expect([...widths].sort((a, b) => a - b)).toEqual(widths)
}

const variant = (width: number) => `https://media.rawg.io/media/resize/${width}/-/games/618/abc.jpg`

describe('emitted image sizes', () => {
  it('catalog grid card asks for half the viewport on phones and a fixed box on desktop', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const cover = wrapper.findAll('img')[0]!

    expect(cover.attributes('sizes')).toBe(
      '(max-width: 639px) 50vw, (max-width: 1279px) 50vw, 220px',
    )
    expectAscendingWidths(cover.attributes('srcset'))
    expect(parseSrcset(cover.attributes('srcset'))).toEqual([
      { url: variant(200), descriptor: '210w' },
      { url: variant(200), descriptor: '220w' },
      { url: variant(420), descriptor: '320w' },
      { url: variant(420), descriptor: '420w' },
      { url: variant(420), descriptor: '440w' },
      { url: variant(640), descriptor: '640w' },
    ])
  })

  it('catalog list card asks for the full viewport on phones and 220px above it', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game, layout: 'list' } })
    const cover = wrapper.findAll('img')[0]!

    expect(cover.attributes('sizes')).toBe('(max-width: 639px) 100vw, 220px')
    expectAscendingWidths(cover.attributes('srcset'))
    expect(parseSrcset(cover.attributes('srcset'))).toEqual([
      { url: variant(200), descriptor: '220w' },
      { url: variant(420), descriptor: '420w' },
      { url: variant(420), descriptor: '440w' },
      { url: variant(640), descriptor: '840w' },
    ])
  })

  it('landing row card asks for its fixed 280px slot, not the grid share', async () => {
    const wrapper = await mountSuspended(GameRow, { props: { title: 'Row', games: [game] } })
    const cover = wrapper.findAll('img')[0]!

    expect(cover.attributes('sizes')).toBe('280px')
    expectAscendingWidths(cover.attributes('srcset'))
    expect(parseSrcset(cover.attributes('srcset'))).toEqual([
      { url: variant(420), descriptor: '280w' },
      { url: variant(420), descriptor: '560w' },
    ])
  })

  it('gallery thumbnails emit a real responsive srcset with no zero-width candidate', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images: [{ url: SHOT, width: 1920, height: 1080 }], title: 'The Witcher 3' },
    })
    const thumbnail = wrapper.get('img')

    expect(thumbnail.attributes('sizes')).toBe(
      '(max-width: 639px) 50vw, (max-width: 1279px) 33vw, 370px',
    )
    expect(thumbnail.attributes('srcset')).not.toContain(' 0w')
    expectAscendingWidths(thumbnail.attributes('srcset'))
    expect(parseSrcset(thumbnail.attributes('srcset')).map((c) => c.descriptor)).toEqual([
      '210w',
      '211w',
      '370w',
      '420w',
      '422w',
      '740w',
    ])
  })

  it('the lightbox image is viewport-wide on phones and capped by its column above', async () => {
    const wrapper = await mountSuspended(ScreenshotGalleryLightbox, {
      props: {
        images: [{ url: SHOT, width: 1920, height: 1080 }],
        title: 'The Witcher 3',
        initialIndex: 0,
      },
    })
    const image = wrapper.get('img')

    expect(image.attributes('sizes')).toBe(
      '(max-width: 639px) 100vw, (max-width: 1279px) 100vw, 900px',
    )
    expectAscendingWidths(image.attributes('srcset'))
  })

  it('heroes stay full-bleed and reach the CDN original on large dense screens', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: { name: 'The Witcher 3', coverUrl: COVER },
    })
    const poster = wrapper.get('img')

    expect(poster.attributes('sizes')).toBe(
      '(max-width: 639px) 100vw, (max-width: 1279px) 100vw, (max-width: 1535px) 100vw, 100vw',
    )
    expectAscendingWidths(poster.attributes('srcset'))
    expect(poster.attributes('srcset')).toContain(
      'https://media.rawg.io/media/games/618/abc.jpg 3072w',
    )
  })

  it('the landing hero poster uses the same full-bleed sizes', async () => {
    const wrapper = await mountSuspended(HeroFeatured, {
      props: { featured: { clipUrl: null, clipSource: null, game } },
    })
    const poster = wrapper.get('img')

    expect(poster.attributes('sizes')).toBe(
      '(max-width: 639px) 100vw, (max-width: 1279px) 100vw, (max-width: 1535px) 100vw, 100vw',
    )
    expectAscendingWidths(poster.attributes('srcset'))
  })

  it('ring covers ask for exactly their 200px box', async () => {
    const wrapper = await mountSuspended(CoverRing, { props: { games: [game], title: 'Ring' } })
    const cover = wrapper.get('img')

    expect(cover.attributes('sizes')).toBe('200px')
    expectAscendingWidths(cover.attributes('srcset'))
    expect(parseSrcset(cover.attributes('srcset'))).toEqual([
      { url: variant(200), descriptor: '200w' },
      { url: variant(420), descriptor: '400w' },
    ])
  })
})
