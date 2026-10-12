import { describe, expect, it, vi } from 'vitest'
import { collectCandidates } from '../../../scripts/index/candidates'
import {
  isOffersReadDue,
  OFFERS_MAX_AGE_MS,
  RATE_KEPT_MS,
  refreshOffers,
} from '../../../scripts/index/offers'
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
  microsoftProduct,
} from '../../fixtures/index/jobStores'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The stage that reads GOG, the Microsoft Store and the National Bank. In the job catalog game
 * 101 has a GOG page (`hollow_cradle`, $9.99 against $19.99) and game 109 a Microsoft product
 * (385 ₴); the other seven have neither.
 */

const RUN_AT = '2026-09-20T03:00:00.000Z'
const HOUR = 3_600_000
const DAY = 24 * HOUR

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const GOG_OFFER: IndexedOffer = {
  store: 'gog',
  amount: 999,
  regularAmount: 1999,
  currency: 'USD',
  discountPercent: 50,
  url: 'https://www.gog.com/en/game/hollow_cradle',
  updatedAt: RUN_AT,
}

const MICROSOFT_OFFER: IndexedOffer = {
  store: 'xbox-store',
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
    harness.microsoftProducts[JOB_MICROSOFT_ID] = microsoftProduct(JOB_MICROSOFT_ID, 0)

    await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([
      { ...GOG_OFFER, amount: 0, regularAmount: 0, discountPercent: 0 },
    ])
    expect(byId(109).offers).toEqual([{ ...MICROSOFT_OFFER, amount: 0, regularAmount: 0 }])
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
    expect(games[0]!.offers).toEqual([
      {
        ...MICROSOFT_OFFER,
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
    // The walk itself was whole, and nothing in the log blames the store.
    expect(byId(101).offers).toEqual([GOG_OFFER])
    expect(harness.logs.filter((line) => line.startsWith('gog:'))).toEqual([])
  })
})
