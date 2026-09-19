import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameGrid from '~/components/GameGrid.vue'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  metacritic: 92,
  cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
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

describe('GameGrid', () => {
  it('eager-loads only the first four covers', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(6)
    images.forEach((image, index) => {
      expect(image.attributes('loading')).toBe(index < 4 ? 'eager' : 'lazy')
    })
  })
})
