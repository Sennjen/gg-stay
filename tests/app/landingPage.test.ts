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
    data: { landing: { featured: null, carousel: [], shelves, totalGames: 0, year: 2031 } },
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
    more: section.find('[data-test="row-more-link"]').text(),
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
    const wrapper = await renderLanding()
    // The year is the answer's — the one the resolver built the shelf for — never the clock's.
    expect(rows(wrapper)).toEqual([
      { title: 'Зроблено в Україні', href: '/games?madeInUkraine=1', more: 'Усі ігри', cards: 4 },
      {
        title: 'Українською',
        href: '/games?ukrainianLocalisation=ANY',
        more: 'Усі ігри',
        cards: 4,
      },
      { title: 'Зі знижкою', href: '/games?onSaleMinPercent=30', more: 'Усі ігри', cards: 4 },
      // Not "Усі ігри": the link opens the year the shelf was ranked from, and says so.
      {
        title: 'Найкращі цього року',
        href: '/games?yearFrom=2031&yearTo=2031',
        more: 'Усі ігри цього року',
        cards: 4,
      },
      { title: 'Очікувані', href: '/games?upcoming=1', more: 'Усі ігри', cards: 4 },
    ])
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
    shelves = [
      { id: 'MADE_IN_UKRAINE', games: cards(1) },
      { id: 'BEST_THIS_YEAR', games: cards(301) },
    ]
    const wrapper = await renderLanding('/en')
    expect(rows(wrapper)).toEqual([
      { title: 'Made in Ukraine', href: '/en/games?madeInUkraine=1', more: 'All games', cards: 4 },
      {
        title: 'Best of this year',
        href: '/en/games?yearFrom=2031&yearTo=2031',
        more: "All of this year's games",
        cards: 4,
      },
    ])
  })

  it('skip a shelf this page does not know yet instead of failing', async () => {
    // A newer API during a deploy may answer with a shelf an older page has no definition for.
    shelves = [
      { id: 'SOMETHING_NEW', games: cards(501) },
      { id: 'UPCOMING', games: cards(401) },
    ]
    const wrapper = await renderLanding()
    expect(rows(wrapper).map((row) => row.title)).toEqual(['Очікувані'])
  })
})
