import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HeroFeatured from '~/components/HeroFeatured.vue'
import HeroVideo from '~/components/HeroVideo.vue'

const featured = {
  clipUrl: 'https://media.rawg.io/media/movies/1/movie480.mp4',
  clipSource: 'RAWG' as const,
  game: {
    slug: 'the-witcher-3-wild-hunt',
    name: 'The Witcher 3: Wild Hunt',
    released: '2015-05-18',
    platformFamilies: ['PC'] as const,
    cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  },
}

describe('HeroFeatured', () => {
  it('renders the headline, both locales of the call to action, and the secondary link', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured: null } })

    expect(wrapper.get('h1').text()).toBe('Ігри, які варто знайти')
    expect(wrapper.text()).toContain('Каталог для українського гравця')

    const cta = wrapper.get('a[href="/games"]')
    expect(cta.text()).toBe('Відкрити каталог')

    const secondary = wrapper.get('a[href="/games?sort=RELEASED_DESC"]')
    expect(secondary.text()).toBe('Нові релізи')
  })

  it('renders the English call to action under /en', async () => {
    const wrapper = await mountSuspended(HeroFeatured, {
      props: { featured: null },
      route: '/en',
    })

    expect(wrapper.get('h1').text()).toBe('Games worth finding')
    expect(wrapper.get('a[href="/en/games"]').text()).toBe('Open the catalog')
  })

  it('renders the featured caption linking to the game page', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured } })

    const link = wrapper.get('a[href="/games/the-witcher-3-wild-hunt"]')
    expect(link.text()).toBe('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain('Зараз на екрані:')
  })

  it('renders the poster with high fetch priority and explicit dimensions', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured } })

    const poster = wrapper.get('img')
    expect(poster.attributes('fetchpriority')).toBe('high')
    expect(poster.attributes('width')).toBe('1280')
    expect(poster.attributes('height')).toBe('720')
    expect(poster.attributes('alt')).toBe('')
  })

  it('renders no poster and no caption without a featured game', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured: null } })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Зараз на екрані')
  })

  it('mounts HeroVideo only when a clip URL exists', async () => {
    const withClip = await mountSuspended(HeroFeatured, { props: { featured } })
    expect(withClip.findComponent(HeroVideo).exists()).toBe(true)

    const withoutClip = await mountSuspended(HeroFeatured, {
      props: { featured: { ...featured, clipUrl: null } },
    })
    expect(withoutClip.findComponent(HeroVideo).exists()).toBe(false)
  })

  it('shows a quieter "Трейлер: Steam" line only when the clip came from Steam', async () => {
    const rawgClip = await mountSuspended(HeroFeatured, { props: { featured } })
    expect(rawgClip.text()).not.toContain('Трейлер: Steam')

    const steamClip = await mountSuspended(HeroFeatured, {
      props: { featured: { ...featured, clipSource: 'STEAM' } },
    })
    expect(steamClip.text()).toContain('Трейлер: Steam')
  })

  it('renders an aria-hidden scrim above the poster so the header stays readable', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured } })
    const scrim = wrapper.find('[aria-hidden="true"].bg-gradient-to-b')
    expect(scrim.exists()).toBe(true)
  })

  it('gives the poster a real srcset: resize/1280 for mid-size screens, original for the largest', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured } })
    const srcset = wrapper.get('img').attributes('srcset') ?? ''
    expect(srcset).toContain('resize/1280/-/games/618/abc.jpg')
    expect(srcset).toContain('https://media.rawg.io/media/games/618/abc.jpg')
  })
})
