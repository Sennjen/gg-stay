import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameCard from '~/components/GameCard.vue'

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

describe('GameCard', () => {
  it('links to the detail page and shows core data with a localised date', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('a').attributes('href')).toBe('/games/the-witcher-3-wild-hunt')
    expect(wrapper.text()).toContain('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain('18 травня 2015')
    expect(wrapper.text()).toContain('92')
    expect(wrapper.text()).toContain('PC')
  })

  it('renders an image with explicit dimensions and the game name as alt', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const image = wrapper.get('img')
    expect(image.attributes('alt')).toBe('The Witcher 3: Wild Hunt')
    expect(image.attributes('width')).toBe('420')
    expect(image.attributes('height')).toBe('236')
  })

  it('renders no price or localisation area when the game is not indexed', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/N\/A|₴/)
  })

  it('shows a text fallback without a cover', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game: { ...game, cover: null } } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('Немає обкладинки')
  })

  it('lazy-loads the cover image by default', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('img').attributes('loading')).toBe('lazy')
  })

  it('eager-loads the cover image when eager is true', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game, eager: true } })
    expect(wrapper.get('img').attributes('loading')).toBe('eager')
  })
})
