import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameCard from '~/components/GameCard.vue'
import MetacriticBadge from '~/components/MetacriticBadge.vue'
import PlatformIcons from '~/components/PlatformIcons.vue'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  metacritic: 92,
  cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  screenshots: [{ url: 'https://media.rawg.io/media/screenshots/1/shot.jpg' }],
  platformFamilies: ['PC', 'PLAYSTATION'] as const,
  platforms: [{ id: '4', slug: 'pc', name: 'PC' }],
  genres: [{ id: '4', slug: 'action', name: 'Action' }],
  price: null,
  localisation: null,
  madeInUkraine: false,
}

describe('GameCard', () => {
  it('links to the detail page and shows core data', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.get('a').attributes('href')).toBe('/games/the-witcher-3-wild-hunt')
    expect(wrapper.text()).toContain('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain('92')
  })

  it('shows only the release year, sliced from the ISO date, in mono', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.text()).toContain('2015')
    expect(wrapper.text()).not.toContain('травня')
    expect(wrapper.text()).not.toContain('18 травня 2015')
  })

  it('shows no year when released is missing', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game: { ...game, released: null } } })
    expect(wrapper.text()).not.toContain('2015')
  })

  it('renders a Metacritic badge when a score exists', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(true)
  })

  it('renders no Metacritic badge without a score', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, metacritic: null } },
    })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(false)
  })

  it('renders platform icons for the card platform families', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(true)
  })

  it('renders an image with explicit dimensions and the game name as alt', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const [cover] = wrapper.findAll('img')
    expect(cover!.attributes('alt')).toBe('The Witcher 3: Wild Hunt')
    expect(cover!.attributes('width')).toBe('420')
    expect(cover!.attributes('height')).toBe('236')
  })

  it('renders no price or localisation area when the game is not indexed', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/N\/A|₴/)
  })

  it('shows a text fallback without a cover', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, cover: null, screenshots: [] } },
    })
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

  it('renders a hidden hover image only when a screenshot exists', async () => {
    const wrapper = await mountSuspended(GameCard, { props: { game } })
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(2)
    const hoverImage = images[1]!
    expect(hoverImage.attributes('alt')).toBe('')
    expect(hoverImage.attributes('aria-hidden')).toBe('true')
    expect(hoverImage.attributes('loading')).toBe('lazy')
  })

  it('renders no hover image when there are no screenshots', async () => {
    const wrapper = await mountSuspended(GameCard, {
      props: { game: { ...game, screenshots: [] } },
    })
    expect(wrapper.findAll('img')).toHaveLength(1)
  })
})
