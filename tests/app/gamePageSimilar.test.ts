import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { clearNuxtData } from '#app'
import GamePage from '~/pages/games/[slug].vue'

/**
 * The game page's "Схожі ігри" row against a stubbed BFF: a titled row of cards below the gallery
 * and the store links when the answer has similar games, and nothing at all when it has none.
 */

function card(id: number) {
  return {
    id: String(id),
    slug: `similar-${id}`,
    name: `Similar ${id}`,
    released: '2020-06-01',
    metacritic: null,
    cover: null,
    screenshots: [],
    platformFamilies: ['PC'],
    price: null,
    localisation: null,
    madeInUkraine: false,
  }
}

let similar: ReturnType<typeof card>[] = []

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: () => ({
    data: {
      game: {
        id: '3328',
        slug: 'the-witcher-3-wild-hunt',
        name: 'The Witcher 3: Wild Hunt',
        localizedDescription: null,
        released: '2015-05-18',
        rating: null,
        ratingsCount: null,
        metacritic: null,
        playtime: null,
        ageRating: null,
        gameModes: [],
        website: null,
        cover: null,
        screenshots: [],
        platformFamilies: ['PC'],
        platforms: [],
        genres: [],
        developers: [],
        publishers: [],
        stores: [
          {
            store: 'gog',
            url: 'https://www.gog.com/game/the_witcher_3',
            priceUah: null,
            regularPriceUah: null,
            discountPercent: null,
            isFree: null,
            updatedAt: null,
          },
        ],
        localisation: null,
        madeInUkraine: false,
        similar,
      },
    },
  }),
})

afterEach(() => {
  similar = []
  clearNuxtData()
})

async function renderGame(route = '/games/the-witcher-3-wild-hunt') {
  const wrapper = await mountSuspended(GamePage, { route })
  await flushPromises()
  return wrapper
}

describe('the similar games row', () => {
  it('shows the similar games under a visible title, after the store links', async () => {
    similar = [1, 2, 3, 4].map(card)
    const wrapper = await renderGame()
    const row = wrapper.get('[data-test="similar-games"]')
    expect(row.get('h2').text()).toBe('Схожі ігри')
    expect(row.findAll('[data-test="game-card"]')).toHaveLength(4)
    expect(row.text()).toContain('Similar 1')
    // Below the store links in document order.
    const html = wrapper.html()
    expect(html.indexOf('data-test="similar-games"')).toBeGreaterThan(html.indexOf('gog.com'))
    // A list of suggestions, not a catalog page: no "Усі ігри" link.
    expect(row.find('[data-test="row-more-link"]').exists()).toBe(false)
  })

  it('is absent when the answer has no similar games', async () => {
    similar = []
    const wrapper = await renderGame()
    expect(wrapper.find('[data-test="similar-games"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Схожі ігри')
  })

  it('is titled in English under /en', async () => {
    similar = [1, 2, 3, 4].map(card)
    const wrapper = await renderGame('/en/games/the-witcher-3-wild-hunt')
    expect(wrapper.get('[data-test="similar-games"] h2').text()).toBe('Similar games')
  })
})
