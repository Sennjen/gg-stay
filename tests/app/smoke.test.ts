import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { clearNuxtData } from '#app'
import IndexPage from '~/pages/index.vue'

const rowGame = {
  id: '654',
  slug: 'stardew-valley',
  name: 'Stardew Valley',
  released: '2016-02-25',
  rating: 4.4,
  metacritic: 89,
  cover: { url: 'https://media.rawg.io/media/games/713/xyz.jpg' },
  screenshots: [],
  platformFamilies: ['PC'],
  platforms: [{ id: '4', slug: 'pc', name: 'PC' }],
  genres: [{ id: '4', slug: 'indie', name: 'Indie' }],
}

const landingWithFeatured = {
  landing: {
    featured: {
      clipUrl: null,
      game: {
        slug: 'the-witcher-3-wild-hunt',
        name: 'The Witcher 3: Wild Hunt',
        released: '2015-05-18',
        platformFamilies: ['PC'],
        cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
      },
    },
    carousel: [rowGame],
    newReleases: [rowGame],
    topRated: [rowGame],
    totalGames: 900_934,
  },
}

describe('home page', () => {
  it('renders the Ukrainian hero headline by default', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async () => ({ data: landingWithFeatured }),
    })

    const wrapper = await mountSuspended(IndexPage)
    expect(wrapper.text()).toContain('Ігри, які варто знайти')
    expect(wrapper.get('h1').text()).toBe('Ігри, які варто знайти')
    expect(wrapper.text()).toContain('The Witcher 3: Wild Hunt')
  })

  it('pulls the hero up by the header height (plus the layout padding) so it runs under the sticky header instead of starting below it', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async () => ({ data: landingWithFeatured }),
    })

    const wrapper = await mountSuspended(IndexPage)
    const root = wrapper.get('[data-test="hero-bleed"]')
    expect(root.classes()).toContain('-mt-[calc(var(--header-h)+1.5rem)]')
  })

  it('renders the sections below the hero: rounded count, why cards, rows and the closing call to action', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async () => ({ data: landingWithFeatured }),
    })

    const wrapper = await mountSuspended(IndexPage)
    // 900 934 rounds down to 900 000, per the friendly-figure rule.
    expect(wrapper.text()).toContain('900')
    expect(wrapper.text()).toContain('000+')
    expect(wrapper.text()).toContain('Чому GG Stay')
    expect(wrapper.text()).toContain('Нові релізи')
    expect(wrapper.text()).toContain('Найкращі за оцінкою гравців')
    // The two rows both show the same fixture game (reused for brevity above).
    expect(wrapper.text().match(/Stardew Valley/g)?.length).toBe(2)
    expect(wrapper.text()).toContain('Готові знайти свою наступну гру?')
    // The closing call to action reuses the hero's own button label.
    expect(wrapper.text().match(/Відкрити каталог/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('still renders the hero, why cards and closing call to action when the landing query fails, with no error box and no stats/ring/rows', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async () => ({ errors: [{ message: 'boom' }] }),
    })

    // The previous test's `useAsyncData` result is cached under the same key (the `landing`
    // query takes no variables), so it must be cleared or this test would keep seeing that
    // cached, successful response instead of exercising the error path.
    clearNuxtData('gql:Landing:{}')
    const wrapper = await mountSuspended(IndexPage)
    expect(wrapper.get('h1').text()).toBe('Ігри, які варто знайти')
    expect(wrapper.get('a[href="/games"]').exists()).toBe(true)
    // No caption and no error box without a featured game.
    expect(wrapper.text()).not.toContain('Зараз на екрані')
    // The sections that need landing data are simply absent — no placeholder, no error box.
    // ("Нові релізи" still appears once, from the hero's own inline link — just not as a
    // GameRow section title with cards under it.)
    expect(wrapper.text()).not.toContain('ігор у каталозі')
    expect(wrapper.text()).not.toContain('Найкращі за оцінкою гравців')
    expect(wrapper.text()).not.toContain('Stardew Valley')
    // WhyCards and the closing call to action have no data dependency and still render.
    expect(wrapper.text()).toContain('Чому GG Stay')
    expect(wrapper.text()).toContain('Готові знайти свою наступну гру?')
  })
})
