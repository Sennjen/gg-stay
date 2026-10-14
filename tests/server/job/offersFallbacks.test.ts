import { describe, expect, it, vi } from 'vitest'
import { collectCandidates } from '../../../scripts/index/candidates'
import { OFFER_FLOOR_MIN_CARRIED, refreshOffers } from '../../../scripts/index/offers'
import { MICROSOFT_SEARCHES_PER_RUN } from '../../../scripts/index/storeFallbacks'
import { sweepStoreRefs, type StoreRefMap } from '../../../scripts/index/storeRefs'
import type {
  IndexMeta,
  IndexedGame,
  IndexedOffer,
  IndexedStoreRefs,
} from '../../../server/index/document'
import { UpstreamError } from '../../../server/upstream/errors'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import {
  gogPrice,
  gogProduct,
  JOB_MICROSOFT_ID,
  JOB_MICROSOFT_TITLE,
  microsoftDetail,
  microsoftProduct,
  microsoftSearchAnswer,
} from '../../fixtures/index/jobStores'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The price stage once RAWG's link is the first way to a product and no longer the only one. In
 * the job catalog game 101, "Hollow Cradle" (2021-03-11), has the GOG slug `hollow_cradle`, and
 * game 109, "Lost Canton" (2017-09-29), the Microsoft product `9NLOSTCANT0N`. Each case here
 * takes one of those two away from its store, or the link itself from RAWG's answer, and looks at
 * what the stage finds instead, what it remembers, and what the next run does with that.
 */

const RUN_AT = '2026-10-13T03:00:00.000Z'
const HOUR = 3_600_000
const DAY = 24 * HOUR

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

interface Run {
  harness: JobHarness
  games: IndexedGame[]
  refs: StoreRefMap
  byId: (id: number) => IndexedGame
  /** RAWG requests the run had made before the stage began. */
  rawgCalls: number
}

/** The run's games with their store references read, as the stage finds them. */
async function runAt(start: string, writer?: JobHarness['writer']): Promise<Run> {
  const harness = createJobHarness({ start, writer })
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const { refs } = await sweepStoreRefs(harness.deps, games)
  return {
    harness,
    games,
    refs,
    byId: (id) => games.find((game) => game.id === id)!,
    rawgCalls: harness.calls.length,
  }
}

/** The next run over the same index: what the run before it wrote is what it reads. */
async function nextRun(previous: Run, start: string): Promise<Run> {
  const run = await runAt(start, previous.harness.writer)
  // What the run before published is what this one's documents arrive carrying.
  for (const game of run.games) {
    const before = previous.byId(game.id).offers
    if (before) game.offers = structuredClone(before)
  }
  return run
}

/** The metadata a version published at `at` would carry, both stores read in full then. */
function publishedAt(at: string): IndexMeta {
  return {
    version: 1,
    updatedAt: at,
    pricesUpdatedAt: at,
    gameCount: 9,
    offersReadAt: { gog: at, 'xbox-store': at },
  }
}

const LINK = { id: JOB_MICROSOFT_ID, name: 'lost-canton' }

/** A product id as the catalog spells one, for hand-written worlds: `9N0000000007`. */
const pid = (number: number) => `9N${String(number).padStart(10, '0')}`

describe('GOG: a game whose slug is not in the catalog any more', () => {
  const GOLD = gogProduct('hollow_cradle_gold_edition', gogPrice('14.99', '29.99'), {
    productType: 'pack',
    title: 'Hollow Cradle - Gold Edition',
    releaseDate: '2022.06.01',
  })
  const GOLD_OFFER = (updatedAt: string): IndexedOffer => ({
    store: 'gog',
    via: 'edition',
    title: 'Hollow Cradle - Gold Edition',
    amount: 1499,
    regularAmount: 2999,
    currency: 'USD',
    discountPercent: 50,
    // The found product's own page, as the catalog gives it.
    url: 'https://www.gog.com/en/game/hollow_cradle_gold_edition',
    updatedAt,
  })

  it('is found in the walked catalog under the edition GOG sells it as, at no request more', async () => {
    const { harness, games, refs, byId, rawgCalls } = await runAt(RUN_AT)
    harness.gogCatalog.products = [gogProduct('amber_archive', gogPrice('4.99', '4.99')), GOLD]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([GOLD_OFFER(RUN_AT)])
    expect(result.gog).toEqual({
      status: 'read',
      references: 1,
      pricesRead: 1,
      failed: 0,
      requests: 1,
      offers: 1,
      lastReadAt: RUN_AT,
      otherWays: { edition: 1 },
      fallbacks: { searched: 1, found: { edition: 1 }, waiting: 0, requests: 0 },
    })
    expect(harness.gogPages).toEqual([1])
    expect(harness.calls).toHaveLength(rawgCalls)
    expect(harness.logs).toContain(
      'gog: 1 references, 1 prices read in 1 requests; 1 looked for by name, 1 found',
    )
  })

  it('is remembered beside RAWG’s slug, which is kept as RAWG gave it', async () => {
    const { harness, games, refs } = await runAt(RUN_AT)
    harness.gogCatalog.products = [GOLD]

    await refreshOffers(harness.deps, games, refs, null)

    const record: IndexedStoreRefs = {
      gog: 'hollow_cradle',
      fallbacks: {
        gog: { slug: 'hollow_cradle_gold_edition', via: 'edition', foundAt: RUN_AT },
      },
    }
    expect(refs.get(101)).toEqual(record)
    expect((await harness.writer.getStoreRefs([101])).get(101)).toEqual(record)
  })

  it('is found under its own name before any edition', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    harness.gogCatalog.products = [
      GOLD,
      gogProduct('hollow_cradle_2021', gogPrice('19.99', '19.99'), {
        title: 'Hollow Cradle',
        releaseDate: '2021.03.11',
      }),
    ]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([
      {
        store: 'gog',
        via: 'name',
        title: 'Hollow Cradle',
        amount: 1999,
        regularAmount: 1999,
        currency: 'USD',
        discountPercent: 0,
        url: 'https://www.gog.com/en/game/hollow_cradle_2021',
        updatedAt: RUN_AT,
      },
    ])
    expect(result.gog).toMatchObject({ otherWays: { name: 1 }, fallbacks: { found: { name: 1 } } })
  })

  it('has no price when no product is the game by its title: looked for, and not found', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle_2', gogPrice('9.99', '9.99'), { title: 'Hollow Cradle 2' }),
      gogProduct('hollow_cradle_deluxe', gogPrice('9.99', '9.99'), {
        title: 'Hollow Cradle Deluxe Edition',
      }),
    ]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect('offers' in byId(101)).toBe(false)
    expect(result.gog).toMatchObject({
      status: 'read',
      pricesRead: 0,
      offers: 0,
      fallbacks: { searched: 1, found: {}, waiting: 0, requests: 0 },
    })
    expect(result.gog).not.toHaveProperty('otherWays')
    // Nothing was found, so nothing is remembered: the record is RAWG's alone.
    expect(refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })

  it('is not looked for under a title while its slug is in the catalog, priced or not', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    // RAWG's slug names a product GOG has not released yet; another product has the name.
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle', null),
      gogProduct('hollow_cradle_2021', gogPrice('19.99', '19.99'), {
        title: 'Hollow Cradle',
        releaseDate: '2021.03.11',
      }),
    ]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect('offers' in byId(101)).toBe(false)
    expect(result.gog).not.toHaveProperty('fallbacks')
    expect(refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })

  const COMPLETE = gogProduct('hollow_cradle_complete', gogPrice('9.99', '39.99'), {
    productType: 'pack',
    title: 'Hollow Cradle: Complete Edition',
    releaseDate: '2023.01.01',
  })

  it('keeps what an earlier walk found while it is sold, though a cheaper edition qualifies now', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const noon = later(RUN_AT, 12 * HOUR)
    const next = await nextRun(night, noon)
    next.harness.gogCatalog.products = [GOLD, COMPLETE]
    const written = vi.spyOn(next.harness.writer, 'setStoreRefs')

    await refreshOffers(next.harness.deps, next.games, next.refs, publishedAt(RUN_AT))

    // A find goes when its own product has no price, and not because another would be picked.
    expect(next.byId(101).offers).toEqual([GOLD_OFFER(noon)])
    expect(written).not.toHaveBeenCalled()
  })

  it('looks through the catalog again once the product an earlier walk found has no price', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const noon = later(RUN_AT, 12 * HOUR)
    const next = await nextRun(night, noon)
    next.harness.gogCatalog.products = [
      gogProduct('hollow_cradle_gold_edition', null, {
        productType: 'pack',
        title: 'Hollow Cradle - Gold Edition',
      }),
      COMPLETE,
    ]

    await refreshOffers(next.harness.deps, next.games, next.refs, publishedAt(RUN_AT))

    expect(next.byId(101).offers?.[0]).toMatchObject({
      via: 'edition',
      title: 'Hollow Cradle: Complete Edition',
      amount: 999,
      url: 'https://www.gog.com/en/game/hollow_cradle_complete',
      updatedAt: noon,
    })
    expect((await next.harness.writer.getStoreRefs([101])).get(101)).toEqual({
      gog: 'hollow_cradle',
      fallbacks: { gog: { slug: 'hollow_cradle_complete', via: 'edition', foundAt: noon } },
    })
  })

  it('leaves the record as it was when a walk finds what the last one found', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const noon = later(RUN_AT, 12 * HOUR)
    const next = await nextRun(night, noon)
    next.harness.gogCatalog.products = [GOLD]
    const written = vi.spyOn(next.harness.writer, 'setStoreRefs')

    await refreshOffers(next.harness.deps, next.games, next.refs, publishedAt(RUN_AT))

    // The price is today's, under today's date; the record still says when it was first found.
    expect(next.byId(101).offers).toEqual([GOLD_OFFER(noon)])
    expect(written).not.toHaveBeenCalled()
    expect(next.refs.get(101)?.fallbacks?.gog?.foundAt).toBe(RUN_AT)
  })

  it('loses the offer when a walk in full finds no product for it, and the record forgets', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const next = await nextRun(night, later(RUN_AT, 12 * HOUR))
    next.harness.gogCatalog.products = [gogProduct('amber_archive', gogPrice('4.99', '4.99'))]

    const result = await refreshOffers(
      next.harness.deps,
      next.games,
      next.refs,
      publishedAt(RUN_AT),
    )

    expect('offers' in next.byId(101)).toBe(false)
    expect(result.gog).toMatchObject({ status: 'read', pricesRead: 0, offers: 0 })
    expect((await next.harness.writer.getStoreRefs([101])).get(101)).toEqual({
      gog: 'hollow_cradle',
    })
  })

  it('goes back to RAWG’s slug the day that is in the catalog again, and remembers the find', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const noon = later(RUN_AT, 12 * HOUR)
    const next = await nextRun(night, noon)
    next.harness.gogCatalog.products = [
      GOLD,
      gogProduct('hollow_cradle', gogPrice('9.99', '19.99')),
    ]

    const result = await refreshOffers(
      next.harness.deps,
      next.games,
      next.refs,
      publishedAt(RUN_AT),
    )

    const [offer] = next.byId(101).offers!
    expect(offer).toMatchObject({ amount: 999, url: 'https://www.gog.com/en/game/hollow_cradle' })
    // Found through the link: the offer says nothing, as every offer did.
    expect('via' in offer!).toBe(false)
    expect(result.gog).not.toHaveProperty('otherWays')
    expect(result.gog).not.toHaveProperty('fallbacks')
    // RAWG's link comes first while it has a price; the find is the game's again the day it has
    // none, and is not forgotten meanwhile.
    expect(next.refs.get(101)?.fallbacks?.gog?.slug).toBe('hollow_cradle_gold_edition')
  })

  it('keeps the offer and the record through a walk that fails', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const next = await nextRun(night, later(RUN_AT, 12 * HOUR))
    next.harness.failGogPage(1)

    const result = await refreshOffers(
      next.harness.deps,
      next.games,
      next.refs,
      publishedAt(RUN_AT),
    )

    expect(result.gog).toMatchObject({ status: 'failed', offers: 1, otherWays: { edition: 1 } })
    expect(next.byId(101).offers).toEqual([GOLD_OFFER(RUN_AT)])
    expect(next.refs.get(101)?.fallbacks?.gog?.slug).toBe('hollow_cradle_gold_edition')
  })

  it('keeps the offer through the runs between two walks: the record is its reference', async () => {
    const night = await runAt(RUN_AT)
    night.harness.gogCatalog.products = [GOLD]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const morning = await nextRun(night, later(RUN_AT, 6 * HOUR))
    const result = await refreshOffers(
      morning.harness.deps,
      morning.games,
      morning.refs,
      publishedAt(RUN_AT),
    )

    expect(morning.harness.gogPages).toEqual([])
    expect(morning.byId(101).offers).toEqual([GOLD_OFFER(RUN_AT)])
    expect(result.gog).toMatchObject({ status: 'not-due', offers: 1, otherWays: { edition: 1 } })
    expect(result.gog).not.toHaveProperty('dropped')
  })
})

describe('GOG: a game RAWG lists there and gives no link for', () => {
  const NAMED = gogProduct('hollow_cradle_2021', gogPrice('19.99', '19.99'), {
    title: 'Hollow Cradle',
    releaseDate: '2021.03.11',
  })
  const NAMED_OFFER = (updatedAt: string): IndexedOffer => ({
    store: 'gog',
    via: 'name',
    title: 'Hollow Cradle',
    amount: 1999,
    regularAmount: 1999,
    currency: 'USD',
    discountPercent: 0,
    url: 'https://www.gog.com/en/game/hollow_cradle_2021',
    updatedAt,
  })

  it('is looked for by its name, and what is found stands beside RAWG’s "no link"', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    refs.set(101, { gog: null })
    harness.gogCatalog.products = [NAMED]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(101).offers).toEqual([NAMED_OFFER(RUN_AT)])
    expect(refs.get(101)).toEqual({
      gog: null,
      fallbacks: { gog: { slug: 'hollow_cradle_2021', via: 'name', foundAt: RUN_AT } },
    })
    // No game has a slug of RAWG's: the catalog is walked for the name alone.
    expect(result.gog).toMatchObject({
      status: 'read',
      references: 0,
      pricesRead: 1,
      offers: 1,
      otherWays: { name: 1 },
    })
  })

  it('keeps the offer through the runs between two walks, where "no link" alone kept none', async () => {
    const night = await runAt(RUN_AT)
    night.refs.set(101, { gog: null })
    await night.harness.writer.setStoreRefs([[101, { gog: null }]])
    night.harness.gogCatalog.products = [NAMED]
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const morning = await nextRun(night, later(RUN_AT, 6 * HOUR))
    const result = await refreshOffers(
      morning.harness.deps,
      morning.games,
      morning.refs,
      publishedAt(RUN_AT),
    )

    expect(morning.byId(101).offers).toEqual([NAMED_OFFER(RUN_AT)])
    expect(result.gog).toMatchObject({ status: 'not-due', references: 1, offers: 1 })

    // The same morning with a record that remembers nothing: an offer needs a reference.
    const forgotten = await nextRun(night, later(RUN_AT, 6 * HOUR))
    forgotten.refs.set(101, { gog: null })
    const dropped = await refreshOffers(
      forgotten.harness.deps,
      forgotten.games,
      forgotten.refs,
      publishedAt(RUN_AT),
    )
    expect('offers' in forgotten.byId(101)).toBe(false)
    expect(dropped.gog).toMatchObject({ offers: 0, dropped: 1 })
  })

  it('is not looked for when RAWG does not list it on GOG, or was never asked about it', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    // Game 102 is on Steam alone; a record that says "no link" of GOG says nothing more of it.
    refs.set(102, { gog: null })
    // Game 101 is on GOG, and its record does not say it was ever asked about.
    refs.set(101, {})
    harness.gogCatalog.products = [
      NAMED,
      gogProduct('neon_district', gogPrice('9.99', '9.99'), { title: 'Neon District' }),
    ]

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect('offers' in byId(101)).toBe(false)
    expect('offers' in byId(102)).toBe(false)
    expect(result.gog).toMatchObject({ status: 'no-references', requests: 0 })
    expect(harness.gogPages).toEqual([])
  })
})

describe('GOG: the floor and what was found by name', () => {
  it('counts an offer found by name as a price the read gave: a store that renamed its pages is not one that stopped selling', async () => {
    const { harness, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    const games: IndexedGame[] = []
    const refs: StoreRefMap = new Map()
    const products: unknown[] = []
    for (let index = 0; index < OFFER_FLOOR_MIN_CARRIED; index += 1) {
      const game = { ...structuredClone(byId(101)), id: 2000 + index, name: `Game ${index}` }
      game.offers = [
        {
          store: 'gog',
          amount: 999,
          regularAmount: 999,
          currency: 'USD',
          discountPercent: 0,
          url: `https://www.gog.com/en/game/game_${index}`,
          updatedAt: RUN_AT,
        },
      ]
      games.push(game)
      // Every slug RAWG has is gone from the catalog; every game is there under its name.
      refs.set(game.id, { gog: `game_${index}` })
      products.push(
        gogProduct(`game_${index}_2021`, gogPrice('7.99', '7.99'), {
          title: `Game ${index}`,
          releaseDate: '2021.03.11',
        }),
      )
    }
    harness.gogCatalog.products = products

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.gog).toMatchObject({
      status: 'read',
      pricesRead: 20,
      offers: 20,
      otherWays: { name: 20 },
    })
    expect(games.every((game) => game.offers?.[0]?.amount === 799)).toBe(true)
  })
})

/** A world in which the product RAWG links for Lost Canton is no longer sold. */
async function unsold(start = RUN_AT, writer?: JobHarness['writer']): Promise<Run> {
  const run = await runAt(start, writer)
  Reflect.deleteProperty(run.harness.microsoftProducts, JOB_MICROSOFT_ID)
  return run
}

/** Puts a sibling of the linked product on sale: same group, the linked product's own title. */
function relate(harness: JobHarness, sibling = pid(7), list = 1199) {
  harness.microsoftDetails[JOB_MICROSOFT_ID] = microsoftDetail(
    JOB_MICROSOFT_ID,
    JOB_MICROSOFT_TITLE,
    { group: 'canton', parents: [pid(1)] },
  )
  harness.microsoftDetails[pid(1)] = microsoftDetail(pid(1), 'Lost Canton', {
    group: 'canton',
    bundles: [JOB_MICROSOFT_ID, sibling],
  })
  harness.microsoftProducts[sibling] = microsoftProduct(sibling, list, list, JOB_MICROSOFT_TITLE, {
    group: 'canton',
    released: '2026-01-20T00:00:00.0000000Z',
  })
}

const RELATED_OFFER = (updatedAt: string, amount = 119_900): IndexedOffer => ({
  store: 'xbox-store',
  via: 'relation',
  title: JOB_MICROSOFT_TITLE,
  amount,
  regularAmount: amount,
  currency: 'UAH',
  discountPercent: 0,
  // The found product's page for Ukraine, under a name made from the store's title for it.
  url: 'https://www.microsoft.com/uk-ua/p/lost-canton-definitive-edition/9n0000000007',
  updatedAt,
})

const REMEMBERED = (searchedAt: string, foundAt = searchedAt): IndexedStoreRefs => ({
  microsoft: LINK,
  fallbacks: {
    microsoft: {
      searchedAt,
      found: {
        id: pid(7),
        name: 'lost-canton-definitive-edition',
        via: 'relation',
        foundAt,
      },
    },
  },
})

describe('the Microsoft Store: a game whose linked product is not sold any more', () => {
  it('is found through the catalog’s own relations, and offered at what that product costs', async () => {
    const { harness, games, refs, byId, rawgCalls } = await unsold()
    relate(harness)

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(109).offers).toEqual([RELATED_OFFER(RUN_AT)])
    expect(result.microsoft).toEqual({
      status: 'read',
      references: 1,
      // The read itself priced nothing: RAWG's product is not sold.
      pricesRead: 0,
      failed: 0,
      requests: 1,
      offers: 1,
      lastReadAt: RUN_AT,
      otherWays: { relation: 1 },
      // The linked product, what it was made of, and the price of what that is sold in.
      fallbacks: { searched: 1, found: { relation: 1 }, waiting: 0, requests: 3 },
    })
    expect(harness.microsoftBatches).toEqual([[JOB_MICROSOFT_ID], [pid(7)]])
    expect(harness.microsoftDetailBatches).toEqual([[JOB_MICROSOFT_ID], [pid(1)]])
    expect(harness.microsoftSearchNames).toEqual([])
    expect(harness.calls).toHaveLength(rawgCalls)
    expect(harness.logs).toContain(
      "microsoft: the store's own ways were tried for 1 games in 3 requests, 1 found, 0 waiting",
    )
  })

  it('is remembered beside RAWG’s product, which is kept as RAWG gave it', async () => {
    const { harness, games, refs } = await unsold()
    relate(harness)

    await refreshOffers(harness.deps, games, refs, null)

    expect(refs.get(109)).toEqual(REMEMBERED(RUN_AT))
    expect((await harness.writer.getStoreRefs([109])).get(109)).toEqual(REMEMBERED(RUN_AT))
  })

  it('is found by the store’s search when its relations lead nowhere', async () => {
    const { harness, games, refs, byId } = await unsold()
    harness.microsoftSearches['Lost Canton'] = microsoftSearchAnswer([
      { id: pid(8), title: 'Lost Canton' },
      { id: pid(9), title: 'Lost Canton Gold Edition' },
    ])
    const listing = { group: 'canton', released: '2018-02-01T00:00:00.0000000Z' }
    harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 610, 610, 'Lost Canton', listing)
    harness.microsoftProducts[pid(9)] = microsoftProduct(
      pid(9),
      305,
      1220,
      'Lost Canton Gold Edition',
      listing,
    )

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(109).offers).toEqual([
      {
        store: 'xbox-store',
        via: 'name',
        title: 'Lost Canton',
        amount: 61_000,
        regularAmount: 61_000,
        currency: 'UAH',
        discountPercent: 0,
        url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9n0000000008',
        updatedAt: RUN_AT,
      },
    ])
    // The relations first — one request, which found no parent — and then the search.
    expect(harness.microsoftDetailBatches).toEqual([[JOB_MICROSOFT_ID]])
    expect(harness.microsoftSearchNames).toEqual(['Lost Canton'])
    expect(result.microsoft).toMatchObject({
      otherWays: { name: 1 },
      fallbacks: { searched: 1, found: { name: 1 }, waiting: 0, requests: 3 },
    })
    expect(refs.get(109)?.fallbacks?.microsoft?.found).toEqual({
      id: pid(8),
      name: 'lost-canton',
      via: 'name',
      foundAt: RUN_AT,
    })
  })

  it('is found under an edition’s name when nothing is under its own', async () => {
    const { harness, games, refs, byId } = await unsold()
    harness.microsoftSearches['Lost Canton'] = microsoftSearchAnswer([
      { id: pid(9), title: 'Lost Canton Enhanced (PC)' },
    ])
    harness.microsoftProducts[pid(9)] = microsoftProduct(
      pid(9),
      674.5,
      1349,
      'Lost Canton Enhanced (PC)',
      { released: '2025-04-15T15:00:00.0000000Z' },
    )

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(109).offers?.[0]).toMatchObject({
      via: 'edition',
      // What the page shows under the store's name: which edition the price is for.
      title: 'Lost Canton Enhanced (PC)',
      amount: 67_450,
      regularAmount: 134_900,
      discountPercent: 50,
      url: 'https://www.microsoft.com/uk-ua/p/lost-canton-enhanced-pc/9n0000000009',
    })
    expect(result.microsoft).toMatchObject({ otherWays: { edition: 1 } })
  })

  it('has no price when no way finds one, and that is remembered too', async () => {
    const { harness, games, refs, byId } = await unsold()

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect('offers' in byId(109)).toBe(false)
    expect(result.microsoft).toMatchObject({
      status: 'read',
      offers: 0,
      fallbacks: { searched: 1, found: {}, waiting: 0, requests: 2 },
    })
    expect(result.microsoft).not.toHaveProperty('otherWays')
    expect(refs.get(109)).toEqual({
      microsoft: LINK,
      fallbacks: { microsoft: { searchedAt: RUN_AT } },
    })
  })

  it('is not looked for by any other way while RAWG’s product has a price', async () => {
    const { harness, games, refs, byId } = await runAt(RUN_AT)
    relate(harness)

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(109).offers?.[0]).toMatchObject({ amount: 38_500 })
    expect('via' in byId(109).offers![0]!).toBe(false)
    expect(harness.microsoftDetailBatches).toEqual([])
    expect(harness.microsoftSearchNames).toEqual([])
    expect(result.microsoft).not.toHaveProperty('fallbacks')
    expect(refs.get(109)).toEqual({ microsoft: LINK })
  })
})

describe('the Microsoft Store: what a found product is from then on', () => {
  /** The night the product was found, and the run that follows it at `start`. */
  async function found(start: string) {
    const night = await unsold()
    relate(night.harness)
    await refreshOffers(night.harness.deps, night.games, night.refs, null)
    const next = await nextRun(night, start)
    Reflect.deleteProperty(next.harness.microsoftProducts, JOB_MICROSOFT_ID)
    relate(next.harness)
    return next
  }
  const noon = later(RUN_AT, 12 * HOUR)

  it('is priced directly, in the read every product is priced in, and costs no search', async () => {
    const { harness, games, refs, byId, rawgCalls } = await found(noon)
    // A sale began in the meantime.
    harness.microsoftProducts[pid(7)] = microsoftProduct(pid(7), 599.5, 1199, JOB_MICROSOFT_TITLE)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(109).offers).toEqual([
      { ...RELATED_OFFER(noon, 59_950), regularAmount: 119_900, discountPercent: 50 },
    ])
    // One request: RAWG's product and the found one, asked about together.
    expect(harness.microsoftBatches).toEqual([[JOB_MICROSOFT_ID, pid(7)]])
    expect(harness.microsoftDetailBatches).toEqual([])
    expect(harness.microsoftSearchNames).toEqual([])
    expect(harness.calls).toHaveLength(rawgCalls)
    expect(result.microsoft).toEqual({
      status: 'read',
      references: 1,
      pricesRead: 1,
      failed: 0,
      requests: 1,
      offers: 1,
      lastReadAt: noon,
      otherWays: { relation: 1 },
    })
    // Nothing was looked for, so nothing is written: the record still says when it was found.
    expect(refs.get(109)).toEqual(REMEMBERED(RUN_AT))
  })

  it('gives way to RAWG’s product the day that has a price again: the link is the first way', async () => {
    const { harness, games, refs, byId } = await found(noon)
    harness.microsoftProducts[JOB_MICROSOFT_ID] = microsoftProduct(
      JOB_MICROSOFT_ID,
      385,
      385,
      JOB_MICROSOFT_TITLE,
    )

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    const [offer] = byId(109).offers!
    expect(offer).toMatchObject({
      amount: 38_500,
      url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9nlostcant0n',
      updatedAt: noon,
    })
    expect('via' in offer!).toBe(false)
    expect(result.microsoft).not.toHaveProperty('otherWays')
    // What was found is still remembered: it is the game's price the day the link's is gone.
    expect(refs.get(109)).toEqual(REMEMBERED(RUN_AT))
  })

  it('keeps its offer through the runs between two reads: the record is its reference', async () => {
    const { harness, games, refs, byId } = await found(later(RUN_AT, 6 * HOUR))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.microsoftBatches).toEqual([])
    expect(byId(109).offers).toEqual([RELATED_OFFER(RUN_AT)])
    expect(result.microsoft).toMatchObject({
      status: 'not-due',
      offers: 1,
      otherWays: { relation: 1 },
    })
  })

  it('loses its offer only when a read in full finds that very product without a price', async () => {
    const { harness, games, refs, byId } = await found(noon)
    Reflect.deleteProperty(harness.microsoftProducts, pid(7))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(109)).toBe(false)
    expect(result.microsoft).toMatchObject({ status: 'read', pricesRead: 0, offers: 0 })
    // Searched for twelve hours ago: the ways are not tried again, and nobody is waiting.
    expect(harness.microsoftDetailBatches).toEqual([])
    expect(harness.microsoftSearchNames).toEqual([])
    expect(result.microsoft).not.toHaveProperty('fallbacks')
    expect(refs.get(109)).toEqual(REMEMBERED(RUN_AT))
  })

  it('keeps its offer through a read in which a request failed', async () => {
    const { harness, games, refs, byId } = await found(noon)
    harness.failMicrosoftBatchWith(pid(7))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(byId(109).offers).toEqual([RELATED_OFFER(RUN_AT)])
    expect(result.microsoft).toMatchObject({ status: 'failed', failed: 1, lastReadAt: RUN_AT })
  })

  it('is asked about again in every read, and offered again the day it is sold again', async () => {
    const gone = await found(noon)
    Reflect.deleteProperty(gone.harness.microsoftProducts, pid(7))
    await refreshOffers(gone.harness.deps, gone.games, gone.refs, publishedAt(RUN_AT))
    expect('offers' in gone.byId(109)).toBe(false)

    const back = await nextRun(gone, later(noon, 12 * HOUR))
    Reflect.deleteProperty(back.harness.microsoftProducts, JOB_MICROSOFT_ID)
    relate(back.harness)
    await refreshOffers(back.harness.deps, back.games, back.refs, publishedAt(noon))

    expect(back.byId(109).offers).toEqual([RELATED_OFFER(later(noon, 12 * HOUR))])
    expect(back.harness.microsoftSearchNames).toEqual([])
  })
})

describe('the Microsoft Store: the thirty days between two looks', () => {
  it('does not look again for a game it found nothing for, until thirty days have passed', async () => {
    const night = await unsold()
    await refreshOffers(night.harness.deps, night.games, night.refs, null)
    expect(night.harness.microsoftSearchNames).toEqual(['Lost Canton'])

    // Every later read asks about RAWG's product, and nothing else of Microsoft.
    for (const elapsed of [12 * HOUR, 15 * DAY, 30 * DAY]) {
      const at = later(RUN_AT, elapsed)
      const run = await unsold(at, night.harness.writer)
      const result = await refreshOffers(
        run.harness.deps,
        run.games,
        run.refs,
        publishedAt(later(at, -12 * HOUR)),
      )

      expect(run.harness.microsoftBatches).toEqual([[JOB_MICROSOFT_ID]])
      expect(run.harness.microsoftDetailBatches).toEqual([])
      expect(run.harness.microsoftSearchNames).toEqual([])
      expect(result.microsoft).toMatchObject({ status: 'read' })
      expect(result.microsoft).not.toHaveProperty('fallbacks')
      expect(run.refs.get(109)?.fallbacks?.microsoft?.searchedAt).toBe(RUN_AT)
    }

    // A product comes to the store later than its game comes to RAWG.
    const at = later(RUN_AT, 30 * DAY + 1)
    const run = await unsold(at, night.harness.writer)
    run.harness.microsoftSearches['Lost Canton'] = microsoftSearchAnswer([
      { id: pid(8), title: 'Lost Canton' },
    ])
    run.harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 610, 610, 'Lost Canton', {
      released: '2026-11-01T00:00:00.0000000Z',
    })
    await refreshOffers(run.harness.deps, run.games, run.refs, publishedAt(later(at, -12 * HOUR)))

    expect(run.harness.microsoftSearchNames).toEqual(['Lost Canton'])
    expect(run.byId(109).offers?.[0]).toMatchObject({ via: 'name', amount: 61_000 })
    expect(run.refs.get(109)?.fallbacks?.microsoft).toMatchObject({
      searchedAt: at,
      found: { id: pid(8), foundAt: at },
    })
  })

  it('keeps the product an earlier look found when a later look finds nothing', async () => {
    const night = await unsold()
    relate(night.harness)
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    // Thirty-one days on the found product is not sold, and nothing else is the game either.
    const at = later(RUN_AT, 31 * DAY)
    const run = await unsold(at, night.harness.writer)
    const result = await refreshOffers(
      run.harness.deps,
      run.games,
      run.refs,
      publishedAt(later(at, -12 * HOUR)),
    )

    expect(result.microsoft).toMatchObject({
      fallbacks: { searched: 1, found: {}, waiting: 0 },
    })
    // Only the date moved. The product is asked about in every read, and may be sold again.
    expect(run.refs.get(109)).toEqual(REMEMBERED(at, RUN_AT))
    expect(run.harness.microsoftBatches[0]).toEqual([JOB_MICROSOFT_ID, pid(7)])
  })
})

describe('the Microsoft Store: a game RAWG lists there and gives no link for', () => {
  /** Lost Canton as RAWG lists it on the Xbox store with no link the job can read. */
  async function unlinked(start = RUN_AT, writer?: JobHarness['writer']) {
    const run = await runAt(start, writer)
    if (!writer) {
      run.refs.set(109, { microsoft: null })
      await run.harness.writer.setStoreRefs([[109, { microsoft: null }]])
    }
    run.harness.microsoftSearches['Lost Canton'] = microsoftSearchAnswer([
      { id: pid(8), title: 'Lost Canton' },
    ])
    run.harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 610, 610, 'Lost Canton', {
      released: '2018-02-01T00:00:00.0000000Z',
    })
    return run
  }

  it('is searched for by its name: it has no product to read relations from', async () => {
    const { harness, games, refs, byId } = await unlinked()

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(byId(109).offers?.[0]).toMatchObject({
      via: 'name',
      amount: 61_000,
      url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9n0000000008',
    })
    expect(harness.microsoftDetailBatches).toEqual([])
    // Only the price of what the search found was read: no game had a product to ask about.
    expect(harness.microsoftBatches).toEqual([[pid(8)]])
    expect(result.microsoft).toMatchObject({
      status: 'read',
      references: 0,
      requests: 0,
      offers: 1,
      lastReadAt: RUN_AT,
      fallbacks: { searched: 1, found: { name: 1 }, waiting: 0, requests: 2 },
    })
    expect(refs.get(109)).toEqual({
      microsoft: null,
      fallbacks: {
        microsoft: {
          searchedAt: RUN_AT,
          found: { id: pid(8), name: 'lost-canton', via: 'name', foundAt: RUN_AT },
        },
      },
    })
  })

  it('keeps the offer afterwards, and is priced by its product’s id like any other', async () => {
    const night = await unlinked()
    await refreshOffers(night.harness.deps, night.games, night.refs, null)

    const morning = await nextRun(night, later(RUN_AT, 6 * HOUR))
    const carried = await refreshOffers(
      morning.harness.deps,
      morning.games,
      morning.refs,
      publishedAt(RUN_AT),
    )
    expect(morning.byId(109).offers?.[0]).toMatchObject({ via: 'name', updatedAt: RUN_AT })
    expect(carried.microsoft).toMatchObject({ status: 'not-due', references: 1, offers: 1 })
    expect(carried.microsoft).not.toHaveProperty('dropped')

    const noon = later(RUN_AT, 12 * HOUR)
    const next = await nextRun(night, noon)
    next.harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 610, 610, 'Lost Canton', {
      released: '2018-02-01T00:00:00.0000000Z',
    })
    const read = await refreshOffers(next.harness.deps, next.games, next.refs, publishedAt(RUN_AT))

    expect(next.harness.microsoftBatches).toEqual([[pid(8)]])
    expect(next.harness.microsoftSearchNames).toEqual([])
    expect(next.byId(109).offers?.[0]).toMatchObject({ via: 'name', updatedAt: noon })
    expect(read.microsoft).toMatchObject({ status: 'read', references: 1, pricesRead: 1 })
  })

  it('is not searched for when RAWG does not list it on the Xbox store, or was never asked', async () => {
    const { harness, games, refs, byId } = await unlinked()
    // Game 102 is on Steam alone; "no link" in its record does not put it on the Xbox store.
    refs.set(102, { microsoft: null })
    harness.microsoftSearches['Neon District'] = microsoftSearchAnswer([
      { id: pid(9), title: 'Neon District' },
    ])
    // Game 109 is on the Xbox store, and its record does not say it was ever asked about.
    refs.set(109, {})

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(harness.microsoftSearchNames).toEqual([])
    expect('offers' in byId(109)).toBe(false)
    expect('offers' in byId(102)).toBe(false)
    expect(result.microsoft).toMatchObject({ status: 'no-references', requests: 0 })
  })
})

/**
 * `count` games on the Xbox store, each naming a Microsoft product of its own that is not sold;
 * the first is the least popular and the last the most.
 */
function unsoldGames(base: IndexedGame, count: number) {
  const games: IndexedGame[] = []
  const refs: StoreRefMap = new Map()
  for (let index = 0; index < count; index += 1) {
    games.push({
      ...structuredClone(base),
      id: 3000 + index,
      slug: `game-${index}`,
      name: `Game ${index}`,
      popularity: index,
    })
    refs.set(3000 + index, { microsoft: { id: pid(5000 + index), name: `game-${index}` } })
  }
  return { games, refs }
}

describe('the Microsoft Store: how much is asked of it in one run', () => {
  it('tries its own ways for a hundred and fifty games a run, the most popular first', async () => {
    const { harness, byId } = await runAt(RUN_AT)
    const { games, refs } = unsoldGames(byId(109), 160)
    const setStoreRefs = vi.spyOn(harness.writer, 'setStoreRefs')

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(MICROSOFT_SEARCHES_PER_RUN).toBe(150)
    expect(harness.microsoftSearchNames).toHaveLength(150)
    expect(harness.microsoftSearchNames.slice(0, 3)).toEqual(['Game 159', 'Game 158', 'Game 157'])
    expect(harness.microsoftSearchNames.at(-1)).toBe('Game 10')
    expect(result.microsoft).toMatchObject({
      status: 'read',
      references: 160,
      // Two requests for the prices; eight for the relations of 150 products, and 150 searches.
      requests: 2,
      fallbacks: { searched: 150, found: {}, waiting: 10, requests: 158 },
    })
    // Remembered in one write, and only for the games whose turn it was.
    expect(setStoreRefs).toHaveBeenCalledTimes(1)
    expect(refs.get(3159)?.fallbacks?.microsoft?.searchedAt).toBe(RUN_AT)
    expect(refs.get(3009)).not.toHaveProperty('fallbacks')
  })

  it('takes up the games that were left waiting with the next run that finds the store due', async () => {
    const night = await runAt(RUN_AT)
    const { games, refs } = unsoldGames(night.byId(109), 160)
    await refreshOffers(night.harness.deps, games, refs, null)

    const noon = later(RUN_AT, 12 * HOUR)
    const next = createJobHarness({ start: noon, writer: night.harness.writer })
    const result = await refreshOffers(next.deps, games, refs, publishedAt(RUN_AT))

    expect(next.microsoftSearchNames).toEqual(
      Array.from({ length: 10 }, (_, index) => `Game ${9 - index}`),
    )
    expect(result.microsoft).toMatchObject({
      fallbacks: { searched: 10, waiting: 0, requests: 11 },
    })

    // And then nobody is waiting, and the ways are tried for nobody.
    const evening = createJobHarness({
      start: later(noon, 12 * HOUR),
      writer: night.harness.writer,
    })
    const quiet = await refreshOffers(evening.deps, games, refs, publishedAt(noon))
    expect(evening.microsoftSearchNames).toEqual([])
    expect(quiet.microsoft).not.toHaveProperty('fallbacks')
  })

  it('asks nothing more once the store refuses a request, and keeps what it had found', async () => {
    const { harness, byId } = await runAt(RUN_AT)
    const { games, refs } = unsoldGames(byId(109), 40)
    // The most popular game is found by its relations; the third search is refused.
    harness.microsoftDetails[pid(5039)] = microsoftDetail(pid(5039), 'Game 39', {
      group: 'thirty-nine',
      parents: [pid(1)],
    })
    harness.microsoftDetails[pid(1)] = microsoftDetail(pid(1), 'Game 39', {
      group: 'thirty-nine',
      bundles: [pid(7)],
    })
    harness.microsoftProducts[pid(7)] = microsoftProduct(pid(7), 1199, 1199, 'Game 39', {
      group: 'thirty-nine',
    })
    harness.failMicrosoftSearchFor('Game 36', new UpstreamError('MICROSOFT', 'RATE_LIMITED', 429))

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(harness.microsoftSearchNames).toEqual(['Game 38', 'Game 37', 'Game 36'])
    expect(result.microsoft).toMatchObject({
      // The read was in full and is believed: the refusal is the ways', and changes neither.
      status: 'read',
      lastReadAt: RUN_AT,
      offers: 1,
      otherWays: { relation: 1 },
      fallbacks: {
        searched: 3,
        found: { relation: 1 },
        waiting: 37,
        stopped: 'refused',
        error: 'MICROSOFT upstream failure: RATE_LIMITED (429)',
      },
    })
    expect(result.microsoft).not.toHaveProperty('error')
    expect(games.at(-1)?.offers?.[0]).toMatchObject({ via: 'relation', amount: 119_900 })
    // The games that were not reached are remembered nowhere, and wait.
    expect(refs.get(3036)).not.toHaveProperty('fallbacks')
    expect(refs.get(3000)).not.toHaveProperty('fallbacks')
    expect(harness.logs.at(-2)).toBe(
      "microsoft: the store's own ways were tried for 3 games in 7 requests, 1 found, 37 waiting \u2014 stopped early, the store refused a request",
    )
  })
})

describe('the Microsoft Store: when its own ways are not tried at all', () => {
  /** Twenty-five games carrying last night's offer, each naming a product of its own. */
  async function carrying(start: string) {
    const { harness, byId } = await runAt(start)
    const { games, refs } = unsoldGames(byId(109), 25)
    for (const game of games) {
      game.offers = [
        {
          store: 'xbox-store',
          amount: 77_000,
          regularAmount: 77_000,
          currency: 'UAH',
          discountPercent: 0,
          url: `https://www.microsoft.com/uk-ua/p/${game.slug}/x`,
          updatedAt: RUN_AT,
        },
      ]
    }
    return { harness, games, refs }
  }
  const noon = later(RUN_AT, 12 * HOUR)
  const untried = (harness: JobHarness) => [
    harness.microsoftDetailBatches.length,
    harness.microsoftSearchNames.length,
  ]

  it('not in a run that does not find the store due', async () => {
    const { harness, games, refs } = await carrying(later(RUN_AT, 6 * HOUR))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft.status).toBe('not-due')
    expect(untried(harness)).toEqual([0, 0])
  })

  it('not after a read in which a request failed: a store that is failing is not asked for more', async () => {
    const { harness, games, refs } = await carrying(noon)
    harness.failMicrosoftBatchWith(pid(5000))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft.status).toBe('failed')
    expect(untried(harness)).toEqual([0, 0])
    expect(result.microsoft).not.toHaveProperty('fallbacks')
  })

  it('not after a read the floor refused: a job that may be misreading the store finds nothing new in it', async () => {
    const { harness, games, refs } = await carrying(noon)

    // Every request answered, and none of the twenty-five products priced.
    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({ status: 'failed', offers: 25, lastReadAt: RUN_AT })
    expect(untried(harness)).toEqual([0, 0])
    expect(games.every((game) => game.offers?.[0]?.amount === 77_000)).toBe(true)
  })

  it('not while the store references look lost', async () => {
    const { harness, games } = await carrying(noon)

    const result = await refreshOffers(harness.deps, games, new Map(), publishedAt(RUN_AT))

    expect(result.microsoft.status).toBe('references-lost')
    expect(untried(harness)).toEqual([0, 0])
  })
})

describe('the Microsoft Store: what its own ways cannot do', () => {
  it('cannot take an offer away, fail the stage, or hold back the stamp, whatever the store answers', async () => {
    const { harness, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    const { games, refs } = unsoldGames(byId(109), 30)
    // The twenty most popular are sold and carry last night's offer; the ten others are not.
    for (const game of games.slice(10)) {
      const id = pid(5000 + (game.id - 3000))
      harness.microsoftProducts[id] = microsoftProduct(id, 385)
      game.offers = [
        {
          store: 'xbox-store',
          amount: 77_000,
          regularAmount: 77_000,
          currency: 'UAH',
          discountPercent: 0,
          url: `https://www.microsoft.com/uk-ua/p/${game.slug}/x`,
          updatedAt: RUN_AT,
        },
      ]
    }
    // Everything the ways ask is refused, garbled or thrown at them.
    harness.deps.microsoftCatalog = {
      details: async () => '<html>Bad Gateway</html>',
      search: async () => {
        throw new TypeError('fetch failed')
      },
    }

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    const at = later(RUN_AT, 12 * HOUR)
    expect(result.microsoft).toMatchObject({
      status: 'read',
      pricesRead: 20,
      offers: 20,
      lastReadAt: at,
      // The relations of the ten could not be read, so none of them is searched for either:
      // the order of the ways holds, and they wait for the next run.
      fallbacks: { searched: 0, found: {}, waiting: 10, requests: 1 },
    })
    expect(result.microsoft.fallbacks?.error).toBe('MICROSOFT upstream failure: ERROR')
    expect(games.slice(10).every((game) => game.offers?.[0]?.updatedAt === at)).toBe(true)
    expect(result.offersReadAt['xbox-store']).toBe(at)
    // Nothing was settled, so nothing was remembered: the ten wait for the next run.
    expect(games.slice(0, 10).every((game) => !('fallbacks' in refs.get(game.id)!))).toBe(true)
  })

  it('cannot move the store’s stamp: it is the read’s, and of the moment the read ended', async () => {
    const { harness, games, refs } = await unsold()
    const search = harness.deps.microsoftCatalog.search
    harness.deps.microsoftCatalog = {
      ...harness.deps.microsoftCatalog,
      search: async (name) => {
        harness.clock.advance(3 * 60_000)
        return search(name)
      },
    }

    const result = await refreshOffers(harness.deps, games, refs, null)

    expect(result.microsoft.lastReadAt).toBe(RUN_AT)
    // What the ways did is dated when they did it.
    expect(refs.get(109)?.fallbacks?.microsoft?.searchedAt).toBe(later(RUN_AT, 3 * 60_000))
  })

  it('asks RAWG nothing, in any state', async () => {
    const night = await unsold()
    relate(night.harness)
    await refreshOffers(night.harness.deps, night.games, night.refs, null)
    expect(night.harness.calls).toHaveLength(night.rawgCalls)

    const next = await unsold(later(RUN_AT, 31 * DAY), night.harness.writer)
    await refreshOffers(next.harness.deps, next.games, next.refs, publishedAt(RUN_AT))
    expect(next.harness.microsoftSearchNames).toEqual(['Lost Canton'])
    expect(next.harness.calls).toHaveLength(next.rawgCalls)
  })

  it('writes the mapping before any document, and an index that will not take it fails the stage as the index', async () => {
    const { harness, games, refs, byId } = await unsold()
    relate(harness)
    vi.spyOn(harness.writer, 'setStoreRefs').mockRejectedValue(new Error('READONLY'))

    await expect(refreshOffers(harness.deps, games, refs, null)).rejects.toThrow('READONLY')

    // No offer is published for a product the mapping does not name.
    expect('offers' in byId(109)).toBe(false)
  })
})

describe('the order of the ways when a read is not whole', () => {
  /**
   * A hundred games whose products fill the first request, and Lost Canton after them: RAWG's
   * product is the last id of the first request, and the found one the first id of the second.
   */
  async function split() {
    const { harness, byId } = await runAt(later(RUN_AT, 12 * HOUR))
    const { games, refs } = unsoldGames(byId(102), 99)
    for (const game of games) {
      const id = pid(5000 + (game.id - 3000))
      harness.microsoftProducts[id] = microsoftProduct(id, 100)
    }
    const canton = byId(109)
    canton.offers = [RELATED_OFFER(RUN_AT)]
    refs.set(109, REMEMBERED(RUN_AT))
    harness.microsoftProducts[pid(7)] = microsoftProduct(pid(7), 899, 899, JOB_MICROSOFT_TITLE)
    return { harness, games: [...games, canton], refs, canton }
  }

  it('does not price a game by what was found while the request about RAWG’s product failed', async () => {
    const { harness, games, refs, canton } = await split()
    harness.failMicrosoftBatchWith(JOB_MICROSOFT_ID)

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(harness.microsoftBatches.map((batch) => batch.length)).toEqual([100, 1])
    // The found product was answered, at a new price; nobody knows whether the link's has one.
    expect(canton.offers).toEqual([RELATED_OFFER(RUN_AT)])
    expect(result.microsoft).toMatchObject({ status: 'partial', failed: 100, pricesRead: 0 })
  })

  it('keeps the offer when the request about the found product failed and the link has no price', async () => {
    const { harness, games, refs, canton } = await split()
    Reflect.deleteProperty(harness.microsoftProducts, JOB_MICROSOFT_ID)
    harness.failMicrosoftBatchWith(pid(7))

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(canton.offers).toEqual([RELATED_OFFER(RUN_AT)])
    expect(result.microsoft).toMatchObject({ status: 'partial', failed: 1, pricesRead: 99 })
  })

  it('prices a game by RAWG’s product when that was answered, whatever became of the other request', async () => {
    const { harness, games, refs, canton } = await split()
    harness.failMicrosoftBatchWith(pid(7))

    await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(canton.offers?.[0]).toMatchObject({
      amount: 38_500,
      url: 'https://www.microsoft.com/uk-ua/p/lost-canton/9nlostcant0n',
    })
    expect('via' in canton.offers![0]!).toBe(false)
  })
})

describe('the mapping guard and what the stores’ own ways found', () => {
  it('counts a found product as the mapping naming one: twenty offers found by name are not a lost mapping', async () => {
    const { harness, byId } = await runAt(later(RUN_AT, 6 * HOUR))
    const games: IndexedGame[] = []
    const refs: StoreRefMap = new Map()
    for (let index = 0; index < OFFER_FLOOR_MIN_CARRIED; index += 1) {
      const game = { ...structuredClone(byId(109)), id: 4000 + index, slug: `game-${index}` }
      game.offers = [{ ...RELATED_OFFER(RUN_AT), via: 'name' }]
      games.push(game)
      // RAWG gave no link for any of them; each was found by the store's search.
      refs.set(game.id, {
        microsoft: null,
        fallbacks: {
          microsoft: {
            searchedAt: RUN_AT,
            found: { id: pid(index), name: `game-${index}`, via: 'name', foundAt: RUN_AT },
          },
        },
      })
    }

    const result = await refreshOffers(harness.deps, games, refs, publishedAt(RUN_AT))

    expect(result.microsoft).toMatchObject({
      status: 'not-due',
      references: 20,
      offers: 20,
      otherWays: { name: 20 },
    })
    expect(result.microsoft).not.toHaveProperty('dropped')
  })
})

describe('a remake that took the game’s name', () => {
  /** A later game of the run under Hollow Cradle's name, and under Lost Canton's. */
  function remade(run: Run): IndexedGame[] {
    const remakes = [
      {
        ...structuredClone(run.byId(101)),
        id: 9101,
        slug: 'hollow-cradle-2025',
        released: '2025-06-01',
      },
      {
        ...structuredClone(run.byId(109)),
        id: 9109,
        slug: 'lost-canton-2024',
        released: '2024-02-01',
      },
    ]
    for (const remake of remakes) delete remake.offers
    return [...run.games, ...remakes]
  }

  it('is no product for the older game at either store when the run holds the remake too', async () => {
    const run = await unsold()
    const { harness, refs, byId } = run
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle_2025', gogPrice('29.99', '29.99'), {
        title: 'Hollow Cradle',
        releaseDate: '2025.06.01',
      }),
    ]
    harness.microsoftSearches['Lost Canton'] = microsoftSearchAnswer([
      { id: pid(8), title: 'Lost Canton' },
    ])
    harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 1499, 1499, 'Lost Canton', {
      released: '2024-02-01T00:00:00.0000000Z',
    })

    const result = await refreshOffers(harness.deps, remade(run), refs, null)

    // Both products are well inside twelve years of the old games; the remakes in the run are
    // what refuses them. The old games' searches are not even sent.
    expect('offers' in byId(101)).toBe(false)
    expect('offers' in byId(109)).toBe(false)
    expect(harness.microsoftSearchNames).toEqual([])
    expect(result.gog).toMatchObject({ pricesRead: 0, fallbacks: { searched: 1, found: {} } })
    expect(result.microsoft).toMatchObject({ fallbacks: { searched: 1, found: {}, requests: 1 } })
    expect(refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })

  it('takes nothing from the older game’s relations: that way keeps its own rules', async () => {
    const run = await unsold()
    relate(run.harness)

    await refreshOffers(run.harness.deps, remade(run), run.refs, null)

    expect(run.byId(109).offers).toEqual([RELATED_OFFER(RUN_AT)])
  })

  it('takes a find away from the older game when it is read again under the guards', async () => {
    const run = await unsold(later(RUN_AT, 12 * HOUR))
    const { harness, refs, byId } = run
    // An earlier run found it by name, before the guards: a product listed eighteen years later.
    refs.set(109, {
      microsoft: LINK,
      fallbacks: {
        microsoft: {
          searchedAt: RUN_AT,
          found: { id: pid(8), name: 'lost-canton', via: 'name', foundAt: RUN_AT },
        },
      },
    })
    byId(109).offers = [{ ...RELATED_OFFER(RUN_AT), via: 'name' }]
    harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 1499, 1499, 'Lost Canton', {
      released: '2035-11-10T00:00:00.0000000Z',
    })

    const result = await refreshOffers(harness.deps, run.games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(109)).toBe(false)
    expect(result.microsoft).toMatchObject({ status: 'read', pricesRead: 0, offers: 0 })
  })

  it('takes a find away when a later namesake has come into the run since', async () => {
    const run = await unsold(later(RUN_AT, 12 * HOUR))
    const { harness, refs, byId } = run
    refs.set(109, {
      microsoft: LINK,
      fallbacks: {
        microsoft: {
          searchedAt: RUN_AT,
          found: { id: pid(8), name: 'lost-canton', via: 'name', foundAt: RUN_AT },
        },
      },
    })
    byId(109).offers = [{ ...RELATED_OFFER(RUN_AT), via: 'name' }]
    harness.microsoftProducts[pid(8)] = microsoftProduct(pid(8), 1499, 1499, 'Lost Canton', {
      released: '2024-02-01T00:00:00.0000000Z',
    })

    await refreshOffers(harness.deps, remade(run), refs, publishedAt(RUN_AT))

    expect('offers' in byId(109)).toBe(false)
  })

  it('looks through GOG’s catalog again when an earlier find fails the guards, and forgets it', async () => {
    const run = await runAt(later(RUN_AT, 12 * HOUR))
    const { harness, refs, byId } = run
    refs.set(101, {
      gog: 'hollow_cradle',
      fallbacks: { gog: { slug: 'hollow_cradle_2040', via: 'name', foundAt: RUN_AT } },
    })
    byId(101).offers = [
      {
        store: 'gog',
        via: 'name',
        amount: 999,
        regularAmount: 999,
        currency: 'USD',
        discountPercent: 0,
        url: 'https://www.gog.com/en/game/hollow_cradle_2040',
        updatedAt: RUN_AT,
      },
    ]
    harness.gogCatalog.products = [
      gogProduct('hollow_cradle_2040', gogPrice('9.99', '9.99'), {
        title: 'Hollow Cradle',
        releaseDate: '2040.01.01',
      }),
    ]

    await refreshOffers(harness.deps, run.games, refs, publishedAt(RUN_AT))

    expect('offers' in byId(101)).toBe(false)
    expect(refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })
})
