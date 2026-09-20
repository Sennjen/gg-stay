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
}

const games = Array.from({ length: 7 }, (_, index) => ({
  ...game,
  id: String(index),
  slug: `${game.slug}-${index}`,
}))

describe('GameGrid', () => {
  it('eager-loads only the first two covers, matching the two-column phone first row', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(7)
    images.forEach((image, index) => {
      expect(image.attributes('loading')).toBe(index < 2 ? 'eager' : 'lazy')
    })
  })

  it('marks only the first cover as the high-priority LCP candidate', async () => {
    const wrapper = await mountSuspended(GameGrid, { props: { games } })
    const images = wrapper.findAll('img')
    expect(images[0]!.attributes('fetchpriority')).toBe('high')
    for (const image of images.slice(1)) {
      expect(image.attributes('fetchpriority')).toBeUndefined()
    }
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

  it('keeps every card the same height-stretching shape when only some have a price line', async () => {
    const mixed = games.map((entry, index) =>
      index % 2 === 0
        ? {
            ...entry,
            price: {
              bestUah: 1349,
              regularUah: null,
              bestStore: 'steam',
              discountPercent: 0,
              isFree: false,
              updatedAt: '2026-09-18T09:00:00.000Z',
            },
          }
        : entry,
    )
    const wrapper = await mountSuspended(GameGrid, { props: { games: mixed } })
    // CSS Grid stretches every item in a row to the tallest by default (no per-card change
    // needed), so the invariant this asserts is that the price line never opts a card out of
    // that: every `<li>` and every card's own root keep the same `h-full` stretching classes,
    // priced or not.
    const gridItems = wrapper.get('ul.grid').element.querySelectorAll(':scope > li')
    expect(gridItems.length).toBe(mixed.length)
    for (const item of gridItems) {
      expect(item.className).toContain('h-full')
    }
    for (const card of wrapper.findAllComponents(GameCard)) {
      expect(card.get('[data-test="game-card"]').classes()).toContain('h-full')
      expect(card.get('a').classes()).toEqual(
        expect.arrayContaining(['flex', 'h-full', 'flex-col']),
      )
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
