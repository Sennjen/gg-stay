import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IndexMeta,
  IndexedExchangeRate,
  IndexedGame,
  IndexedOffer,
} from '../../server/index/document'
import { EXCHANGE_RATE_KEPT_MS, OFFER_FRESH_FOR_MS } from '../../server/index/offerRules'
import { INDEX_STALE_AFTER_MS } from '../../server/graphql/indexPath'
import { PRICE_REFRESH_AFTER_MS } from '../../server/graphql/resolvers/game'
import type { RawgFetch } from '../../server/rawg/rawgFetch'
import type { SteamPrice } from '../../server/steam/price'
import { UpstreamError } from '../../server/upstream/errors'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import witcherStores from '../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json' with { type: 'json' }
import {
  countCalls,
  fixtureRawg,
  postQuery,
  publishTestIndex,
  runQuery,
  steamPricesReturning,
  type CountingIndex,
  type TestContext,
} from './support/yoga'

/**
 * What a game page says of the prices GOG and the Microsoft Store charge: which rows carry one,
 * in which fields, which row is the cheapest, and what the page is told of the rate — on the page
 * RAWG answers and on the one built from the index document. Every case is a real GraphQL
 * operation against yoga.
 *
 * Time is the request's own clock (`GraphQLContext.now`), which each case sets: an offer or a rate
 * is so many milliseconds old because the case dates it so, and nothing here reads or waits for a
 * real clock. RAWG is the recorded fixtures, and answers at once; the index is the in-memory one,
 * holding the documents a case publishes. No test calls a store — the site has no way to.
 */

const NOW = '2026-10-12T12:00:00.000Z'

/** `NOW` moved back by `ms`. */
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString()

const HOUR = 60 * 60 * 1000

/** When the stores below were last read: six hours ago, as after the job's morning run. */
const READ_AT = ago(6 * HOUR)

const WITCHER = 'the-witcher-3-wild-hunt'
const STARDEW = 'stardew-valley'

const RATE: IndexedExchangeRate = {
  currency: 'USD',
  uah: 44.9567,
  date: '2026-10-12',
  readAt: READ_AT,
}

/** The index's metadata: prices confirmed three hours ago, and the bank's rate as `rate` says. */
const metaWith = (
  rate: IndexedExchangeRate | null = RATE,
  pricesUpdatedAt: string = ago(3 * HOUR),
): Omit<IndexMeta, 'version' | 'gameCount'> => ({
  updatedAt: pricesUpdatedAt,
  pricesUpdatedAt,
  ...(rate ? { exchangeRate: rate } : {}),
})

const GOG_PAGE = 'https://www.gog.com/en/game/the_witcher_3_wild_hunt'
const GOG_TITLE = 'The Witcher 3: Wild Hunt - Game of the Year Edition'
/** The link RAWG's own fixture gives for the game on GOG: another address than the offer's. */
const RAWG_GOG_LINK = witcherStores.results[1]!.url
const STEAM_PAGE = 'https://store.steampowered.com/app/292030/'
const MICROSOFT_PAGE = 'https://www.microsoft.com/uk-ua/p/stardew-valley/c3d891z6tnqm'

const gogOffer = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'gog',
  title: GOG_TITLE,
  amount: 899,
  regularAmount: 3999,
  currency: 'USD',
  discountPercent: 78,
  url: GOG_PAGE,
  updatedAt: READ_AT,
  ...overrides,
})

const microsoftOffer = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'xbox-store',
  title: 'Stardew Valley',
  amount: 38_500,
  regularAmount: 38_500,
  currency: 'UAH',
  discountPercent: 0,
  url: MICROSOFT_PAGE,
  updatedAt: READ_AT,
  ...overrides,
})

/**
 * The Witcher 3 as the index holds it — 675 ₴ on Steam, read three hours ago, so the page does not
 * ask Steam again — with the offers a case gives it.
 */
const witcher = (offers: IndexedOffer[] | null, overrides: Partial<IndexedGame> = {}) => {
  const { offers: _seeded, ...document } = DEV_FIXTURE_GAMES[0]!
  return {
    ...document,
    priceUpdatedAt: ago(3 * HOUR),
    ...(offers ? { offers } : {}),
    ...overrides,
  } satisfies IndexedGame
}

/** Stardew Valley as the index holds it: free on Steam, and on the Xbox store at RAWG. */
const stardew = (offers: IndexedOffer[]) => {
  const { offers: _seeded, ...document } = DEV_FIXTURE_GAMES[2]!
  return { ...document, priceUpdatedAt: ago(3 * HOUR), offers } satisfies IndexedGame
}

const PAGE = /* GraphQL */ `
  query Page($slug: String!) {
    game(slug: $slug) {
      stores {
        store
        url
        title
        priceUah
        regularPriceUah
        discountPercent
        isFree
        updatedAt
        foreignPrice {
          amount
          currency
        }
        foreignRegularPrice {
          amount
          currency
        }
        approxUah
        cheapest
      }
      exchangeRate {
        currency
        uah
        date
      }
      partial
    }
  }
`

interface Row {
  store: string
  url: string
  title: string | null
  priceUah: number | null
  regularPriceUah: number | null
  discountPercent: number | null
  isFree: boolean | null
  updatedAt: string | null
  foreignPrice: { amount: number; currency: string } | null
  foreignRegularPrice: { amount: number; currency: string } | null
  approxUah: number | null
  cheapest: boolean
}

interface Page {
  stores: Row[]
  exchangeRate: { currency: string; uah: number; date: string } | null
  partial: boolean
}

/** A row that is a link and nothing more: what every store's row was before it had a price. */
const LINK = {
  title: null,
  priceUah: null,
  regularPriceUah: null,
  discountPercent: null,
  isFree: null,
  updatedAt: null,
  foreignPrice: null,
  foreignRegularPrice: null,
  approxUah: null,
  cheapest: false,
}

/** Steam's row as the index prices the Witcher: 675 ₴, down from 1 349 ₴. */
const STEAM_ROW: Row = {
  ...LINK,
  store: 'steam',
  url: STEAM_PAGE,
  priceUah: 675,
  regularPriceUah: 1349,
  discountPercent: 50,
  isFree: false,
  updatedAt: ago(3 * HOUR),
}

/** GOG's row with its fresh dollar price and the estimate: $8.99 is about 404 ₴. */
const GOG_ROW: Row = {
  ...LINK,
  store: 'gog',
  url: GOG_PAGE,
  title: GOG_TITLE,
  discountPercent: 78,
  isFree: false,
  updatedAt: READ_AT,
  foreignPrice: { amount: 8.99, currency: 'USD' },
  foreignRegularPrice: { amount: 39.99, currency: 'USD' },
  approxUah: 404,
}

const SHOWN_RATE = { currency: 'USD', uah: 44.9567, date: '2026-10-12' }

const indexHolding = async (documents: IndexedGame[], meta = metaWith()): Promise<CountingIndex> =>
  countCalls(await publishTestIndex(documents, meta))

async function page(context: TestContext, slug: string = WITCHER): Promise<Page> {
  const { data, errors } = await runQuery({ now: NOW, ...context }, PAGE, { slug })
  expect(errors).toBeUndefined()
  return data!.game as Page
}

const cheapestOf = (answer: Page): string[] =>
  answer.stores.filter((row) => row.cheapest).map((row) => row.store)

/** RAWG with its detail failing, so the index answers the page at once, without the budget. */
const rawgWithoutDetail: RawgFetch = async (path, params, options) => {
  if (!path.includes('/', 'games/'.length)) throw new UpstreamError('RAWG', 'ERROR', 502)
  return fixtureRawg(path, params, options)
}

/** A page built from the index document alone. Its one line in the log is silenced. */
async function indexPage(context: TestContext, slug: string = WITCHER): Promise<Page> {
  const answer = await page({ rawg: rawgWithoutDetail, ...context }, slug)
  expect(answer.partial).toBe(true)
  return answer
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what the other stores charge, on a page RAWG answered', () => {
  it('puts GOG’s dollar price on RAWG’s GOG row: the estimate, the store’s title and its own address', async () => {
    const index = await indexHolding([witcher([gogOffer()])])

    const answer = await page({ index })

    expect(answer.stores).toEqual([STEAM_ROW, { ...GOG_ROW, cheapest: true }])
    // The row leads to the page the price is charged on, not to the link RAWG keeps.
    expect(answer.stores[1]!.url).not.toBe(RAWG_GOG_LINK)
    expect(answer.exchangeRate).toEqual(SHOWN_RATE)
    expect(answer.partial).toBe(false)
  })

  it('puts the Microsoft Store’s hryvnia price in the fields Steam’s price fills', async () => {
    const index = await indexHolding([stardew([microsoftOffer()])])

    const answer = await page({ index }, STARDEW)

    expect(answer.stores).toEqual([
      {
        ...LINK,
        store: 'steam',
        url: 'https://store.steampowered.com/app/413150/',
        priceUah: 0,
        regularPriceUah: null,
        discountPercent: 0,
        isFree: true,
        updatedAt: ago(3 * HOUR),
        // Free on Steam is the lowest there is, and a free row is not marked: it says so itself.
      },
      {
        ...LINK,
        store: 'xbox-store',
        url: MICROSOFT_PAGE,
        title: 'Stardew Valley',
        priceUah: 385,
        regularPriceUah: null,
        discountPercent: 0,
        isFree: false,
        updatedAt: READ_AT,
      },
    ])
    // Nothing on the page was estimated, so the page is told of no rate.
    expect(answer.exchangeRate).toBeNull()
  })

  it('marks no row when the lowest price on the page is free', async () => {
    // Free on Steam, 385 ₴ at the Microsoft Store.
    const freeOnSteam = await page(
      { index: await indexHolding([stardew([microsoftOffer()])]) },
      STARDEW,
    )
    expect(freeOnSteam.stores.map((row) => row.isFree)).toEqual([true, false])
    expect(cheapestOf(freeOnSteam)).toEqual([])

    // 675 ₴ on Steam, free on GOG — which is weighed as nothing, with no rate asked of it.
    const free = gogOffer({ amount: 0, regularAmount: 0, discountPercent: 0 })
    const freeOnGog = await page({ index: await indexHolding([witcher([free])], metaWith(null)) })
    expect(freeOnGog.stores.map((row) => row.isFree)).toEqual([false, true])
    expect(cheapestOf(freeOnGog)).toEqual([])
  })

  it('adds no row for a store RAWG does not link', async () => {
    // RAWG links the Witcher on Steam and on GOG; the document also holds a Microsoft offer.
    const index = await indexHolding([witcher([gogOffer(), microsoftOffer()])])

    const answer = await page({ index })

    expect(answer.stores.map((row) => row.store)).toEqual(['steam', 'gog'])
  })

  it('is the page it always was for a document written before the job read these stores', async () => {
    const index = await indexHolding([witcher(null)], metaWith(null))

    const answer = await page({ index })

    expect(answer.stores).toEqual([STEAM_ROW, { ...LINK, store: 'gog', url: RAWG_GOG_LINK }])
    expect(answer.exchangeRate).toBeNull()
  })

  it('is the page it always was for a game the index does not hold', async () => {
    const index = await indexHolding([stardew([microsoftOffer()])])

    const answer = await page({ index, steamPrices: steamPricesReturning(() => null) })

    expect(answer.stores).toEqual([
      { ...LINK, store: 'steam', url: STEAM_PAGE },
      { ...LINK, store: 'gog', url: RAWG_GOG_LINK },
    ])
    expect(answer.exchangeRate).toBeNull()
  })

  describe('an offer is a price for thirty-six hours', () => {
    it('shows one read thirty-six hours ago to the millisecond', async () => {
      const edge = gogOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS) })
      const index = await indexHolding([witcher([edge])])

      const answer = await page({ index })

      expect(answer.stores[1]).toEqual({ ...GOG_ROW, updatedAt: edge.updatedAt, cheapest: true })
    })

    it('leaves the bare link RAWG gave for one read a millisecond before that', async () => {
      // It would be the cheapest by far, and it is not a price.
      const old = gogOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS + 1) })
      const index = await indexHolding([witcher([old])])

      const answer = await page({ index })

      expect(answer.stores).toEqual([STEAM_ROW, { ...LINK, store: 'gog', url: RAWG_GOG_LINK }])
      expect(answer.exchangeRate).toBeNull()
    })

    it('shows the fresh one of two, and only that one', async () => {
      const old = microsoftOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS + 1) })
      const index = await indexHolding([stardew([old])])

      const answer = await page({ index }, STARDEW)

      expect(answer.stores[1]).toMatchObject({ store: 'xbox-store', priceUah: null, title: null })
      // One priced row is left, and nothing is cheaper than nothing.
      expect(cheapestOf(answer)).toEqual([])
    })
  })

  describe('a rate is a rate for seven days', () => {
    it('estimates with one read seven days ago to the millisecond', async () => {
      const rate = { ...RATE, date: '2026-10-05', readAt: ago(EXCHANGE_RATE_KEPT_MS) }
      const index = await indexHolding([witcher([gogOffer()])], metaWith(rate))

      const answer = await page({ index })

      expect(answer.stores[1]).toEqual({ ...GOG_ROW, cheapest: true })
      expect(answer.exchangeRate).toEqual({ ...SHOWN_RATE, date: '2026-10-05' })
    })

    it('estimates nothing with one read a millisecond before that: the dollar price stands alone', async () => {
      const rate = { ...RATE, date: '2026-10-05', readAt: ago(EXCHANGE_RATE_KEPT_MS + 1) }
      const index = await indexHolding([witcher([gogOffer()])], metaWith(rate))

      const answer = await page({ index })

      expect(answer.stores).toEqual([STEAM_ROW, { ...GOG_ROW, approxUah: null }])
      expect(answer.exchangeRate).toBeNull()
      // With no hryvnia amount GOG takes no part, and Steam has nothing to be cheaper than.
      expect(cheapestOf(answer)).toEqual([])
    })

    it('estimates nothing when the metadata holds no rate at all', async () => {
      const index = await indexHolding([witcher([gogOffer()])], metaWith(null))

      const answer = await page({ index })

      expect(answer.stores[1]).toEqual({ ...GOG_ROW, approxUah: null })
      expect(answer.exchangeRate).toBeNull()
    })

    it('still weighs the hryvnia stores against each other without a rate', async () => {
      // Stardew for 385 ₴ at Microsoft against a Steam price of 400 ₴: both exact.
      const priced = { ...stardew([microsoftOffer()]), priceUah: 400, free: false }
      const index = await indexHolding([priced], metaWith(null))

      const answer = await page({ index }, STARDEW)

      expect(cheapestOf(answer)).toEqual(['xbox-store'])
    })
  })

  describe('the cheapest row', () => {
    /** The Witcher with a Steam price old enough for the page to ask Steam for the live one. */
    const dueARefresh = () =>
      witcher([gogOffer()], { priceUpdatedAt: ago(PRICE_REFRESH_AFTER_MS + HOUR) })

    const live = (priceUah: number): SteamPrice => ({
      priceUah,
      regularPriceUah: 1349,
      discountPercent: Math.round((1 - priceUah / 1349) * 100),
      isFree: false,
    })

    it('is weighed against the Steam price the page shows — the live one, not the index’s', async () => {
      // The index says 675 ₴, against which GOG's ≈ 404 ₴ would win; Steam has just said 380 ₴.
      const index = await indexHolding([dueARefresh()])
      const steamPrices = steamPricesReturning(() => live(380))

      const answer = await page({ index, steamPrices })

      expect(answer.stores[0]).toMatchObject({ priceUah: 380, updatedAt: NOW, cheapest: true })
      expect(answer.stores[1]).toMatchObject({ approxUah: 404, cheapest: false })
    })

    it('is weighed against the index’s Steam price when Steam has none to give', async () => {
      const index = await indexHolding([dueARefresh()])
      const steamPrices = steamPricesReturning(() => null)

      const answer = await page({ index, steamPrices })

      expect(answer.stores[0]).toMatchObject({ priceUah: 675, cheapest: false })
      expect(cheapestOf(answer)).toEqual(['gog'])
    })

    it.each([
      [426, ['gog'], 'at least five percent below'],
      [425, [], 'a little under five percent below'],
      [410, [], 'only just below'],
      [404, [], 'level'],
      [403, ['steam'], 'above'],
    ])(
      'with Steam at %i ₴ marks %j: the estimate of 404 ₴ is %s',
      async (steamUah, expected, _how) => {
        const index = await indexHolding([dueARefresh()])
        const steamPrices = steamPricesReturning(() => live(steamUah))

        const answer = await page({ index, steamPrices })

        expect(cheapestOf(answer)).toEqual(expected)
      },
    )

    it('marks nothing when a single row has a price', async () => {
      const index = await indexHolding([witcher([gogOffer()], { priceUah: null })])

      const answer = await page({ index, steamPrices: steamPricesReturning(() => null) })

      expect(answer.stores[0]!.priceUah).toBeNull()
      expect(answer.stores[1]!.approxUah).toBe(404)
      expect(cheapestOf(answer)).toEqual([])
    })
  })

  it('shows a fresh offer beside a Steam price from an index too stale to price a card', async () => {
    // This page shows Steam's old price under its own date; an offer answers for its own age.
    const nineDaysAgo = ago(INDEX_STALE_AFTER_MS + 48 * HOUR)
    const index = await indexHolding(
      [witcher([gogOffer()], { priceUpdatedAt: nineDaysAgo })],
      metaWith(RATE, nineDaysAgo),
    )

    const answer = await page({ index, steamPrices: steamPricesReturning(() => null) })

    expect(answer.stores).toEqual([
      { ...STEAM_ROW, updatedAt: nineDaysAgo },
      { ...GOG_ROW, cheapest: true },
    ])
  })

  describe('what it costs', () => {
    /** The page, with everything it asked of the index and of RAWG. */
    async function asked(document: IndexedGame) {
      const index = await indexHolding([document])
      const paths: string[] = []
      const rawg: RawgFetch = (path, params, options) => {
        paths.push(path)
        return fixtureRawg(path, params, options)
      }
      // `noSteamPrices`, the default, fails the case if Steam is asked at all.
      await page({ index, rawg })
      return { calls: index.calls, paths }
    }

    it('reads the index exactly as often as a page without offers does, and asks no upstream more', async () => {
      const without = await asked(witcher(null))
      const withOffers = await asked(witcher([gogOffer()]))

      expect(withOffers.calls).toEqual(without.calls)
      // One read of the metadata — where the rate is — one lookup of the slug, one document.
      expect(withOffers.calls).toMatchObject({ meta: 1, idBySlug: [WITCHER], getOne: [3328] })
      expect(withOffers.calls.search).toEqual([])
      expect(withOffers.calls.getMany).toEqual([])
      expect(withOffers.paths).toEqual(without.paths)
      expect(withOffers.paths).toHaveLength(3)
    })

    it('names the same number of index calls in Server-Timing with offers as without', async () => {
      const header = async (document: IndexedGame): Promise<string> => {
        const index = await indexHolding([document])
        const response = await postQuery({ now: NOW, index }, PAGE, { slug: WITCHER })
        return response.headers.get('Server-Timing') ?? ''
      }
      const count = (value: string) => /desc="Index x(\d+)"/.exec(value)?.[1]

      const without = count(await header(witcher(null)))
      expect(without).toBe('3')
      expect(count(await header(witcher([gogOffer()])))).toBe(without)
    })
  })
})

describe('what the other stores charge, on the page built from the index', () => {
  it('shows the offers the document has on rows of their own, after Steam', async () => {
    const index = await indexHolding([witcher([gogOffer()])])

    const answer = await indexPage({ index })

    expect(answer.stores).toEqual([STEAM_ROW, { ...GOG_ROW, cheapest: true }])
    expect(answer.exchangeRate).toEqual(SHOWN_RATE)
  })

  it('shows a hryvnia offer of the Microsoft Store, and weighs it exactly', async () => {
    // The seed has no such page: its one Microsoft offer is on a game RAWG's fixtures answer
    // for. So the document is made here, of that same recorded product — Stardew Valley, with a
    // Steam price of 400 ₴ in place of the free one, and on sale at Microsoft.
    const offer = microsoftOffer({ amount: 19_250, regularAmount: 38_500, discountPercent: 50 })
    const document = {
      ...stardew([offer]),
      priceUah: 400,
      regularPriceUah: 400,
      free: false,
    }
    const index = await indexHolding([document])

    const answer = await indexPage({ index }, STARDEW)

    expect(answer.stores).toEqual([
      {
        ...LINK,
        store: 'steam',
        url: 'https://store.steampowered.com/app/413150/',
        priceUah: 400,
        regularPriceUah: null,
        discountPercent: 0,
        isFree: false,
        updatedAt: ago(3 * HOUR),
      },
      {
        ...LINK,
        store: 'xbox-store',
        url: MICROSOFT_PAGE,
        title: 'Stardew Valley',
        // 192.50 ₴, shown as a whole number of hryvnia like every price on the site.
        priceUah: 193,
        regularPriceUah: 385,
        discountPercent: 50,
        isFree: false,
        updatedAt: READ_AT,
        cheapest: true,
      },
    ])
    // A hryvnia price needs no rate, and the page is told of none.
    expect(answer.exchangeRate).toBeNull()
  })

  it('makes a link of an offer that is too old to be a price', async () => {
    const old = gogOffer({ updatedAt: ago(OFFER_FRESH_FOR_MS + 1) })
    const index = await indexHolding([witcher([old])])

    const answer = await indexPage({ index })

    expect(answer.stores).toEqual([STEAM_ROW, { ...LINK, store: 'gog', url: GOG_PAGE }])
    expect(answer.exchangeRate).toBeNull()
  })

  it('shows a dollar price alone when the rate is more than seven days old', async () => {
    const rate = { ...RATE, readAt: ago(EXCHANGE_RATE_KEPT_MS + 1) }
    const index = await indexHolding([witcher([gogOffer()])], metaWith(rate))

    const answer = await indexPage({ index })

    expect(answer.stores).toEqual([STEAM_ROW, { ...GOG_ROW, approxUah: null }])
    expect(answer.exchangeRate).toBeNull()
  })

  it('shows no store the document does not list the game on', async () => {
    // The Witcher's document lists Steam and GOG; an offer of the Microsoft Store has no row.
    const index = await indexHolding([witcher([gogOffer(), microsoftOffer()])])

    const answer = await indexPage({ index })

    expect(answer.stores.map((row) => row.store)).toEqual(['steam', 'gog'])
  })

  describe('while the index is too stale to show a price', () => {
    const staleSince = ago(INDEX_STALE_AFTER_MS + HOUR)

    it('withholds the other stores’ prices where it withholds Steam’s: every row is a link', async () => {
      // The offers themselves were read six hours ago. The rule is the index's, not theirs.
      const index = await indexHolding(
        [witcher([gogOffer()], { priceUpdatedAt: ago(HOUR) })],
        metaWith(RATE, staleSince),
      )

      const answer = await indexPage({ index })

      expect(answer.stores).toEqual([
        { ...LINK, store: 'steam', url: STEAM_PAGE },
        { ...LINK, store: 'gog', url: GOG_PAGE },
      ])
      expect(answer.exchangeRate).toBeNull()
    })

    it('withholds them beside a price Steam has just given, too', async () => {
      const index = await indexHolding(
        [witcher([gogOffer()], { priceUpdatedAt: staleSince })],
        metaWith(RATE, staleSince),
      )
      const steamPrices = steamPricesReturning(() => ({
        priceUah: 404,
        regularPriceUah: 1349,
        discountPercent: 70,
        isFree: false,
      }))

      const answer = await indexPage({ index, steamPrices })

      expect(answer.stores).toEqual([
        { ...STEAM_ROW, priceUah: 404, discountPercent: 70, updatedAt: NOW },
        { ...LINK, store: 'gog', url: GOG_PAGE },
      ])
      expect(cheapestOf(answer)).toEqual([])
    })
  })

  it('is weighed against the live Steam price there too', async () => {
    const due = witcher([gogOffer()], { priceUpdatedAt: ago(PRICE_REFRESH_AFTER_MS + HOUR) })
    const index = await indexHolding([due])
    const steamPrices = steamPricesReturning(() => ({
      priceUah: 380,
      regularPriceUah: 1349,
      discountPercent: 72,
      isFree: false,
    }))

    const answer = await indexPage({ index, steamPrices })

    expect(answer.stores[0]).toMatchObject({ priceUah: 380, cheapest: true })
    expect(answer.stores[1]).toMatchObject({ approxUah: 404, cheapest: false })
  })

  it('reads the index no more often for the offers: the metadata once, the slug, the document', async () => {
    const withOffers = await indexHolding([witcher([gogOffer()])])
    const without = await indexHolding([witcher(null)])

    await indexPage({ index: withOffers })
    await indexPage({ index: without })

    expect(withOffers.calls).toEqual(without.calls)
    expect(withOffers.calls).toMatchObject({ meta: 1, idBySlug: [WITCHER], getOne: [3328] })
  })
})
