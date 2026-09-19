import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameGrid from '~/components/GameGrid.vue'
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

const games = Array.from({ length: 7 }, (_, index) => ({
  ...game,
  id: String(index),
  slug: `${game.slug}-${index}`,
}))

describe('GameGrid', () => {
  it('eager-loads only the first five covers, matching the five-column first row', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(7)
    images.forEach((image, index) => {
      expect(image.attributes('loading')).toBe(index < 5 ? 'eager' : 'lazy')
    })
  })

  it('renders card titles as h2, since the grid sits directly under the page h1 with no heading in between', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    expect(wrapper.findAll('h2')).toHaveLength(7)
    expect(wrapper.findAll('h3')).toHaveLength(0)
  })

  it('lays out 2 / 3 / 4 / 5 columns across breakpoints by default (grid layout)', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    const classes = wrapper.get('ul').classes()
    expect(classes).toEqual(
      expect.arrayContaining(['grid-cols-2', 'md:grid-cols-3', 'lg:grid-cols-4', 'xl:grid-cols-5']),
    )
    for (const card of wrapper.findAllComponents(GameCard)) {
      expect(card.props('layout')).toBe('grid')
    }
  })

  it('lays out a single column and passes layout="list" down to each card', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games, layout: 'list' } })
    const classes = wrapper.get('ul').classes()
    expect(classes).toContain('grid-cols-1')
    expect(classes).not.toContain('grid-cols-2')
    for (const card of wrapper.findAllComponents(GameCard)) {
      expect(card.props('layout')).toBe('list')
    }
  })
})
