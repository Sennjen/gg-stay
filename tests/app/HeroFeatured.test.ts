import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HeroFeatured from '~/components/HeroFeatured.vue'
import HeroVideo from '~/components/HeroVideo.vue'

const featured = {
  clipUrl: 'https://media.rawg.io/media/movies/1/movie480.mp4',
  game: {
    slug: 'the-witcher-3-wild-hunt',
    name: 'The Witcher 3: Wild Hunt',
    released: '2015-05-18',
    platformFamilies: ['PC'] as const,
    cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  },
}

describe('HeroFeatured', () => {
  it('renders the lowercase headline, both locales of the call to action, and the secondary link', async () => {
    const wrapper = await mountSuspended(HeroFeatured, { props: { featured: null } })

    expect(wrapper.get('h1').text()).toBe('ігри, які варто знайти')
    expect(wrapper.text()).toContain('каталог для українського гравця')

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

    expect(wrapper.get('h1').text()).toBe('games worth finding')
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
})
