import { describe, expect, it } from 'vitest'
import type { IndexMeta, IndexedGame, IndexedOffer } from '../../server/index/document'
import { OFFER_FRESH_FOR_MS } from '../../server/index/offerRules'
import {
  INDEX_STALE_AFTER_MS,
  PAGE_CACHE_TTL_SECONDS,
  cardTerms,
  withoutPrices,
} from '../../server/graphql/indexPath'
import type { GameCard } from '../../server/graphql/__generated__/resolvers-types'
import {
  DEV_FIXTURE_EXCHANGE_RATE,
  DEV_FIXTURE_GAMES,
  DEV_FIXTURE_META_EXTRA,
  DEV_FIXTURE_PRICES_UPDATED_AT,
  DEV_FIXTURE_SHELF_GAMES,
  DEV_FIXTURE_UKRAINIAN_GAMES,
  DEV_FIXTURE_UPDATED_AT,
} from '../fixtures/index/devGames'
import {
  countCalls,
  createTestCache,
  publishTestIndex,
  runQuery,
  type TestContext,
} from './support/yoga'

/**
 * `GameCard.cheaperAt` on every path that hands out a card: a catalog page the index answers, one
 * RAWG answers, the landing's shelves, its ring and its featured game, a game page's similar
 * games by either of their two routes, and the deal of the day. (`/api/ask` builds its rows from
 * the same functions; its cases are in `tests/server/ask/pipeline.test.ts`.) Every case is a real
 * GraphQL operation against yoga.
 *
 * The rule itself is one function and is tested on its boundaries where it lives
 * (`tests/server/index/offerRules.test.ts`). What is held here is that each path asks that
 * function, with the request's clock and the index's rate, and that a path which withholds a
 * card's price withholds this with it.
 *
 * The index is the development seed, at the moment its run ended: of its games exactly two have
 * another store clearly below Steam — The Witcher 3, GOG at about 404 ₴ against 675 ₴, and Metro
 * Exodus, the PlayStation Store at 95 ₴ against 749 ₴ (its GOG price is above Steam's). Sherlock
 * Holmes has a stale GOG price that would have won, and Stardew Valley is free on Steam.
 */

const NOW = DEV_FIXTURE_UPDATED_AT
const TODAY = NOW.slice(0, 10)
const HOUR = 60 * 60 * 1000

/** `NOW` moved back by `ms`. */
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString()

const SEED: IndexedGame[] = [
  ...DEV_FIXTURE_GAMES,
  ...DEV_FIXTURE_UKRAINIAN_GAMES,
  ...DEV_FIXTURE_SHELF_GAMES,
]

const WITCHER = 'the-witcher-3-wild-hunt'

type Meta = Omit<IndexMeta, 'version' | 'gameCount'>

const META: Meta = {
  updatedAt: DEV_FIXTURE_UPDATED_AT,
  pricesUpdatedAt: DEV_FIXTURE_PRICES_UPDATED_AT,
  ...DEV_FIXTURE_META_EXTRA,
}

/** The same index with prices too old to show: no card may carry one, or anything said of one. */
const STALE_META: Meta = { ...META, pricesUpdatedAt: ago(INDEX_STALE_AFTER_MS + HOUR) }

/** The seed with one game's document changed. */
const seedWith = (slug: string, change: (game: IndexedGame) => IndexedGame): IndexedGame[] =>
  SEED.map((game) => (game.slug === slug ? change(game) : game))

const context = async (
  documents: readonly IndexedGame[] = SEED,
  meta: Meta = META,
  overrides: TestContext = {},
): Promise<TestContext> => ({
  index: await publishTestIndex(documents, meta),
  now: NOW,
  today: TODAY,
  ...overrides,
})

interface Card {
  slug: string
  cheaperAt: string | null
  price: { bestUah: number } | null
}

/** The slugs of the cards that name a store, each with the store it names. */
const naming = (cards: readonly Card[]): [slug: string, store: string][] =>
  cards.flatMap((card) => (card.cheaperAt === null ? [] : [[card.slug, card.cheaperAt]]))

const CARD = /* GraphQL */ `
  fragment Card on GameCard {
    slug
    cheaperAt
    price {
      bestUah
    }
  }
`

const CATALOG = /* GraphQL */ `
  ${CARD}
  query Catalog($filter: GameFilter) {
    games(filter: $filter, pageSize: 40) {
      indexedOnly
      indexStale
      items {
        ...Card
      }
    }
  }
`

const catalog = async (
  context: TestContext,
  filter: Record<string, unknown> | null = null,
): Promise<{ indexedOnly: boolean; indexStale: boolean; items: Card[] }> => {
  const result = await runQuery(context, CATALOG, { filter })
  expect(result.errors).toBeUndefined()
  return result.data!.games
}

describe('cheaperAt on a catalog page the index answers', () => {
  // A price ceiling is a filter only the index can apply, and every seeded price is under it.
  const EVERY_PRICED_GAME = { priceMaxUah: 100_000 }

  it('names GOG on The Witcher 3’s card, the PlayStation Store on Metro Exodus’s, and no store on any other', async () => {
    const page = await catalog(await context(), EVERY_PRICED_GAME)

    expect(page.indexedOnly).toBe(true)
    expect(page.items.map((card) => card.slug)).toContain('metro-exodus')
    expect(page.items.map((card) => card.slug)).toContain('sherlock-holmes-chapter-one')
    expect(page.items.map((card) => card.slug)).toContain('stardew-valley')
    expect(naming(page.items)).toEqual([
      [WITCHER, 'gog'],
      ['metro-exodus', 'playstation-store'],
    ])
  })

  it('names no store that charges in dollars without a rate to weigh them by', async () => {
    const page = await catalog(
      await context(SEED, { ...META, exchangeRate: undefined }),
      EVERY_PRICED_GAME,
    )
    // A hryvnia price needs no rate.
    expect(naming(page.items)).toEqual([['metro-exodus', 'playstation-store']])
  })

  it('names nobody once Steam’s own price is older than an offer may be', async () => {
    const old = seedWith(WITCHER, (game) => ({
      ...game,
      priceUpdatedAt: ago(OFFER_FRESH_FOR_MS + 1),
    }))
    const page = await catalog(await context(old), EVERY_PRICED_GAME)

    // The card still shows the price — the index as a whole is not stale — and claims nothing.
    expect(page.items.find((card) => card.slug === WITCHER)).toEqual({
      slug: WITCHER,
      cheaperAt: null,
      price: { bestUah: 675 },
    })
  })

  it('withholds it with the prices while the index’s prices are stale', async () => {
    // Stale prices drop the price filters; a language filter still takes the index path.
    const page = await catalog(await context(SEED, STALE_META), { ukrainianLocalisation: 'ANY' })

    expect(page).toMatchObject({ indexedOnly: true, indexStale: true })
    const witcher = page.items.find((card) => card.slug === WITCHER)
    expect(witcher).toEqual({ slug: WITCHER, cheaperAt: null, price: null })
    expect(naming(page.items)).toEqual([])
  })

  it('costs the index nothing more: one metadata read and one search', async () => {
    const index = countCalls(await publishTestIndex(SEED, META))
    await catalog({ index, now: NOW, today: TODAY }, EVERY_PRICED_GAME)

    expect(index.calls.meta).toBe(1)
    expect(index.calls.search).toHaveLength(1)
    expect(index.calls.getMany).toEqual([])
  })

  it('is kept with the page it was worked out for, for as long as the page is', async () => {
    const cache = createTestCache()
    const index = countCalls(await publishTestIndex(SEED, META))
    const first = await catalog({ index, cache, now: NOW, today: TODAY }, EVERY_PRICED_GAME)
    // Ten minutes on the offers are ten minutes older, and the page is the one already made.
    const later = new Date(Date.parse(NOW) + (PAGE_CACHE_TTL_SECONDS - 1) * 1000).toISOString()
    const second = await catalog({ index, cache, now: later, today: TODAY }, EVERY_PRICED_GAME)

    expect(naming(first.items)).toEqual([
      [WITCHER, 'gog'],
      ['metro-exodus', 'playstation-store'],
    ])
    expect(second.items).toEqual(first.items)
    expect(index.calls.search).toHaveLength(1)
    expect(cache.writes).toHaveLength(1)
    expect(cache.writes[0]![1]).toBe(PAGE_CACHE_TTL_SECONDS)
  })

  it('is withheld from a page kept while the prices were fresh and served once they are stale', async () => {
    // The cache holds the canonical page; whoever serves a stale index strips it on the way out.
    const cache = createTestCache()
    const index = await publishTestIndex(SEED, META)
    const filter = { ukrainianLocalisation: 'ANY' }
    const fresh = await catalog({ index, cache, now: NOW, today: TODAY }, filter)
    const eightDaysOn = new Date(Date.parse(NOW) + INDEX_STALE_AFTER_MS + HOUR).toISOString()
    const stale = await catalog({ index, cache, now: eightDaysOn, today: TODAY }, filter)

    expect(naming(fresh.items)).toEqual([[WITCHER, 'gog']])
    expect(stale.indexStale).toBe(true)
    expect(naming(stale.items)).toEqual([])
    expect(stale.items.every((card) => card.price === null)).toBe(true)
  })
})

describe('cheaperAt on a catalog page RAWG answers', () => {
  it('is attached with the price, from the same document, to the cards the index holds', async () => {
    const page = await catalog(await context())

    expect(page.indexedOnly).toBe(false)
    // RAWG's fixture lists The Witcher 3, Portal 2, Stardew Valley and a game the index has never
    // seen, which keeps the nulls its card was mapped with.
    expect(page.items.find((card) => card.slug === WITCHER)).toEqual({
      slug: WITCHER,
      cheaperAt: 'gog',
      price: { bestUah: 675 },
    })
    expect(page.items.find((card) => card.slug === 'unreleased-sample')).toEqual({
      slug: 'unreleased-sample',
      cheaperAt: null,
      price: null,
    })
    expect(naming(page.items)).toEqual([[WITCHER, 'gog']])
  })

  it('names the store the document’s offers make the cheapest, whichever it is', async () => {
    // Stardew Valley for 400 ₴ on Steam, against the Microsoft Store's 385 ₴ and then its 360 ₴.
    const charging = (kopecks: number) =>
      seedWith('stardew-valley', (game) => ({
        ...game,
        priceUah: 400,
        regularPriceUah: 400,
        free: false,
        offers: game.offers!.map((offer): IndexedOffer =>
          offer.store === 'xbox-store'
            ? { ...offer, amount: kopecks, regularAmount: kopecks }
            : offer,
        ),
      }))

    const close = await catalog(await context(charging(38_500)))
    const clear = await catalog(await context(charging(36_000)))

    // 385 ₴ is under ten percent below 400 ₴; 360 ₴ is ten percent below to the hryvnia.
    expect(naming(close.items)).toEqual([[WITCHER, 'gog']])
    expect(naming(clear.items)).toEqual([
      [WITCHER, 'gog'],
      ['stardew-valley', 'xbox-store'],
    ])
  })

  it('is withheld with the prices while the index’s prices are stale', async () => {
    const page = await catalog(await context(SEED, STALE_META))

    expect(page).toMatchObject({ indexedOnly: false, indexStale: true })
    expect(page.items.find((card) => card.slug === WITCHER)).toEqual({
      slug: WITCHER,
      cheaperAt: null,
      price: null,
    })
    expect(naming(page.items)).toEqual([])
  })

  it('costs the index nothing more: one metadata read and one read of the page’s documents', async () => {
    const index = countCalls(await publishTestIndex(SEED, META))
    await catalog({ index, now: NOW, today: TODAY })

    expect(index.calls.meta).toBe(1)
    expect(index.calls.getMany).toHaveLength(1)
    expect(index.calls.search).toEqual([])
  })
})

describe('cheaperAt on the landing', () => {
  const LANDING = /* GraphQL */ `
    ${CARD}
    query Landing {
      landing {
        featured {
          game {
            ...Card
          }
        }
        carousel {
          ...Card
        }
        shelves {
          id
          games {
            ...Card
          }
        }
      }
    }
  `

  interface Landing {
    featured: { game: Card } | null
    carousel: Card[]
    shelves: { id: string; games: Card[] }[]
  }

  const landing = async (context: TestContext): Promise<Landing> => {
    const result = await runQuery(context, LANDING)
    expect(result.errors).toBeUndefined()
    return result.data!.landing
  }

  it('names GOG on The Witcher 3’s card on every shelf it is on, whoever filled the shelf', async () => {
    const answer = await landing(await context())

    // Two shelves the index fills hold the game, and so does the one RAWG fills from its fixture
    // list. (That list is too short for the year's best, which is left out, as on any landing.)
    const shelves = new Map(answer.shelves.map((shelf) => [shelf.id, shelf.games]))
    expect([...shelves.keys()]).toEqual(['MADE_IN_UKRAINE', 'UKRAINIAN', 'ON_SALE', 'UPCOMING'])
    for (const id of ['UKRAINIAN', 'UPCOMING']) {
      expect(naming(shelves.get(id)!), id).toEqual([[WITCHER, 'gog']])
    }
    // The sale shelf holds Metro Exodus as well, which names the PlayStation Store.
    expect(naming(shelves.get('ON_SALE')!)).toEqual([
      [WITCHER, 'gog'],
      ['metro-exodus', 'playstation-store'],
    ])
    // Made in Ukraine holds Metro Exodus and Sherlock Holmes, whose GOG prices name nobody: Metro
    // Exodus's card names the PlayStation Store, and Sherlock Holmes's names no store.
    expect(shelves.get('MADE_IN_UKRAINE')!.map((card) => card.slug)).toContain('metro-exodus')
    expect(naming(shelves.get('MADE_IN_UKRAINE')!)).toEqual([['metro-exodus', 'playstation-store']])
  })

  it('carries it on the featured game and the ring too: they are cards like any other', async () => {
    const answer = await landing(await context())

    expect(answer.featured!.game).toEqual({
      slug: WITCHER,
      cheaperAt: 'gog',
      price: { bestUah: 675 },
    })
    expect(naming(answer.carousel)).toEqual([[WITCHER, 'gog']])
  })

  it('withholds it with the prices while the index’s prices are stale', async () => {
    const answer = await landing(await context(SEED, STALE_META))

    const cards = [
      answer.featured!.game,
      ...answer.carousel,
      ...answer.shelves.flatMap((shelf) => shelf.games),
    ]
    expect(cards.filter((card) => card.slug === WITCHER).length).toBeGreaterThan(2)
    expect(cards.every((card) => card.price === null && card.cheaperAt === null)).toBe(true)
  })
})

describe('cheaperAt on a game page’s similar games', () => {
  const SIMILAR = /* GraphQL */ `
    ${CARD}
    query Similar($slug: String!) {
      game(slug: $slug) {
        similar {
          ...Card
        }
      }
    }
  `

  const similar = async (context: TestContext, slug: string): Promise<Card[]> => {
    const result = await runQuery(context, SIMILAR, { slug })
    expect(result.errors).toBeUndefined()
    return result.data!.game.similar
  }

  it('is on the cards of the list the refresh job stored', async () => {
    // Stardew Valley's stored list: The Witcher 3 and three more games of the seed.
    const stored = seedWith('stardew-valley', (game) => ({
      ...game,
      similar: [3328, 4200, 28201, 447825],
    }))
    const cards = await similar(await context(stored), 'stardew-valley')

    expect(cards.map((card) => card.slug)).toEqual([
      WITCHER,
      'portal-2',
      'metro-exodus',
      'sherlock-holmes-chapter-one',
    ])
    expect(naming(cards)).toEqual([
      [WITCHER, 'gog'],
      ['metro-exodus', 'playstation-store'],
    ])
  })

  it('is on the cards of the same-genre list a game without a stored one falls back to', async () => {
    // The Witcher 3's own page: its neighbours by genre, among them Metro Exodus, whose PlayStation
    // Store price is 95 ₴ against Steam's 749 ₴ — and, given here a GOG price of $9.99, about
    // 449 ₴, it is still the PlayStation Store the card names: the lower of the two.
    const cheaperMetro = seedWith('metro-exodus', (game) => ({
      ...game,
      offers: game.offers!.map((offer): IndexedOffer =>
        offer.store === 'gog' ? { ...offer, amount: 999, regularAmount: 999 } : offer,
      ),
    }))
    const cards = await similar(await context(cheaperMetro), WITCHER)

    expect(cards.length).toBeGreaterThanOrEqual(4)
    expect(naming(cards)).toEqual([['metro-exodus', 'playstation-store']])
  })

  it('withholds it with the prices while the index’s prices are stale, by either route', async () => {
    const stored = seedWith('stardew-valley', (game) => ({
      ...game,
      similar: [3328, 4200, 28201, 447825],
    }))
    const fromTheList = await similar(await context(stored, STALE_META), 'stardew-valley')
    const byGenre = await similar(await context(SEED, STALE_META), WITCHER)

    for (const cards of [fromTheList, byGenre]) {
      expect(cards.length).toBeGreaterThanOrEqual(4)
      expect(cards.every((card) => card.price === null && card.cheaperAt === null)).toBe(true)
    }
  })
})

describe('cheaperAt on the deal of the day', () => {
  const DEAL = /* GraphQL */ `
    ${CARD}
    query Deal {
      dealOfTheDay {
        ...Card
      }
    }
  `

  it('is on the day’s card, though the greeting states Steam’s price alone', async () => {
    // The one well-reviewed game at half price or better, so the day's game is not in doubt.
    const witcherOnly = SEED.filter((game) => game.slug === WITCHER)
    const result = await runQuery(await context(witcherOnly), DEAL)

    expect(result.errors).toBeUndefined()
    expect(result.data!.dealOfTheDay).toEqual({
      slug: WITCHER,
      cheaperAt: 'gog',
      price: { bestUah: 675 },
    })
  })
})

describe('the two things every path shares', () => {
  it('reads the rate out of the request’s one read of the metadata, and the request’s clock', async () => {
    const index = countCalls(await publishTestIndex(SEED, META))
    // The clock and the index are all `cardTerms` reads of a request.
    const shared = { index, now: NOW, today: TODAY } as unknown as Parameters<typeof cardTerms>[0]

    expect(await cardTerms(shared)).toEqual({ now: NOW, rate: DEV_FIXTURE_EXCHANGE_RATE })
    await cardTerms(shared)
    expect(index.calls.meta).toBe(1)
  })

  it('has no rate once the bank’s is older than the site may estimate with', async () => {
    const eightDaysOn = new Date(Date.parse(NOW) + 8 * 24 * HOUR).toISOString()
    const later = { ...(await context()), now: eightDaysOn } as Parameters<typeof cardTerms>[0]

    expect(await cardTerms(later)).toEqual({ now: eightDaysOn, rate: null })
  })

  it('takes the store off a card whose price it withholds, and leaves a card without either alone', () => {
    const card = (overrides: Partial<GameCard>): GameCard => ({
      id: '1',
      slug: 'one',
      name: 'One',
      screenshots: [],
      platformFamilies: [],
      platforms: [],
      genres: [],
      madeInUkraine: false,
      price: null,
      cheaperAt: null,
      ...overrides,
    })
    const price = {
      bestUah: 675,
      bestStore: 'steam',
      discountPercent: 0,
      isFree: false,
      updatedAt: NOW,
    }
    const bare = card({})
    const named = card({ price, cheaperAt: 'gog' })

    const [first, second, third] = withoutPrices([bare, named, card({ cheaperAt: 'gog' })])
    expect(first).toBe(bare)
    expect(second).toEqual({ ...named, price: null, cheaperAt: null })
    // A card that somehow names a store without a price is stripped of the name as well.
    expect(third!.cheaperAt).toBeNull()
    // The card the cache holds is not the one changed.
    expect(named.cheaperAt).toBe('gog')
  })
})
