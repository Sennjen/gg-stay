import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { clearNuxtData } from '#app'
import LandingPage from '~/pages/index.vue'

/**
 * The landing page against a stubbed BFF: the shelves the answer carries become rows, in the
 * answer's order, each with its visible title and an "Усі ігри" link to the catalog URL
 * `shared/shelves.ts` gives that shelf.
 */

function card(id: number) {
  return {
    id: String(id),
    slug: `game-${id}`,
    name: `Game ${id}`,
    released: '2020-06-01',
    metacritic: null,
    cover: null,
    screenshots: [],
    platformFamilies: ['PC'],
    price: null,
    localisation: null,
    madeInUkraine: id < 100,
  }
}

const cards = (from: number) => Array.from({ length: 4 }, (_, offset) => card(from + offset))

let shelves: { id: string; games: ReturnType<typeof card>[] }[] = []

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: () => ({
    data: { landing: { featured: null, carousel: [], shelves, totalGames: 0 } },
  }),
})

afterEach(() => {
  shelves = []
  // Every test asks the same operation with the same (empty) variables, so the cached answer of
  // the previous one would otherwise be served again.
  clearNuxtData()
})

async function renderLanding(route = '/') {
  const wrapper = await mountSuspended(LandingPage, { route })
  await flushPromises()
  return wrapper
}

function rows(wrapper: Awaited<ReturnType<typeof renderLanding>>) {
  return wrapper.findAll('section[data-test^="shelf-"]').map((section) => ({
    title: section.get('h2').text(),
    href: section.find('[data-test="row-more-link"]').attributes('href'),
    cards: section.findAll('[data-test="game-card"]').length,
  }))
}

describe('the landing shelves', () => {
  it('render every shelf the answer carries, in its order, titled and linked', async () => {
    shelves = [
      { id: 'MADE_IN_UKRAINE', games: cards(1) },
      { id: 'UKRAINIAN', games: cards(101) },
      { id: 'ON_SALE', games: cards(201) },
      { id: 'BEST_THIS_YEAR', games: cards(301) },
      { id: 'UPCOMING', games: cards(401) },
    ]
    const year = new Date().getUTCFullYear()
    const wrapper = await renderLanding()
    expect(rows(wrapper)).toEqual([
      { title: 'Зроблено в Україні', href: '/games?madeInUkraine=1', cards: 4 },
      { title: 'Українською', href: '/games?ukrainianLocalisation=ANY', cards: 4 },
      { title: 'Зі знижкою', href: '/games?onSaleMinPercent=30', cards: 4 },
      {
        title: 'Найкращі цього року',
        href: `/games?yearFrom=${year}&yearTo=${year}&sort=RATING_DESC`,
        cards: 4,
      },
      { title: 'Очікувані', href: '/games?upcoming=1', cards: 4 },
    ])
    for (const link of wrapper.findAll('[data-test="row-more-link"]')) {
      expect(link.text()).toBe('Усі ігри')
    }
  })

  it('render only the shelves the answer kept', async () => {
    shelves = [
      { id: 'BEST_THIS_YEAR', games: cards(301) },
      { id: 'UPCOMING', games: cards(401) },
    ]
    const wrapper = await renderLanding()
    expect(rows(wrapper).map((row) => row.title)).toEqual(['Найкращі цього року', 'Очікувані'])
  })

  it('title and link the shelves in English under /en', async () => {
    shelves = [{ id: 'MADE_IN_UKRAINE', games: cards(1) }]
    const wrapper = await renderLanding('/en')
    expect(rows(wrapper)).toEqual([
      { title: 'Made in Ukraine', href: '/en/games?madeInUkraine=1', cards: 4 },
    ])
    expect(wrapper.get('[data-test="row-more-link"]').text()).toBe('All games')
  })
})
