import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameHero from '~/components/GameHero.vue'

describe('GameHero', () => {
  it('renders the title in the display heading style with the real text as the accessible name', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: { name: 'The Witcher 3: Wild Hunt', coverUrl: null },
    })
    const heading = wrapper.get('h1')
    expect(heading.classes()).toContain('font-display-heading')
    expect(heading.text()).toBe('The Witcher 3: Wild Hunt')
  })

  it('renders the cover as an eager, high-priority image with explicit dimensions and the game name as alt', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: {
        name: 'The Witcher 3: Wild Hunt',
        coverUrl: 'https://media.rawg.io/media/games/618/abc.jpg',
      },
    })
    const cover = wrapper.get('img')
    expect(cover.attributes('alt')).toBe('The Witcher 3: Wild Hunt')
    expect(cover.attributes('loading')).toBe('eager')
    expect(cover.attributes('fetchpriority')).toBe('high')
    expect(cover.attributes('width')).toBeTruthy()
    expect(cover.attributes('height')).toBeTruthy()
  })

  it('gives the cover a real srcset: resize/1280 for mid-size screens, original for the largest', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: {
        name: 'The Witcher 3: Wild Hunt',
        coverUrl: 'https://media.rawg.io/media/games/618/abc.jpg',
      },
    })
    const srcset = wrapper.get('img').attributes('srcset') ?? ''
    expect(srcset).toContain('resize/1280/-/games/618/abc.jpg')
    expect(srcset).toContain('https://media.rawg.io/media/games/618/abc.jpg')
  })

  it('renders no cover image without a cover url', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: { name: 'The Witcher 3: Wild Hunt', coverUrl: null },
    })
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('renders slot content (the scoreboard) below the title', async () => {
    const wrapper = await mountSuspended(GameHero, {
      props: { name: 'The Witcher 3: Wild Hunt', coverUrl: null },
      slots: { default: '<div data-test="scoreboard-slot">scoreboard</div>' },
    })
    expect(wrapper.find('[data-test="scoreboard-slot"]').exists()).toBe(true)
  })
})
