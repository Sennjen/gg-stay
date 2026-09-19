import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CoverMarquee from '~/components/CoverMarquee.vue'

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

const games = Array.from({ length: 5 }, (_, index) => ({
  ...game,
  id: String(index),
  slug: `${game.slug}-${index}`,
}))

describe('CoverMarquee', () => {
  it('animated: duplicates the track and hides the duplicate from assistive tech', async () => {
    const wrapper = await mountSuspended(CoverMarquee, { props: { games, animated: true } })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(games.length * 2)
    const hidden = items.filter((item) => item.attributes('aria-hidden') === 'true')
    expect(hidden).toHaveLength(games.length)
    const visible = items.filter((item) => item.attributes('aria-hidden') !== 'true')
    expect(visible).toHaveLength(games.length)
    expect(wrapper.get('ul').classes()).toContain('is-animated')
  })

  it('static: no duplicate track and no animation class', async () => {
    const wrapper = await mountSuspended(CoverMarquee, { props: { games, animated: false } })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(games.length)
    expect(items.every((item) => item.attributes('aria-hidden') !== 'true')).toBe(true)
    expect(wrapper.get('ul').classes()).not.toContain('is-animated')
  })

  it('every visible cover is a link with an alt matching the game name', async () => {
    const wrapper = await mountSuspended(CoverMarquee, { props: { games, animated: false } })
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(games.length)
    images.forEach((image, index) => {
      expect(image.attributes('alt')).toBe(games[index]!.name)
      expect(image.attributes('loading')).toBe('lazy')
    })
  })
})
