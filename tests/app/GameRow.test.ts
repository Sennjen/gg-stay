import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameRow from '~/components/GameRow.vue'
import GameCard from '~/components/GameCard.vue'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  metacritic: 92,
  cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  screenshots: [],
  platformFamilies: ['PC'] as const,
  platforms: [{ id: '4', slug: 'pc', name: 'PC' }],
  genres: [{ id: '4', slug: 'action', name: 'Action' }],
  price: null,
  localisation: null,
  madeInUkraine: false,
}

const games = Array.from({ length: 6 }, (_, index) => ({
  ...game,
  id: String(index),
  slug: `${game.slug}-${index}`,
}))

describe('GameRow', () => {
  it('renders a display-face title and one GameCard per game, all lazy', async () => {
    const wrapper = await mountSuspended(GameRow, { props: { title: 'Нові релізи', games } })
    expect(wrapper.get('h2').classes()).toContain('font-display-heading')
    expect(wrapper.get('h2').text()).toBe('Нові релізи')
    const cards = wrapper.findAllComponents(GameCard)
    expect(cards).toHaveLength(6)
    for (const card of cards) {
      expect(card.props('eager')).toBe(false)
    }
  })

  it('renders nothing for an empty list', async () => {
    const wrapper = await mountSuspended(GameRow, { props: { title: 'Нові релізи', games: [] } })
    expect(wrapper.find('section').exists()).toBe(false)
    expect(wrapper.findAllComponents(GameCard)).toHaveLength(0)
  })

  it('renders an "all" link with the given href and label when moreTo is set', async () => {
    const wrapper = await mountSuspended(GameRow, {
      props: {
        title: 'Нові релізи',
        games,
        moreTo: '/games?sort=RELEASED_DESC',
        moreLabel: 'Усі →',
      },
    })
    const link = wrapper.get('[data-test="row-more-link"]')
    expect(link.attributes('href')).toBe('/games?sort=RELEASED_DESC')
    expect(link.text()).toBe('Усі →')
  })

  it('falls back to a translated label when moreTo is set without moreLabel', async () => {
    const wrapper = await mountSuspended(GameRow, {
      props: { title: 'Нові релізи', games, moreTo: '/games' },
    })
    expect(wrapper.get('[data-test="row-more-link"]').text()).toBe('Усі ігри')
  })

  it('renders no "all" link when moreTo is absent', async () => {
    const wrapper = await mountSuspended(GameRow, { props: { title: 'Нові релізи', games } })
    expect(wrapper.find('[data-test="row-more-link"]').exists()).toBe(false)
  })
})
