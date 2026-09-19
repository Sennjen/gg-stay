import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { clearNuxtData } from '#app'
import IndexPage from '~/pages/index.vue'

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
    totalGames: 900_000,
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
    const root = wrapper.get('main')
    expect(root.classes()).toContain('-mt-[calc(var(--header-h)+1.5rem)]')
  })

  it('still renders the hero and call to action when the landing query fails', async () => {
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
  })
})
