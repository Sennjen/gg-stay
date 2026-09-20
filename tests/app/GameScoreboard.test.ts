import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import GameScoreboard from '~/components/GameScoreboard.vue'
import MetacriticBadge from '~/components/MetacriticBadge.vue'
import PlatformIcons from '~/components/PlatformIcons.vue'
import PriceTag from '~/components/PriceTag.vue'
import { formatDecimal, formatNumber } from '~/utils/format'

const NOW = '2026-09-18T12:00:00.000Z'

const game = {
  released: '2015-05-18',
  metacritic: 92,
  rating: 4.65,
  ratingsCount: 6800,
  platformFamilies: ['PC', 'PLAYSTATION'] as const,
  stores: [] as {
    store: string
    priceUah: number | null
    regularPriceUah: number | null
    discountPercent: number | null
    updatedAt: string | null
  }[],
  localisation: null as { text: boolean; audio: boolean } | null,
}

describe('GameScoreboard', () => {
  it('shows a visible caption for every item, not just a screen-reader label', async () => {
    const wrapper = await mountSuspended(GameScoreboard, { props: { game } })
    expect(wrapper.get('dl').exists()).toBe(true)
    const dts = wrapper.findAll('dt')
    expect(dts.every((dt) => !dt.classes().includes('sr-only'))).toBe(true)
    const captions = dts.map((dt) => dt.text())
    expect(captions).toEqual([
      'Дата виходу',
      'Metacritic',
      'Оцінка гравців',
      'Платформи',
      'Українська',
    ])
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
          stores: [],
          localisation: null,
        },
      },
    })
    expect(wrapper.findComponent(MetacriticBadge).exists()).toBe(false)
    expect(wrapper.findComponent(PlatformIcons).exists()).toBe(false)
    // The localisation item is always shown (it has an explicit "None" state) — only the price
    // item, released, Metacritic and rating disappear entirely without data.
    expect(wrapper.findAll('dt')).toHaveLength(1)
  })

  describe('price', () => {
    it('shows the Steam price and discount from the stores list, and when it was updated', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: {
          game: {
            ...game,
            stores: [
              {
                store: 'steam',
                priceUah: 337,
                regularPriceUah: 1349,
                discountPercent: 75,
                updatedAt: '2026-09-18T09:00:00.000Z',
              },
            ],
          },
          now: NOW,
        },
      })
      expect(wrapper.text()).toContain('Ціна в Steam')
      const priceTag = wrapper.findComponent(PriceTag)
      expect(priceTag.exists()).toBe(true)
      expect(priceTag.props('price')).toMatchObject({
        bestUah: 337,
        regularUah: 1349,
        discountPercent: 75,
      })
      expect(wrapper.text()).toContain('оновлено 3 години тому')
    })

    it('omits the price item entirely when there is no Steam price', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: { game: { ...game, stores: [] }, now: NOW },
      })
      expect(wrapper.text()).not.toContain('Ціна в Steam')
      expect(wrapper.findComponent(PriceTag).exists()).toBe(false)
    })

    it('ignores a non-Steam store offer for the scoreboard price', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: {
          game: {
            ...game,
            stores: [
              {
                store: 'gog',
                priceUah: 500,
                regularPriceUah: null,
                discountPercent: null,
                updatedAt: '2026-09-18T09:00:00.000Z',
              },
            ],
          },
          now: NOW,
        },
      })
      expect(wrapper.findComponent(PriceTag).exists()).toBe(false)
    })
  })

  describe('localisation', () => {
    it('shows "Текст і озвучка" when the game has Ukrainian audio', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: { game: { ...game, localisation: { text: true, audio: true } } },
      })
      expect(wrapper.text()).toContain('Українська')
      expect(wrapper.text()).toContain('Текст і озвучка')
    })

    it('shows "Текст" when the game has Ukrainian text only', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: { game: { ...game, localisation: { text: true, audio: false } } },
      })
      expect(wrapper.text()).toContain('Текст')
      expect(wrapper.text()).not.toContain('Текст і озвучка')
    })

    it('shows "Немає" when there is no Ukrainian localisation', async () => {
      const wrapper = await mountSuspended(GameScoreboard, {
        props: { game: { ...game, localisation: null } },
      })
      expect(wrapper.text()).toContain('Немає')
    })
  })
})
