import { describe, expect, it, vi } from 'vitest'
import { collectCandidates } from '../../../scripts/index/candidates'
import {
  belowOfferFloor,
  isOffersReadDue,
  OFFER_FLOOR_MIN_CARRIED,
  OFFER_FLOOR_RATIO,
  OFFERS_MAX_AGE_MS,
  RATE_KEPT_MS,
  referencesLookLost,
  refreshOffers,
  type OffersResult,
} from '../../../scripts/index/offers'
import { storeWarnings } from '../../../scripts/index/run'
import { sweepStoreRefs, type StoreRefMap } from '../../../scripts/index/storeRefs'
import type {
  IndexMeta,
  IndexedExchangeRate,
  IndexedGame,
  IndexedOffer,
} from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import {
  bankAnswer,
  gogPrice,
  gogProduct,
  JOB_BANK_RATE,
  JOB_MICROSOFT_ID,
  JOB_MICROSOFT_TITLE,
  microsoftProduct,
} from '../../fixtures/index/jobStores'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The stage that reads GOG, the Microsoft Store and the National Bank. In the job catalog game
 * 101 has a GOG page (`hollow_cradle`, $9.99 against $19.99, under the game's own name) and game
 * 109 a Microsoft product (385 ₴, which the store calls an edition of the game); the other seven
 * have neither.
 */

const RUN_AT = '2026-09-20T03:00:00.000Z'
const HOUR = 3_600_000
const DAY = 24 * HOUR

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const GOG_OFFER: IndexedOffer = {
  store: 'gog',
  title: 'Hollow Cradle',
  amount: 999,
  regularAmount: 1999,
  currency: 'USD',
  discountPercent: 50,
  url: 'https://www.gog.com/en/game/hollow_cradle',
  updatedAt: RUN_AT,
}

const MICROSOFT_OFFER: IndexedOffer = {
  store: 'xbox-store',
  title: JOB_MICROSOFT_TITLE,
  amount: 38_500,
  regularAmount: 38_500,
  currency: 'UAH',
  discountPercent: 0,
  url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9nlostcant0n',
  updatedAt: RUN_AT,
}

const RATE: IndexedExchangeRate = {
  currency: 'USD',
  uah: JOB_BANK_RATE,
  date: '2026-09-20',
  readAt: RUN_AT,
}

interface Run {
  harness: JobHarness
  games: IndexedGame[]
  refs: StoreRefMap
  byId: (id: number) => IndexedGame
}

/** The run's games with their store references read, as the stage finds them. */
async function runAt(start: string, writer?: JobHarness['writer']): Promise<Run> {
  const harness = createJobHarness({ start, writer })
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const { refs } = await sweepStoreRefs(harness.deps, games)
  return { harness, games, refs, byId: (id) => games.find((game) => game.id === id)! }
}

/** The metadata a version published at `at` would carry, both stores read in full then. */
function publishedAt(at: string, extra: Partial<IndexMeta> = {}): IndexMeta {
  return {
    version: 1,
    updatedAt: at,
    pricesUpdatedAt: at,
    gameCount: 9,
    offersReadAt: { gog: at, 'xbox-store': at },
    exchangeRate: { ...RATE, readAt: at },
    ...extra,
  }
}

describe('refreshOffers', () => {
  it('reads both stores and the bank on a first run, and puts the offers on the documents', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    // Left out, not written empty, on the seven games no store has a price for.
    expect(games.filter((game) => 'offers' in game).map((game) => game.id)).toEqual([101, 109])

    expect(result.gog).toEqual({
      status: 'read',
      references: 1,
      pricesRead: 1,
      failed: 0,
      requests: 1,
      offers: 1,
      lastReadAt: RUN_AT,
    })
    expect(result.microsoft).toEqual({
      status: 'read',
      references: 1,
      pricesRead: 1,
      failed: 0,
      requests: 1,
      offers: 1,
      lastReadAt: RUN_AT,
    })
    expect(result.rate).toEqual({ status: 'read', rate: RATE })
    expect(result.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    expect(result.exchangeRate).toEqual(RATE)

    expect(harness.gogPages).toEqual([1])
    expect(harness.microsoftBatches).toEqual([[JOB_MICROSOFT_ID]])
    // 03:00 UTC on the 20th is 06:00 in Kyiv on the 20th.
    expect(harness.bankDays).toEqual(['2026-09-20'])
  })

  it('touches nothing of a document but its offers', async () => {
    const { harness, games, refs } = await runAt(RUN_AT)
    const withoutOffers = (list: IndexedGame[]) => list.map(({ offers: _offers, ...rest }) => rest)
    const before = structuredClone(withoutOffers(games))

    await refreshOffers(harness.deps, games, refs, null)

    expect(withoutOffers(games)).toEqual(before)
  })
})

describe('the eleven-hour rule', () => {
  it('is eleven hours, and "more than"', () => {
    const now = Date.parse(RUN_AT)

    expect(OFFERS_MAX_AGE_MS).toBe(11 * HOUR)
    expect(isOffersReadDue(later(RUN_AT, -11 * HOUR), now)).toBe(false)
    expect(isOffersReadDue(later(RUN_AT, -11 * HOUR - 1), now)).toBe(true)
    expect(isOffersReadDue(later(RUN_AT, -6 * HOUR), now)).toBe(false)
    // Never read, or a stamp nobody can read — one from the future included.
    expect(isOffersReadDue(undefined, now)).toBe(true)
    expect(isOffersReadDue(null, now)).toBe(true)
    expect(isOffersReadDue('yesterday', now)).toBe(true)
    expect(isOffersReadDue(later(RUN_AT, HOUR), now)).toBe(true)
  })

  it('asks neither store anything while the last full read is under eleven hours old', async () => {
    // Six hours after a read: the prices run in between two reads.
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 6 * HOUR))
    byId(101).offers = [GOG_OFFER]
    byId(109).offers = [MICROSOFT_OFFER]

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.gogPages).toHaveLength(0)
    expect(harness.microsoftBatches).toHaveLength(0)
    // What the documents carried is what is published, dates and all.
    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    expect(result.gog).toMatchObject({
      status: 'not-due',
      references: 1,
      pricesRead: 0,
      failed: 0,
      requests: 0,
      offers: 1,
      lastReadAt: RUN_AT,
    })
    expect(result.microsoft).toMatchObject({ status: 'not-due', requests: 0, offers: 1 })
    // The stamps do not move with a run that read nothing.
    expect(result.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    // The bank is asked by every run all the same.
    expect(harness.bankDays).toHaveLength(1)
  })

  it('reads again twelve hours after a read, and not at eleven sharp', async () => {
    const sharp = await runAt(later(RUN_AT, 11 * HOUR))
    await refreshOffers(sharp.harness.deps, sharp.games, sharp.refs, publishedAt(RUN_AT))
    expect(sharp.harness.gogPages).toHaveLength(0)
    expect(sharp.harness.microsoftBatches).toHaveLength(0)

    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, byId } = await runAt(at)
    byId(101).offers = [GOG_OFFER]
    harness.gogCatalog.products = [gogProduct('hollow_cradle', gogPrice('19.99', '19.99'))]

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.gogPages).toEqual([1])
    expect(harness.microsoftBatches).toHaveLength(1)
    // The sale is over: today's price, under today's date.
    expect(byId(101).offers).toEqual([
      { ...GOG_OFFER, amount: 1999, regularAmount: 1999, discountPercent: 0, updatedAt: at },
    ])
    expect(result.offersReadAt).toEqual({ gog: at, 'xbox-store': at })
  })

  it('judges each store by its own stamp', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs } = await runAt(at)
    const published = publishedAt(RUN_AT, {
      offersReadAt: { gog: RUN_AT, 'xbox-store': later(RUN_AT, 6 * HOUR) },
    })

    const result = await refreshOffers(harness.deps, games, refs, published)

    expect(harness.gogPages).toEqual([1])
    expect(harness.microsoftBatches).toHaveLength(0)
    expect(result.offersReadAt).toEqual({ gog: at, 'xbox-store': later(RUN_AT, 6 * HOUR) })
  })

  it('reads a store metadata published before this stage existed has no stamp for', async () => {
    const { harness, games, refs } = await runAt(later(RUN_AT, HOUR))
    const older: IndexMeta = {
      version: 1,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: 9,
    }

    const result = await refreshOffers(harness.deps, games, refs, older)

    expect(result.gog.status).toBe('read')
    expect(result.microsoft.status).toBe('read')
  })
})

describe('a store that is down', () => {
  it('keeps the previous offers and their dates when the walk fails', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, byId } = await runAt(at)
    byId(101).offers = [GOG_OFFER]
    harness.failGogPage(1)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(result.gog).toEqual({
      status: 'failed',
      references: 1,
      pricesRead: 0,
      failed: 1,
      requests: 1,
      offers: 1,
      // The stamp of the last read that did succeed: the next run finds the store due.
      lastReadAt: RUN_AT,
      error: 'GOG upstream failure (page 1)',
    })
    expect(result.offersReadAt.gog).toBe(RUN_AT)
    // The other store is none the worse for it.
    expect(result.microsoft.status).toBe('read')
    expect(byId(109).offers).toEqual([{ ...MICROSOFT_OFFER, updatedAt: at }])
    expect(result.offersReadAt['xbox-store']).toBe(at)
  })

  it('publishes nothing new from a walk that fails part-way', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, byId } = await runAt(at)
    byId(101).offers = [GOG_OFFER]
    // Three pages; the game's product is on the first, at a new price, and the third fails.
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle', gogPrice('19.99', '19.99')),
      gogProduct('amber_archive', gogPrice('4.99', '4.99')),
      gogProduct('zenith_run', null),
    ]
    harness.gogCatalog.pageSize = 1
    harness.failGogPage(3)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.gogPages).toEqual([1, 2, 3])
    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(result.gog).toMatchObject({ status: 'failed', pricesRead: 0, failed: 1, requests: 3 })
  })

  it('keeps the offers when the walk cannot prove it saw the whole catalog', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(101).offers = [GOG_OFFER]
    harness.answerGogPageWith(1, {
      pages: 1,
      productCount: 2,
      products: [gogProduct('amber_archive', null)],
    })

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // Read at face value, that page would say GOG no longer sells the game.
    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(result.gog).toMatchObject({
      status: 'failed',
      error: 'the GOG catalog promised 2 products and the walk received 1',
    })
  })

  it('keeps the offers of the products a failed Microsoft request asked about', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, byId } = await runAt(at)
    byId(109).offers = [MICROSOFT_OFFER]
    harness.failMicrosoftBatchWith(JOB_MICROSOFT_ID)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    expect(result.microsoft).toEqual({
      status: 'failed',
      references: 1,
      pricesRead: 0,
      failed: 1,
      requests: 1,
      offers: 1,
      lastReadAt: RUN_AT,
      error: 'MICROSOFT upstream failure (batch)',
    })
    expect(result.gog.status).toBe('read')
  })

  it('keeps the offers when Microsoft answers something that is not an answer', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(109).offers = [MICROSOFT_OFFER]
    harness.answerMicrosoftWith({ code: 'BadRequest' })

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // Read as "no products", that body would say Microsoft no longer sells the game.
    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    expect(result.microsoft).toMatchObject({ status: 'failed', failed: 1 })
  })

  it('does not fail, and does not ask twice, when both stores and the bank are down', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(101).offers = [GOG_OFFER]
    byId(109).offers = [MICROSOFT_OFFER]
    harness.failGogPage(1)
    harness.failMicrosoftBatchWith(JOB_MICROSOFT_ID)
    harness.bankState.down = true

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog.status).toBe('failed')
    expect(result.microsoft.status).toBe('failed')
    expect(result.rate.status).toBe('kept')
    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    expect(result.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    expect([
      harness.gogPages.length,
      harness.microsoftBatches.length,
      harness.bankDays.length,
    ]).toEqual([1, 1, 1])
  })
})

describe('what a full read settles', () => {
  it('takes away the offer of a game the catalog no longer has', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(101).offers = [GOG_OFFER]
    harness.gogCatalog.products = [gogProduct('amber_archive', gogPrice('4.99', '4.99'))]

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(101)).toBe(false)
    expect(result.gog).toMatchObject({
      status: 'read',
      references: 1,
      pricesRead: 0,
      failed: 0,
      offers: 0,
    })
  })

  it.each([
    ['is not out yet', gogProduct('hollow_cradle', null)],
    [
      'is priced in another currency',
      gogProduct('hollow_cradle', gogPrice('9.99', '19.99', 'EUR')),
    ],
    [
      'has a price that cannot be read',
      gogProduct('hollow_cradle', { finalMoney: { amount: 9.99, currency: 'USD' } } as never),
    ],
    [
      'has a link that is not its own',
      gogProduct('hollow_cradle', gogPrice('9.99', '19.99'), { storeLink: 'https://example.org/' }),
    ],
  ])('gives no offer for a GOG product that %s', async (_what, product) => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(101).offers = [GOG_OFFER]
    harness.gogCatalog.products = [product]

    await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(101)).toBe(false)
  })

  it('takes away the offer of a product Microsoft no longer sells here', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(109).offers = [MICROSOFT_OFFER]
    Reflect.deleteProperty(harness.microsoftProducts, JOB_MICROSOFT_ID)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(109)).toBe(false)
    expect(result.microsoft).toMatchObject({ status: 'read', pricesRead: 0, failed: 0, offers: 0 })
  })

  it('publishes a free game as an offer of zero', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    harness.gogCatalog.products = [gogProduct('hollow_cradle', gogPrice('0.00', '0.00'))]
    harness.microsoftProducts[JOB_MICROSOFT_ID] = microsoftProduct(
      JOB_MICROSOFT_ID,
      0,
      0,
      JOB_MICROSOFT_TITLE,
    )

    await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([
      { ...GOG_OFFER, amount: 0, regularAmount: 0, discountPercent: 0 },
    ])
    expect(byId(109).offers).toEqual([{ ...MICROSOFT_OFFER, amount: 0, regularAmount: 0 }])
  })

  it('carries what each store calls the product, which need not be the game’s name', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle', gogPrice('9.99', '19.99'), {
        title: '  Hollow Cradle \u2014\n Game of the Year Edition ',
      }),
    ]

    await refreshOffers(harness.deps, games, refs, null)

    // The game is "Hollow Cradle" and "Lost Canton"; the prices are for these.
    expect(byId(101).name).toBe('Hollow Cradle')
    expect(byId(101).offers?.[0]?.title).toBe('Hollow Cradle \u2014 Game of the Year Edition')
    expect(byId(109).name).toBe('Lost Canton')
    expect(byId(109).offers?.[0]?.title).toBe('Lost Canton: Definitive Edition')
  })

  it('leaves the title out of an offer whose store gave none, rather than write it empty', async () => {
    const { harness, games, refs, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    byId(101).offers = [GOG_OFFER]
    byId(109).offers = [MICROSOFT_OFFER]
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle', gogPrice('9.99', '19.99'), { title: '   ' }),
    ]
    harness.microsoftProducts[JOB_MICROSOFT_ID] = microsoftProduct(JOB_MICROSOFT_ID, 385)

    await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // The price is still a price; and the title the last read had is not kept past this one.
    expect(byId(101).offers?.[0]).toMatchObject({ store: 'gog', amount: 999 })
    expect('title' in byId(101).offers![0]!).toBe(false)
    expect(byId(109).offers?.[0]).toMatchObject({ store: 'xbox-store', amount: 38_500 })
    expect('title' in byId(109).offers![0]!).toBe(false)
  })

  it('keeps one store’s offer when the other is read, and lists GOG first', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, byId } = await runAt(at)
    const refs: StoreRefMap = new Map([
      [101, { gog: 'hollow_cradle', microsoft: { id: JOB_MICROSOFT_ID, name: 'hollow-cradle' } }],
    ])
    byId(101).offers = [
      { ...MICROSOFT_OFFER, url: 'https://www.microsoft.com/uk-ua/p/hollow-cradle/9nlostcant0n' },
    ]
    // GOG is due and Microsoft is not.
    const published = publishedAt(RUN_AT, {
      offersReadAt: { gog: RUN_AT, 'xbox-store': later(RUN_AT, 6 * HOUR) },
    })

    await refreshOffers(harness.deps, games, refs, published)

    expect(byId(101).offers?.map((offer) => [offer.store, offer.updatedAt])).toEqual([
      ['gog', at],
      ['xbox-store', RUN_AT],
    ])
  })
})

describe('the Microsoft Store’s requests', () => {
  /** `count` copies of a game, each naming a Microsoft product of its own. */
  function manyGames(base: IndexedGame, count: number) {
    const games: IndexedGame[] = []
    const refs: StoreRefMap = new Map()
    const ids: string[] = []
    for (let index = 0; index < count; index += 1) {
      const id = `9N${String(index).padStart(10, '0')}`
      ids.push(id)
      games.push({ ...structuredClone(base), id: 1000 + index, slug: `game-${index}` })
      refs.set(1000 + index, { microsoft: { id, name: `game-${index}` } })
    }
    return { games, refs, ids }
  }

  it('asks about a hundred products a request, and a failed request keeps its hundred', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, byId } = await runAt(at)
    const { games, refs, ids } = manyGames(byId(109), 250)
    for (const id of ids) harness.microsoftProducts[id] = microsoftProduct(id, 385)
    const previous = (game: IndexedGame): IndexedOffer => ({
      ...MICROSOFT_OFFER,
      amount: 77_000,
      regularAmount: 77_000,
      url: `https://www.microsoft.com/uk-ua/p/${game.slug}/x`,
    })
    for (const game of games) game.offers = [previous(game)]
    // The second request of three fails.
    harness.failMicrosoftBatchWith(ids[150]!)
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.microsoftBatches.map((batch) => batch.length)).toEqual([100, 100, 50])
    expect(result.microsoft).toMatchObject({
      status: 'partial',
      references: 250,
      pricesRead: 150,
      failed: 100,
      requests: 3,
      offers: 250,
      // Not read in full: the stamp stays, and the next run reads again.
      lastReadAt: RUN_AT,
    })
    // These products state no title, so the new offers carry none — not the one they had.
    const { title: _title, ...untitled } = MICROSOFT_OFFER
    expect(games[0]!.offers).toEqual([
      {
        ...untitled,
        url: 'https://www.microsoft.com/uk-ua/p/game-0/9n0000000000',
        updatedAt: at,
      },
    ])
    // The failed hundred are exactly as they were, dates included.
    expect(games[150]!.offers).toEqual([previous(games[150]!)])
    expect(games[249]!.offers?.[0]).toMatchObject({ amount: 38_500, updatedAt: at })
    // A sign of life after every request.
    expect(renewLock).toHaveBeenCalledTimes(3)

    // Six hours on, the store is still due, though half its offers are fresh.
    expect(
      isOffersReadDue(result.offersReadAt['xbox-store'], Date.parse(later(at, 6 * HOUR))),
    ).toBe(true)
  })

  /** 250 games, each carrying last night's offer of its own Microsoft product. */
  async function carrying(at: string) {
    const { harness, byId } = await runAt(at)
    const { games, refs, ids } = manyGames(byId(109), 250)
    for (const id of ids) harness.microsoftProducts[id] = microsoftProduct(id, 385)
    const previous = (game: IndexedGame): IndexedOffer => ({
      ...MICROSOFT_OFFER,
      amount: 77_000,
      regularAmount: 77_000,
      url: `https://www.microsoft.com/uk-ua/p/${game.slug}/x`,
    })
    for (const game of games) game.offers = [previous(game)]
    return { harness, games, refs, ids, previous }
  }

  it('removes no offer in a read with a failed request, not even one an answered request left out', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, ids, previous } = await carrying(at)
    // The first request is answered, and its answer has nothing in it for two products; the
    // second request fails; the third is answered whole.
    Reflect.deleteProperty(harness.microsoftProducts, ids[5]!)
    Reflect.deleteProperty(harness.microsoftProducts, ids[7]!)
    harness.failMicrosoftBatchWith(ids[150]!)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({
      status: 'partial',
      references: 250,
      pricesRead: 148,
      failed: 100,
      offers: 250,
      lastReadAt: RUN_AT,
    })
    // Left out of an answered request, in a read that was not a full one: the offers stand, with
    // the dates they were read at. Only a full read may say a product is not sold.
    expect(games[5]!.offers).toEqual([previous(games[5]!)])
    expect(games[7]!.offers).toEqual([previous(games[7]!)])
    // What the answered requests did price is published, under today's date.
    expect(games[6]!.offers?.[0]).toMatchObject({ amount: 38_500, updatedAt: at })
    expect(games[249]!.offers?.[0]).toMatchObject({ amount: 38_500, updatedAt: at })
    // And the failed hundred are as they were.
    expect(games[150]!.offers).toEqual([previous(games[150]!)])
  })

  it('removes nothing when a request answers with no products at all beside one that failed', async () => {
    const { harness, games, refs, ids, previous } = await carrying(later(RUN_AT, 12 * HOUR))
    // A store failing one request in three is the store most likely to answer another with
    // nothing: a 200, and an empty list.
    harness.answerMicrosoftWith({ Products: [] })
    harness.failMicrosoftBatchWith(ids[150]!)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({ status: 'partial', pricesRead: 50, offers: 250 })
    for (const index of [0, 50, 99]) {
      expect(games[index]!.offers, `game ${index}`).toEqual([previous(games[index]!)])
    }
  })

  it('removes the offer of a product an answer left out when every request was answered', async () => {
    const at = later(RUN_AT, 12 * HOUR)
    const { harness, games, refs, ids } = await carrying(at)
    // The same answer as above, in a read with no failure in it: a full read, and it is believed.
    Reflect.deleteProperty(harness.microsoftProducts, ids[5]!)
    Reflect.deleteProperty(harness.microsoftProducts, ids[7]!)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({
      status: 'read',
      pricesRead: 248,
      failed: 0,
      offers: 248,
      lastReadAt: at,
    })
    expect('offers' in games[5]!).toBe(false)
    expect('offers' in games[7]!).toBe(false)
    expect(games[6]!.offers?.[0]).toMatchObject({ amount: 38_500, updatedAt: at })
  })

  it('asks once about a product two games name, and gives both its price', async () => {
    const { harness, games, byId } = await runAt(RUN_AT)
    const refs: StoreRefMap = new Map([
      [108, { microsoft: { id: JOB_MICROSOFT_ID, name: 'silent-meridian' } }],
      [109, { microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' } }],
    ])

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(harness.microsoftBatches).toEqual([[JOB_MICROSOFT_ID]])
    expect(byId(108).offers?.[0]?.url).toBe(
      'https://www.microsoft.com/uk-ua/p/silent-meridian/9nlostcant0n',
    )
    expect(byId(109).offers).toEqual([MICROSOFT_OFFER])
    expect(result.microsoft).toMatchObject({ references: 2, pricesRead: 2, requests: 1 })
  })
})

/**
 * A read that every request of was answered, and that would take most of a store's offers away,
 * is the job misreading the store far more often than the store ceasing to sell: a field renamed,
 * a link under another path, a 200 with an empty list. So a full read is believed only if it
 * leaves at least half of the offers the documents carried, once there are twenty to speak of.
 */
describe('the floor under a full read', () => {
  const noon = later(RUN_AT, 12 * HOUR)

  it('is half of what was carried, from twenty offers up', () => {
    expect(OFFER_FLOOR_MIN_CARRIED).toBe(20)
    expect(OFFER_FLOOR_RATIO).toBe(0.5)
    // Under twenty carried, no read is doubted, whatever it prices.
    expect(belowOfferFloor(0, 0)).toBeNull()
    expect(belowOfferFloor(19, 0)).toBeNull()
    // From twenty: exactly half stands, one under half does not.
    expect(belowOfferFloor(20, 10)).toBeNull()
    expect(belowOfferFloor(20, 9)).toMatch(/^carried 20, the read priced 9: /)
    expect(belowOfferFloor(21, 11)).toBeNull()
    expect(belowOfferFloor(21, 10)).toMatch(/^carried 21, the read priced 10: /)
    expect(belowOfferFloor(1_000, 500)).toBeNull()
    expect(belowOfferFloor(1_000, 499)).toMatch(/^carried 1000, the read priced 499: /)
    expect(belowOfferFloor(20, 0)).toMatch(/^carried 20, the read priced 0: /)
    // A read that prices more than was carried is the first sweeps filling in.
    expect(belowOfferFloor(20, 400)).toBeNull()
  })

  /** `count` games with a GOG page each, carrying last night's offer; `priced` of them on sale today. */
  async function gogGames(count: number, priced: number, storeLink?: (slug: string) => string) {
    const { harness, byId } = await runAt(noon)
    const games: IndexedGame[] = []
    const refs: StoreRefMap = new Map()
    for (let index = 0; index < count; index += 1) {
      const slug = `game_${index}`
      const game = { ...structuredClone(byId(101)), id: 2000 + index, slug: `game-${index}` }
      game.offers = [{ ...GOG_OFFER, url: `https://www.gog.com/en/game/${slug}` }]
      games.push(game)
      refs.set(game.id, { gog: slug })
    }
    // The catalog is never empty: the products that are not these games' are still there.
    harness.gogCatalog.products = [
      gogProduct('amber_archive', gogPrice('4.99', '4.99')),
      ...games
        .slice(0, priced)
        .map((_, index) =>
          gogProduct(
            `game_${index}`,
            gogPrice('5.99', '9.99'),
            storeLink ? { storeLink: storeLink(`game_${index}`) } : {},
          ),
        ),
    ]
    return { harness, games, refs }
  }

  const carriedGog = (slug: string): IndexedOffer => ({
    ...GOG_OFFER,
    url: `https://www.gog.com/en/game/${slug}`,
  })

  it('does not hold a GOG read to it under twenty carried offers', async () => {
    const { harness, games, refs } = await gogGames(19, 0)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // Nineteen offers and none priced today: believed, and all nineteen go.
    expect(result.gog).toMatchObject({ status: 'read', pricesRead: 0, offers: 0, lastReadAt: noon })
    expect(games.every((game) => !('offers' in game))).toBe(true)
  })

  it('believes a GOG read that leaves exactly half', async () => {
    const { harness, games, refs } = await gogGames(20, 10)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog).toMatchObject({
      status: 'read',
      pricesRead: 10,
      failed: 0,
      offers: 10,
      lastReadAt: noon,
    })
    expect(games[0]!.offers?.[0]).toMatchObject({ amount: 599, updatedAt: noon })
    expect('offers' in games[10]!).toBe(false)
  })

  it('does not believe a GOG read that leaves one under half, and takes nothing from it', async () => {
    const { harness, games, refs } = await gogGames(20, 9)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog).toEqual({
      status: 'failed',
      references: 20,
      pricesRead: 0,
      failed: 20,
      requests: 1,
      offers: 20,
      // The stamp stays where it was, so the very next run walks again.
      lastReadAt: RUN_AT,
      error:
        'carried 20, the read priced 9: under half of the offers the store had, so the read is not believed and nothing is taken from it',
    })
    expect(result.offersReadAt.gog).toBe(RUN_AT)
    // Every offer as it was, date and all — the nine the walk did price included.
    for (const [index, game] of games.entries()) {
      expect(game.offers, `game ${index}`).toEqual([carriedGog(`game_${index}`)])
    }
    expect(harness.logs).toContain(
      'gog: the catalog was walked in 1 requests and carried 20, the read priced 9: under half of the offers the store had, so the read is not believed and nothing is taken from it',
    )
    // The other store and the bank are none the worse.
    expect(result.rate.status).toBe('read')
  })

  it('keeps every GOG offer when the catalog changes the shape of what it says', async () => {
    // Every product is there and priced, and its link has moved to a path this job does not
    // know: a whole walk, and not one product it can make an offer of.
    const { harness, games, refs } = await gogGames(
      40,
      40,
      (slug) => `https://www.gog.com/en/games/${slug}`,
    )

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog).toMatchObject({
      status: 'failed',
      pricesRead: 0,
      failed: 40,
      offers: 40,
      lastReadAt: RUN_AT,
    })
    expect(result.gog.error).toMatch(/^carried 40, the read priced 0: /)
    expect(games[39]!.offers).toEqual([carriedGog('game_39')])
  })

  /** `count` games carrying last night's Microsoft offer; the store sells `priced` of them today. */
  async function microsoftGames(count: number, priced: number) {
    const { harness, byId } = await runAt(noon)
    const games: IndexedGame[] = []
    const refs: StoreRefMap = new Map()
    for (let index = 0; index < count; index += 1) {
      const id = `9N${String(index).padStart(10, '0')}`
      const game = { ...structuredClone(byId(109)), id: 3000 + index, slug: `game-${index}` }
      game.offers = [carriedMicrosoft(index)]
      games.push(game)
      refs.set(game.id, { microsoft: { id, name: `game-${index}` } })
      if (index < priced) harness.microsoftProducts[id] = microsoftProduct(id, 250)
    }
    return { harness, games, refs }
  }

  const carriedMicrosoft = (index: number): IndexedOffer => ({
    ...MICROSOFT_OFFER,
    url: `https://www.microsoft.com/uk-ua/p/game-${index}/9n${String(index).padStart(10, '0')}`,
  })

  it('does not hold a Microsoft read to it under twenty carried offers', async () => {
    const { harness, games, refs } = await microsoftGames(19, 0)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({
      status: 'read',
      pricesRead: 0,
      offers: 0,
      lastReadAt: noon,
    })
    expect(games.every((game) => !('offers' in game))).toBe(true)
  })

  it('believes a Microsoft read that leaves exactly half', async () => {
    const { harness, games, refs } = await microsoftGames(20, 10)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({
      status: 'read',
      pricesRead: 10,
      failed: 0,
      offers: 10,
      lastReadAt: noon,
    })
    expect(games[9]!.offers?.[0]).toMatchObject({ amount: 25_000, updatedAt: noon })
    expect('offers' in games[10]!).toBe(false)
  })

  it('does not believe a Microsoft read that leaves one under half, and takes nothing from it', async () => {
    const { harness, games, refs } = await microsoftGames(20, 9)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toEqual({
      status: 'failed',
      references: 20,
      pricesRead: 0,
      failed: 20,
      requests: 1,
      offers: 20,
      lastReadAt: RUN_AT,
      error:
        'carried 20, the read priced 9: under half of the offers the store had, so the read is not believed and nothing is taken from it',
    })
    expect(result.offersReadAt['xbox-store']).toBe(RUN_AT)
    // Not even the nine prices it was given: an answer that is not believed is not half believed.
    for (const [index, game] of games.entries()) {
      expect(game.offers, `game ${index}`).toEqual([carriedMicrosoft(index)])
    }
    expect(harness.logs).toContain(
      'microsoft: every one of 1 requests was answered and carried 20, the read priced 9: under half of the offers the store had, so the read is not believed and nothing is taken from it',
    )
  })

  it('keeps every Microsoft offer when the store answers 200 with nothing in it', async () => {
    const { harness, games, refs } = await microsoftGames(250, 250)
    // Three requests, each answered — with an empty list.
    for (let request = 0; request < 3; request += 1) harness.answerMicrosoftWith({ Products: [] })

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.microsoftBatches).toHaveLength(3)
    expect(result.microsoft).toMatchObject({
      status: 'failed',
      pricesRead: 0,
      failed: 250,
      requests: 3,
      offers: 250,
      lastReadAt: RUN_AT,
    })
    expect(result.microsoft.error).toMatch(/^carried 250, the read priced 0: /)
    expect(games[0]!.offers).toEqual([carriedMicrosoft(0)])
    expect(games[249]!.offers).toEqual([carriedMicrosoft(249)])
  })

  it('counts what the documents carried after the mapping has had its say', async () => {
    // Forty games carry a GOG offer and twenty of them still have a reference: the other twenty
    // are dropped by the mapping before any read, and are no part of what the read is measured
    // against. Ten priced of twenty is believed; ten of forty would not have been.
    const { harness, games, refs } = await gogGames(40, 10)
    for (const game of games.slice(20)) refs.delete(game.id)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog).toMatchObject({ status: 'read', references: 20, pricesRead: 10, offers: 10 })
  })

  /**
   * The same floor under the mapping. An offer needs a reference, and that rule runs before any
   * read: a mapping that came back empty would take every offer of a store away in a run that
   * never asked the store a thing. So the mapping is believed only while it still names a product
   * for at least half of the games that carry an offer of the store, once there are twenty.
   */
  describe('and under the mapping itself', () => {
    const LOST =
      'carried 20, the mapping names a product for 9 of those games: under half, so the store references look lost'

    /** Takes out of the mapping every game from the `kept`th on. */
    const forget = (refs: StoreRefMap, games: IndexedGame[], kept: number) => {
      for (const game of games.slice(kept)) refs.delete(game.id)
    }

    it('is the same half of the same twenty', () => {
      // Under twenty carried, an offer without a reference is dropped as it always was.
      expect(referencesLookLost(0, 0)).toBeNull()
      expect(referencesLookLost(19, 0)).toBeNull()
      // From twenty: exactly half is believed, one under half is not.
      expect(referencesLookLost(20, 10)).toBeNull()
      expect(referencesLookLost(20, 9)).toBe(LOST)
      expect(referencesLookLost(21, 11)).toBeNull()
      expect(referencesLookLost(21, 10)).toMatch(/^carried 21, the mapping names a product for 10 /)
      expect(referencesLookLost(1_000, 500)).toBeNull()
      expect(referencesLookLost(1_000, 0)).toMatch(
        /^carried 1000, the mapping names a product for 0 /,
      )
      expect(referencesLookLost(20, 20)).toBeNull()
    })

    it('drops GOG offers without a reference as ever while under twenty are carried', async () => {
      const { harness, games, refs } = await gogGames(19, 19)
      forget(refs, games, 0)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog).toMatchObject({ status: 'no-references', references: 0, offers: 0 })
      expect(games.every((game) => !('offers' in game))).toBe(true)
      expect(harness.gogPages).toHaveLength(0)
    })

    it('believes a mapping that names exactly half the games carrying a GOG offer', async () => {
      const { harness, games, refs } = await gogGames(20, 20)
      forget(refs, games, 10)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      // Ten offers go for want of a reference, as on any day; the other ten are read.
      expect(result.gog).toMatchObject({
        status: 'read',
        references: 10,
        pricesRead: 10,
        offers: 10,
        lastReadAt: noon,
      })
      expect(games[9]!.offers?.[0]).toMatchObject({ amount: 599, updatedAt: noon })
      expect('offers' in games[10]!).toBe(false)
      expect('offers' in games[19]!).toBe(false)
    })

    it('does not believe a mapping that names one under half, and drops no GOG offer for it', async () => {
      const { harness, games, refs } = await gogGames(20, 20)
      forget(refs, games, 9)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog).toEqual({
        status: 'references-lost',
        references: 9,
        pricesRead: 0,
        failed: 0,
        requests: 0,
        offers: 20,
        lastReadAt: RUN_AT,
        error: LOST,
      })
      // The stamp stays where it was, and the store was asked nothing.
      expect(result.offersReadAt.gog).toBe(RUN_AT)
      expect(harness.gogPages).toHaveLength(0)
      // Every offer is as it arrived, date included: those of the eleven games the mapping has
      // forgotten, and those of the nine it still names, which a read would have refreshed.
      for (const [index, game] of games.entries()) {
        expect(game.offers, `game ${index}`).toEqual([carriedGog(`game_${index}`)])
      }
      expect(harness.logs).toContain(
        `gog: ${LOST}; every offer is kept as it was and the store is not read`,
      )
    })

    it('heals GOG on the next run once the mapping is back', async () => {
      const { harness, games, refs } = await gogGames(20, 20)
      const whole: StoreRefMap = new Map(refs)
      forget(refs, games, 0)

      const lost = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))
      expect(lost.gog).toMatchObject({ status: 'references-lost', references: 0, offers: 20 })
      expect(games[19]!.offers).toEqual([carriedGog('game_19')])

      // Six hours on the mapping answers again. The stamp never moved, so the store is due.
      harness.clock.advance(6 * HOUR)
      const healed = await refreshOffers(
        harness.deps,
        games,
        whole,
        publishedAt(RUN_AT, { offersReadAt: lost.offersReadAt }),
      )

      const evening = later(noon, 6 * HOUR)
      expect(healed.gog).toMatchObject({
        status: 'read',
        references: 20,
        pricesRead: 20,
        offers: 20,
        lastReadAt: evening,
      })
      expect(games[19]!.offers?.[0]).toMatchObject({ amount: 599, updatedAt: evening })
    })

    it('drops Microsoft offers without a reference as ever while under twenty are carried', async () => {
      const { harness, games, refs } = await microsoftGames(19, 19)
      forget(refs, games, 0)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toMatchObject({ status: 'no-references', references: 0, offers: 0 })
      expect(games.every((game) => !('offers' in game))).toBe(true)
      expect(harness.microsoftBatches).toHaveLength(0)
    })

    it('believes a mapping that names exactly half the games carrying a Microsoft offer', async () => {
      const { harness, games, refs } = await microsoftGames(20, 20)
      forget(refs, games, 10)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toMatchObject({
        status: 'read',
        references: 10,
        pricesRead: 10,
        offers: 10,
        lastReadAt: noon,
      })
      expect(games[9]!.offers?.[0]).toMatchObject({ amount: 25_000, updatedAt: noon })
      expect('offers' in games[10]!).toBe(false)
      expect('offers' in games[19]!).toBe(false)
    })

    it('does not believe a mapping that names one under half, and drops no Microsoft offer for it', async () => {
      const { harness, games, refs } = await microsoftGames(20, 20)
      forget(refs, games, 9)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toEqual({
        status: 'references-lost',
        references: 9,
        pricesRead: 0,
        failed: 0,
        requests: 0,
        offers: 20,
        lastReadAt: RUN_AT,
        error: LOST,
      })
      expect(result.offersReadAt['xbox-store']).toBe(RUN_AT)
      expect(harness.microsoftBatches).toHaveLength(0)
      for (const [index, game] of games.entries()) {
        expect(game.offers, `game ${index}`).toEqual([carriedMicrosoft(index)])
      }
      expect(harness.logs).toContain(
        `microsoft: ${LOST}; every offer is kept as it was and the store is not read`,
      )
    })

    it('heals Microsoft on the next run once the mapping is back', async () => {
      const { harness, games, refs } = await microsoftGames(20, 20)
      const whole: StoreRefMap = new Map(refs)
      forget(refs, games, 0)

      const lost = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))
      expect(lost.microsoft).toMatchObject({ status: 'references-lost', references: 0, offers: 20 })
      expect(games[19]!.offers).toEqual([carriedMicrosoft(19)])

      harness.clock.advance(6 * HOUR)
      const healed = await refreshOffers(
        harness.deps,
        games,
        whole,
        publishedAt(RUN_AT, { offersReadAt: lost.offersReadAt }),
      )

      const evening = later(noon, 6 * HOUR)
      expect(healed.microsoft).toMatchObject({
        status: 'read',
        references: 20,
        pricesRead: 20,
        offers: 20,
        lastReadAt: evening,
      })
      expect(games[19]!.offers?.[0]).toMatchObject({ amount: 25_000, updatedAt: evening })
    })

    it('says so on every run, due or not: it is about what is dropped, not about what is read', async () => {
      const { harness, games, refs } = await gogGames(20, 20)
      forget(refs, games, 0)
      // Read in full an hour ago: on any other day this run would say "not due" and no more.
      const anHourAgo = later(noon, -HOUR)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(anHourAgo))

      expect(result.gog).toMatchObject({
        status: 'references-lost',
        offers: 20,
        lastReadAt: anHourAgo,
      })
      expect(games[0]!.offers).toEqual([carriedGog('game_0')])
    })

    it('holds one store’s offers without holding the other store back', async () => {
      const { harness, games, refs } = await microsoftGames(20, 20)
      // Every game is on GOG as well, and the mapping has lost the Microsoft half of each record.
      for (const [index, game] of games.entries()) {
        game.offers = [carriedGog(`game_${index}`), carriedMicrosoft(index)]
        refs.set(game.id, { gog: `game_${index}` })
      }
      harness.gogCatalog.products = games.map((_, index) =>
        gogProduct(`game_${index}`, gogPrice('5.99', '9.99')),
      )

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog).toMatchObject({
        status: 'read',
        pricesRead: 20,
        offers: 20,
        lastReadAt: noon,
      })
      expect(result.microsoft).toMatchObject({
        status: 'references-lost',
        references: 0,
        requests: 0,
        offers: 20,
        lastReadAt: RUN_AT,
      })
      expect(result.microsoft.error).toMatch(/^carried 20, the mapping names a product for 0 /)
      expect(games[7]!.offers?.[0]).toMatchObject({ store: 'gog', amount: 599, updatedAt: noon })
      expect(games[7]!.offers?.[1]).toEqual(carriedMicrosoft(7))
    })

    it('keeps nothing of the other store for a store whose mapping is not believed', async () => {
      const { harness, games, refs } = await microsoftGames(20, 20)
      // Every game is on GOG as well. The mapping has lost the Microsoft half of every record,
      // and of one game's record the GOG half too: that one is an ordinary loss of a reference.
      for (const [index, game] of games.entries()) {
        game.offers = [carriedGog(`game_${index}`), carriedMicrosoft(index)]
        refs.set(game.id, index === 3 ? {} : { gog: `game_${index}` })
      }
      harness.gogCatalog.products = games.map((_, index) =>
        gogProduct(`game_${index}`, gogPrice('5.99', '9.99')),
      )

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      // What is held is Microsoft's, store by store: the GOG offer without a reference goes as on
      // any day, beside a Microsoft offer that stays.
      expect(result.microsoft).toMatchObject({ status: 'references-lost', offers: 20 })
      expect(result.gog).toMatchObject({ status: 'read', references: 19, offers: 19, dropped: 1 })
      expect(games[3]!.offers).toEqual([carriedMicrosoft(3)])
    })

    it('counts a record nothing could have written as no reference at all', async () => {
      // The keys are all there and none of them is a slug any more: lost is lost, whatever shape
      // the loss takes.
      const { harness, games, refs } = await gogGames(20, 20)
      for (const game of games) refs.set(game.id, { gog: 'Not A Slug' })

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog).toMatchObject({ status: 'references-lost', references: 0, offers: 20 })
      expect(harness.gogPages).toHaveLength(0)
    })
  })

  /**
   * From half up the mapping is believed, and what it no longer names is dropped — which can be
   * half of a store's offers in one run, the night a lost mapping is on its way back. Nothing
   * about that changes; but a run that drops twenty offers of a store this way says so.
   */
  describe('and what a believed mapping costs', () => {
    /** The annotations a run would write about the stores, given this stage's result. */
    const warningsOf = (result: OffersResult) =>
      storeWarnings({
        references: {
          games: 0,
          listed: 0,
          asked: 0,
          gog: 0,
          microsoft: 0,
          playstation: 0,
          sweep: null,
        },
        gog: result.gog,
        microsoft: result.microsoft,
        rate: result.rate,
      })

    /** Takes out of the mapping every game from the `kept`th on. */
    const forget = (refs: StoreRefMap, games: IndexedGame[], kept: number) => {
      for (const game of games.slice(kept)) refs.delete(game.id)
    }

    it('is not counted at all when nothing is dropped', async () => {
      const { harness, games, refs } = await gogGames(40, 40)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect('dropped' in result.gog).toBe(false)
      expect('dropped' in result.microsoft).toBe(false)
      expect(warningsOf(result)).toEqual([])
    })

    it('is counted and not warned about while nineteen GOG offers go', async () => {
      const { harness, games, refs } = await gogGames(38, 38)
      forget(refs, games, 19)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog).toMatchObject({ status: 'read', references: 19, offers: 19, dropped: 19 })
      expect(warningsOf(result)).toEqual([])
    })

    it('is warned about, with the number, when twenty GOG offers go', async () => {
      const { harness, games, refs } = await gogGames(40, 40)
      forget(refs, games, 20)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      // Nothing else is different: the offers are dropped, the store is read, the stamp moves.
      expect(result.gog).toMatchObject({
        status: 'read',
        references: 20,
        pricesRead: 20,
        offers: 20,
        dropped: 20,
        lastReadAt: noon,
      })
      expect('offers' in games[20]!).toBe(false)
      expect(warningsOf(result)).toEqual([
        'GOG: 20 offers dropped because their games no longer have a store reference',
      ])
    })

    it('is counted and not warned about while nineteen Microsoft offers go', async () => {
      const { harness, games, refs } = await microsoftGames(38, 38)
      forget(refs, games, 19)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toMatchObject({
        status: 'read',
        references: 19,
        offers: 19,
        dropped: 19,
      })
      expect(warningsOf(result)).toEqual([])
    })

    it('is warned about, with the number, when twenty Microsoft offers go', async () => {
      const { harness, games, refs } = await microsoftGames(40, 40)
      forget(refs, games, 20)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toMatchObject({
        status: 'read',
        references: 20,
        pricesRead: 20,
        offers: 20,
        dropped: 20,
        lastReadAt: noon,
      })
      expect('offers' in games[20]!).toBe(false)
      expect(warningsOf(result)).toEqual([
        'Microsoft Store: 20 offers dropped because their games no longer have a store reference',
      ])
    })

    it('is warned about when two faults compound: half gone by the mapping, half of the rest by the read', async () => {
      // 250 carried; the mapping names 125, exactly half, and is believed; the store prices 63 of
      // those, just over half, and is believed. 187 of 250 offers are gone in one run that reads
      // in full and moves its stamp — and it must not end without a word.
      const { harness, games, refs } = await microsoftGames(250, 63)
      forget(refs, games, 125)

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.microsoft).toMatchObject({
        status: 'read',
        references: 125,
        pricesRead: 63,
        offers: 63,
        dropped: 125,
        lastReadAt: noon,
      })
      expect(warningsOf(result)).toEqual([
        'Microsoft Store: 125 offers dropped because their games no longer have a store reference',
      ])
    })

    it('is warned about in a run that reads nothing, too', async () => {
      const { harness, games, refs } = await gogGames(40, 40)
      forget(refs, games, 20)

      // Read in full an hour ago: the store is not due, and the offers are dropped all the same.
      const result = await refreshOffers(harness.deps, games, refs, publishedAt(later(noon, -HOUR)))

      expect(result.gog).toMatchObject({ status: 'not-due', offers: 20, dropped: 20 })
      expect(harness.gogPages).toHaveLength(0)
      expect(warningsOf(result)).toEqual([
        'GOG: 20 offers dropped because their games no longer have a store reference',
      ])
    })

    it('counts a game once, whatever its document carried of the store', async () => {
      const { harness, games, refs } = await gogGames(40, 40)
      forget(refs, games, 20)
      // The same store twice on one document: one game, one offer dropped.
      games[39]!.offers = [carriedGog('game_39'), carriedGog('game_39')]

      const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

      expect(result.gog.dropped).toBe(20)
    })
  })
})

describe('an offer needs a reference', () => {
  it('drops an offer the mapping names no product for, whatever the document arrived carrying', async () => {
    // Under eleven hours after a read: nothing is asked, and the documents still come out right.
    const { harness, games, byId } = await runAt(later(RUN_AT, HOUR))
    byId(101).offers = [GOG_OFFER, MICROSOFT_OFFER]
    byId(102).offers = [GOG_OFFER]
    byId(103).offers = [{ ...GOG_OFFER, store: 'epic-games' as never }]
    const refs: StoreRefMap = new Map([[101, { gog: 'hollow_cradle' }]])

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect('offers' in byId(102)).toBe(false)
    expect('offers' in byId(103)).toBe(false)
    expect(result.gog).toMatchObject({ status: 'not-due', references: 1, offers: 1 })
    expect(result.microsoft).toMatchObject({ status: 'no-references', references: 0, offers: 0 })
  })

  it('takes one store’s offer from a game for want of that store’s reference, and leaves the other', async () => {
    const { harness, games, byId } = await runAt(later(RUN_AT, HOUR))
    byId(101).offers = [GOG_OFFER, MICROSOFT_OFFER]
    byId(109).offers = [GOG_OFFER, MICROSOFT_OFFER]
    // Each of the two has lost one half of its record, and not the same half.
    const refs: StoreRefMap = new Map([
      [101, { microsoft: { id: JOB_MICROSOFT_ID, name: 'hollow-cradle' } }],
      [109, { gog: 'hollow_cradle' }],
    ])

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(101).offers).toEqual([MICROSOFT_OFFER])
    expect(byId(109).offers).toEqual([GOG_OFFER])
    expect(result.gog).toMatchObject({ status: 'not-due', references: 1, offers: 1, dropped: 1 })
    expect(result.microsoft).toMatchObject({
      status: 'not-due',
      references: 1,
      offers: 1,
      dropped: 1,
    })
  })

  it('keeps one offer a store when a document arrives carrying two of the same store', async () => {
    const { harness, games, byId } = await runAt(later(RUN_AT, HOUR))
    const refs: StoreRefMap = new Map([
      [101, { gog: 'hollow_cradle', microsoft: { id: JOB_MICROSOFT_ID, name: 'hollow-cradle' } }],
    ])
    const second = { ...GOG_OFFER, amount: 1, regularAmount: 1, discountPercent: 0 }
    // Out of order, and with GOG twice: no run of this job writes that, and one may still read it.
    byId(101).offers = [MICROSOFT_OFFER, GOG_OFFER, second]

    await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // At most one a store, the first of each, in the stores' own order.
    expect(byId(101).offers).toEqual([GOG_OFFER, MICROSOFT_OFFER])
  })

  it('asks a store nothing when no game of the run has a product there', async () => {
    const { harness, games } = await runAt(RUN_AT)

    const result = await refreshOffers(harness.deps, games, new Map(), null)

    expect(harness.gogPages).toHaveLength(0)
    expect(harness.microsoftBatches).toHaveLength(0)
    expect(result.gog).toMatchObject({ status: 'no-references', lastReadAt: null })
    expect(result.offersReadAt).toEqual({})
  })

  it('makes no request out of a record no link could have produced', async () => {
    const { harness, games } = await runAt(RUN_AT)
    const refs = new Map([
      [101, { gog: 'hollow_cradle&countryCode=US' }],
      [109, { microsoft: { id: 'BTQMHK78ZPF9&market=US', name: 'lost-canton' } }],
    ]) as StoreRefMap

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(harness.gogPages).toHaveLength(0)
    expect(harness.microsoftBatches).toHaveLength(0)
    expect(result.gog.references).toBe(0)
    expect(result.microsoft.references).toBe(0)
  })
})

describe('the rate', () => {
  it('is read once a run, for the day in Kyiv', async () => {
    // Half past midnight in Kyiv on the 21st, while UTC is still on the 20th.
    const at = '2026-09-20T21:30:00.000Z'
    const { harness, games, refs } = await runAt(at)

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(harness.bankDays).toEqual(['2026-09-21'])
    expect(result.exchangeRate).toEqual({
      currency: 'USD',
      uah: JOB_BANK_RATE,
      date: '2026-09-21',
      readAt: at,
    })
  })

  it('keeps the published rate, and the run, when the runtime cannot tell the day in Kyiv', async () => {
    const { harness, games, refs } = await runAt(later(RUN_AT, DAY))
    // What `Intl` does on a runtime whose time-zone data has no Kyiv in it.
    const format = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      throw new RangeError('Invalid time zone specified: Europe/Kyiv')
    } as never)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT)).finally(() =>
      format.mockRestore(),
    )

    // The bank was never asked, for there was no day to ask it about — and that is the bank's
    // loss alone: the stage ends as it ends when the bank is down.
    expect(harness.bankDays).toHaveLength(0)
    expect(result.rate).toEqual({ status: 'kept', rate: RATE })
    expect(result.gog.status).toBe('read')
    expect(harness.logs.at(-1)).toBe(
      'rate: the National Bank could not be read (Invalid time zone specified: Europe/Kyiv); keeping the rate for 2026-09-20',
    )
  })

  it('replaces the published rate with today’s', async () => {
    const at = later(RUN_AT, DAY)
    const { harness, games, refs } = await runAt(at)
    harness.bankState.rate = 45.1203

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.rate).toEqual({
      status: 'read',
      rate: { currency: 'USD', uah: 45.1203, date: '2026-09-21', readAt: at },
    })
  })

  it('keeps the published rate, as it was, when the bank cannot be read', async () => {
    const { harness, games, refs } = await runAt(later(RUN_AT, 3 * DAY))
    harness.bankState.down = true

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    // Its date and the moment it was read are its own: seven days are counted from that moment.
    expect(result.rate).toEqual({ status: 'kept', rate: RATE })
    expect(result.exchangeRate).toEqual(RATE)
  })

  it('keeps it for seven days and drops it after', async () => {
    expect(RATE_KEPT_MS).toBe(7 * DAY)

    const onTheSeventh = await runAt(later(RUN_AT, 7 * DAY))
    onTheSeventh.harness.bankState.down = true
    const kept = await refreshOffers(
      onTheSeventh.harness.deps,
      onTheSeventh.games,
      onTheSeventh.refs,
      publishedAt(RUN_AT),
    )
    expect(kept.rate).toEqual({ status: 'kept', rate: RATE })

    const past = await runAt(later(RUN_AT, 7 * DAY + 1))
    past.harness.bankState.down = true
    const dropped = await refreshOffers(
      past.harness.deps,
      past.games,
      past.refs,
      publishedAt(RUN_AT),
    )
    expect(dropped.rate).toEqual({ status: 'none', rate: null })
    // No field at all: nothing approximate can be made from it.
    expect(dropped.exchangeRate).toBeUndefined()
    expect(past.harness.logs).toContain(
      'rate: the National Bank could not be read (NBU upstream failure); no rate under seven days old is left',
    )
  })

  it('has none to keep on a first run, or after metadata that never had one', async () => {
    const { harness, games, refs } = await runAt(RUN_AT)
    harness.bankState.down = true

    expect((await refreshOffers(harness.deps, games, refs, null)).rate.status).toBe('none')
    const older: IndexMeta = {
      version: 1,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: 9,
    }
    expect((await refreshOffers(harness.deps, games, refs, older)).exchangeRate).toBeUndefined()
  })

  it.each([
    ['is about another day', bankAnswer('2026-09-22')],
    ['is empty', []],
    ['is about the euro', [{ ...bankAnswer('2026-09-23')[0], cc: 'EUR', r030: 978 }]],
    ['states an absurd rate', bankAnswer('2026-09-23', 4495.67)],
    ['is not a list', { rate: 44.9567 }],
  ])('keeps the published rate when the bank’s answer %s', async (_what, answer) => {
    const { harness, games, refs } = await runAt(later(RUN_AT, 3 * DAY))
    harness.bankState.answer = answer

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.rate).toEqual({ status: 'kept', rate: RATE })
  })

  it.each([
    ['in another currency', { ...RATE, currency: 'EUR' }],
    ['with a rate that is not a positive number', { ...RATE, uah: 0 }],
    ['with a rate that is text', { ...RATE, uah: '44.9567' }],
    ['read at no moment anyone can tell', { ...RATE, readAt: 'recently' }],
    ['read in the future', { ...RATE, readAt: later(RUN_AT, 30 * DAY) }],
  ])('does not keep a published rate %s', async (_what, rate) => {
    const { harness, games, refs } = await runAt(later(RUN_AT, DAY))
    harness.bankState.down = true

    const result = await refreshOffers(
      harness.deps,
      games,
      refs,
      publishedAt(RUN_AT, { exchangeRate: rate as never }),
    )

    expect(result.rate).toEqual({ status: 'none', rate: null })
  })
})

describe('the write lock', () => {
  it('is renewed after every page of the walk', async () => {
    const { harness, games, refs } = await runAt(RUN_AT)
    harness.gogCatalog.pageSize = 1
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    await refreshOffers(harness.deps, games, refs, null)

    // Three pages, and one Microsoft request.
    expect(harness.gogPages).toEqual([1, 2, 3])
    expect(renewLock).toHaveBeenCalledTimes(4)
  })

  it('fails as the index, not as GOG, when it cannot be renewed', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    vi.spyOn(harness.writer, 'renewLock').mockRejectedValue(new Error('the index is unreachable'))

    await expect(refreshOffers(harness.deps, games, refs, null)).rejects.toThrow(
      'the index is unreachable',
    )
    // The walk itself was whole, and nothing in the log blames the store. Nothing of it is put
    // on a document either: the run is over, and a version nobody publishes needs no offers.
    expect('offers' in byId(101)).toBe(false)
    expect(harness.logs.filter((line) => line.startsWith('gog:'))).toEqual([])
  })
})
