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
  it('shows the localised release date, badge, mono rating and platform icons in a labelled row', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    expect(wrapper.get('dl').exists()).toBe(true)
    expect(wrapper.text()).toContain('18 травня 2015')
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(true)
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(true)
    const numerics = wrapper.findAll('.font-numeric')
    expect(numerics.map((node) => node.text())).toContain(formatDecimal(4.65, 'uk-UA'))
  })

  it('shows the ratings count via an interpolated slot', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    expect(wrapper.text()).toContain('оцінок:')
    expect(wrapper.text()).toContain(formatNumber(6800, 'uk-UA'))
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
  })
})
