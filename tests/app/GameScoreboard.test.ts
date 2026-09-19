import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameScoreboard from '~/components/GameScoreboard.vue'
import MetacriticBadge from '~/components/MetacriticBadge.vue'
import PlatformIcons from '~/components/PlatformIcons.vue'
import { formatDecimal, formatNumber } from '~/utils/format'

const game = {
  released: '2015-05-18',
  metacritic: 92,
  rating: 4.65,
  ratingsCount: 6800,
  platformFamilies: ['PC', 'PLAYSTATION'] as const,
}

describe('GameScoreboard', () => {
  it('shows a visible caption for every item, not just a screen-reader label', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    expect(wrapper.get('dl').exists()).toBe(true)
    const dts = wrapper.findAll('dt')
    expect(dts.every((dt) => !dt.classes().includes('sr-only'))).toBe(true)
    const captions = dts.map((dt) => dt.text())
    expect(captions).toEqual(['Дата виходу', 'Metacritic', 'Оцінка гравців', 'Платформи'])
    expect(wrapper.text()).toContain('18 травня 2015')
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(true)
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(true)
  })

  it('renders the rating value in the interface face with tabular figures, not mono', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    const value = wrapper.get('.font-tabular')
    expect(value.text()).toBe(formatDecimal(4.65, 'uk-UA'))
    expect(value.classes()).not.toContain('font-numeric')
  })

  it('reads as a rating: star, value, scale, then the count as secondary text', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    const ratingDd = wrapper.findAll('dd')[2]!
    expect(ratingDd.find('svg').attributes('aria-hidden')).toBe('true')
    expect(ratingDd.text()).toContain(formatDecimal(4.65, 'uk-UA'))
    expect(ratingDd.text()).toContain('з 5')
    expect(ratingDd.text()).toContain(formatNumber(6800, 'uk-UA'))
    expect(ratingDd.text()).toContain('оцінок')
  })

  it('exposes a single natural-language accessible name for the rating item', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    const ratingDd = wrapper.findAll('dd')[2]!
    expect(ratingDd.attributes('aria-label')).toBe(
      `Оцінка гравців: ${formatDecimal(4.65, 'uk-UA')} з 5, ${formatNumber(6800, 'uk-UA')} оцінок`,
    )
  })

  it('omits the count when there is a rating but no ratings count', async () => {
    const wrapper = await mountSuspended(GameScoreboard, {
      props: { game: { ...game, ratingsCount: null } },
    })
    const ratingDd = wrapper.findAll('dd')[2]!
    expect(ratingDd.text()).not.toContain('оцінок')
    expect(ratingDd.attributes('aria-label')).toBe(
      `Оцінка гравців: ${formatDecimal(4.65, 'uk-UA')} з 5`,
    )
  })

  it('omits the whole item when there is no rating', async () => {
    const wrapper = await mountSuspended(GameScoreboard, {
      props: { game: { ...game, rating: null, ratingsCount: null } },
    })
    expect(wrapper.text()).not.toContain('з 5')
  })

  it.each([
    [1, 'оцінка'],
    [2, 'оцінки'],
    [5, 'оцінок'],
    [11, 'оцінок'],
    [21, 'оцінка'],
    [22, 'оцінки'],
    [25, 'оцінок'],
    [101, 'оцінка'],
  ])('uses the correct Ukrainian plural form for %i (%s)', async (count, form) => {
    const wrapper = await mountSuspended(GameScoreboard, {
      props: { game: { ...game, ratingsCount: count } },
    })
    const ratingDd = wrapper.findAll('dd')[2]!
    expect(ratingDd.text()).toContain(form)
  })

  it('omits items that are missing', async () => {
    const wrapper = await mountSuspended(GameScoreboard, {
      props: {
        game: {
          released: null,
          metacritic: null,
          rating: null,
          ratingsCount: null,
          platformFamilies: [],
        },
      },
    })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(false)
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(false)
    expect(wrapper.findAll('dt')).toHaveLength(0)
  })
})
