import { describe, expect, it, vi } from 'vitest'
import { OFFER_FLOOR_MIN_CARRIED, refreshOffers } from '../../../scripts/index/offers'
import {
  PLAYSTATION_BUDGET_MS,
  PLAYSTATION_PAUSE_MS,
  PLAYSTATION_REQUESTS_PER_RUN,
} from '../../../scripts/index/playstation'
import {
  PLAYSTATION_MAPPINGS_PER_RUN,
  PLAYSTATION_REF_BATCH_SIZE,
  PLAYSTATION_REREAD_AFTER_MS,
  refreshPlaystationOffers,
  removalsNotBelieved,
  type PlaystationReport,
} from '../../../scripts/index/playstationOffers'
import { playstationWarnings } from '../../../scripts/index/run'
import type { StoreRefMap } from '../../../scripts/index/storeRefs'
import type { IndexedGame, IndexedOffer, IndexedStoreRefs } from '../../../server/index/document'
import {
  JOB_PLAYSTATION_SALE_ENDS,
  JOB_PLAYSTATION_SALE_ENDS_AT,
  sonyConcept,
  sonyFreeDownload,
  sonyNoConcept,
  sonyNotInTheStore,
  sonyPlusCatalogue,
  sonyPrice,
  sonyProduct,
  sonyPurchase,
  sonyTrial,
} from '../../fixtures/index/jobPlaystation'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The stage that reads the PlayStation Store: which games a run asks about and in what order,
 * what an answer does to an offer, and how the stage ends. The transport under it is the real
 * one, on the fake clock (`harness.ts`), so "a request" below is a request the transport let out.
 */

const START = '2026-10-13T06:15:00.000Z'
const STARTED = Date.parse(START)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const STORE = 'playstation-store'
const BELIEVED = { lost: null, dropped: 0 }

const iso = (at: number) => new Date(at).toISOString()
const ago = (ms: number) => iso(STARTED - ms)

/** A game of these tests by its number: its title at Sony's, its concept, its product. */
const five = (id: number) => String(id).padStart(5, '0')
const titleOf = (id: number) => `CUSA${five(id)}_00`
const conceptOf = (id: number) => 50_000 + id
const productOf = (id: number) => `EP0001-CUSA${five(id)}_00-GAME${String(id).padStart(12, '0')}`
const urlOf = (id: number) => `https://store.playstation.com/uk-ua/product/${productOf(id)}`

function offerOf(id: number, updatedAt: string, extra: Partial<IndexedOffer> = {}): IndexedOffer {
  return {
    store: STORE,
    title: `Game ${id}`,
    amount: 49_900,
    regularAmount: 49_900,
    discountPercent: 0,
    currency: 'UAH',
    url: urlOf(id),
    updatedAt,
    ...extra,
  }
}

interface Spec {
  id: number
  /** `false` for a title Sony has not been asked about, `null` for one it has no concept for. */
  mapped?: boolean | null
  /** How long before the run the game's offer was read; no offer when left out. */
  readAgo?: number
  /** How long before the run Sony answered with no price; never when left out. */
  unpricedAgo?: number
  popularity?: number
}

interface World {
  harness: JobHarness
  games: IndexedGame[]
  refs: StoreRefMap
  byId: (id: number) => IndexedGame
  psOffer: (id: number) => IndexedOffer | undefined
  run: (verdict?: { lost: string | null; dropped: number }) => Promise<PlaystationReport>
  /** The games asked about, in order, by the kind of question. */
  asked: (kind: 'price' | 'concept') => number[]
}

function document(spec: Spec): IndexedGame {
  return {
    id: spec.id,
    slug: `game-${spec.id}`,
    name: `Game ${spec.id}`,
    cover: null,
    preview: null,
    released: '2020-01-01',
    popularity: spec.popularity ?? 10_000 - spec.id,
    platforms: [18],
    genres: [],
    stores: ['steam', STORE],
    gameModes: [],
    ageRating: null,
    rating: null,
    ratingsCount: 0,
    metacritic: null,
    playtime: null,
    priceUah: 499,
    regularPriceUah: 499,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: START,
    ...(spec.readAgo === undefined ? {} : { offers: [offerOf(spec.id, ago(spec.readAgo))] }),
  }
}

/**
 * A run's games as the stage finds them, and a Sony that knows every one of them: each title in
 * a concept of its own, each concept with a product at 499,00 ₴.
 */
function world(specs: Spec[], start = START): World {
  const harness = createJobHarness({ start })
  const games = specs.map(document)
  const refs: StoreRefMap = new Map()
  for (const spec of specs) {
    const { id } = spec
    refs.set(id, {
      playstation: {
        titleId: titleOf(id),
        ...(spec.mapped === false
          ? {}
          : { conceptId: spec.mapped === null ? null : conceptOf(id) }),
        ...(spec.unpricedAgo === undefined ? {} : { unpricedAt: ago(spec.unpricedAgo) }),
      },
    })
    harness.sonyConcepts[titleOf(id)] = sonyConcept(conceptOf(id), [titleOf(id)])
    harness.sonyPrices[conceptOf(id)] = sonyPrice(
      conceptOf(id),
      sonyProduct(conceptOf(id), productOf(id), `Game ${id}`, [sonyPurchase(49_900)]),
    )
  }
  const byId = (id: number) => games.find((game) => game.id === id)!
  return {
    harness,
    games,
    refs,
    byId,
    psOffer: (id) => byId(id).offers?.find((offer) => offer.store === STORE),
    run: (verdict = BELIEVED) => refreshPlaystationOffers(harness.deps, games, refs, verdict),
    asked: (kind) =>
      harness.sonyRequests
        .filter((request) => request.kind === kind)
        .map((request) =>
          kind === 'price' ? Number(request.id) - 50_000 : Number(request.id.slice(4, 9)),
        ),
  }
}

/** `count` games numbered from `from`, each made by `spec`. */
const many = (count: number, spec: (id: number) => Omit<Spec, 'id'>, from = 1): Spec[] =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, ...spec(from + index) }))

/** Makes Sony answer about a game's concept that it has no default product. */
const unsold = (run: World, id: number) =>
  void (run.harness.sonyPrices[conceptOf(id)] = sonyPrice(conceptOf(id), null))

describe('refreshPlaystationOffers: which prices a run reads', () => {
  it('asks first about a game never read, then about the one read longest ago', async () => {
    const run = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, readAgo: 50 * HOUR },
      { id: 3 },
      { id: 4, readAgo: 21 * HOUR },
      { id: 5 },
      { id: 6, readAgo: 72 * HOUR },
    ])

    const report = await run.run()

    // The two never read, the more popular of them first; then by the age of the read.
    expect(run.asked('price')).toEqual([3, 5, 6, 2, 1, 4])
    expect(report).toMatchObject({ status: 'read', due: 6, pricesRead: 6, requests: 6 })
  })

  it('does not ask about a game read in the last twenty hours', async () => {
    const run = world([
      { id: 1, readAgo: 6 * HOUR },
      { id: 2, readAgo: PLAYSTATION_REREAD_AFTER_MS - 1 },
      { id: 3, readAgo: PLAYSTATION_REREAD_AFTER_MS },
      { id: 4, readAgo: 26 * HOUR },
    ])

    const report = await run.run()

    expect(PLAYSTATION_REREAD_AFTER_MS).toBe(20 * HOUR)
    expect(run.asked('price')).toEqual([4, 3])
    expect(report).toMatchObject({ due: 2, pricesRead: 2, stopped: null })
    // What was not asked about is exactly as it was, date and all.
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(6 * HOUR)))
    expect(run.psOffer(2)).toEqual(offerOf(2, ago(PLAYSTATION_REREAD_AFTER_MS - 1)))
  })

  it('asks nobody anything when every game was read today', async () => {
    const run = world(many(30, () => ({ readAgo: 3 * HOUR })))

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'read', due: 0, requests: 0, stopped: null, offers: 30 })
  })

  it('counts an answer of "no price" as a read, so the game is asked about once a day too', async () => {
    const run = world([
      { id: 1, unpricedAgo: 5 * HOUR },
      { id: 2, unpricedAgo: 21 * HOUR },
      // An old offer the floor would not let go, and a newer answer that there is no price.
      { id: 3, readAgo: 60 * HOUR, unpricedAgo: 2 * HOUR },
      { id: 4, readAgo: 2 * HOUR, unpricedAgo: 60 * HOUR },
    ])

    await run.run()

    expect(run.asked('price')).toEqual([2])
  })

  it('asks about a game whose dates cannot be read, or lie ahead, as one never read', async () => {
    const run = world([{ id: 1, readAgo: 30 * HOUR }, { id: 2 }, { id: 3 }])
    run.byId(2).offers = [offerOf(2, 'the day before yesterday')]
    run.byId(3).offers = [offerOf(3, iso(STARTED + 5 * HOUR))]

    await run.run()

    expect(run.asked('price')).toEqual([2, 3, 1])
  })

  it('asks about a game once in a run, even when its request fails', async () => {
    const run = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, readAgo: 25 * HOUR },
    ])
    run.harness.sonyAnswersWith({ status: 500 })

    const report = await run.run()

    expect(run.asked('price')).toEqual([1, 2])
    expect(report).toMatchObject({ pricesRead: 1, failed: 1, requests: 2 })
    // The one that failed is as it was, so the next run finds it the oldest and asks first.
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))
  })
})

describe('refreshPlaystationOffers: what an answer does to an offer', () => {
  it('gives a priced game today’s offer: the product, its price, the end of its sale', async () => {
    const run = world([{ id: 1 }, { id: 2, readAgo: 30 * HOUR }])
    run.harness.sonyPrices[conceptOf(1)] = sonyPrice(
      conceptOf(1),
      sonyProduct(conceptOf(1), productOf(1), 'Game 1: Deluxe Edition', [
        sonyTrial(),
        sonyPurchase(79_900, 39_950, { endTime: JOB_PLAYSTATION_SALE_ENDS }),
        sonyPlusCatalogue(79_900),
      ]),
    )

    const report = await run.run()

    expect(run.byId(1).offers).toEqual([
      {
        store: STORE,
        title: 'Game 1: Deluxe Edition',
        amount: 39_950,
        regularAmount: 79_900,
        discountPercent: 50,
        currency: 'UAH',
        url: urlOf(1),
        updatedAt: START,
        saleEndsAt: JOB_PLAYSTATION_SALE_ENDS_AT,
      },
    ])
    // The second was answered ten seconds later, and is dated then. No sale, so no end of one.
    expect(run.psOffer(2)).toEqual(offerOf(2, iso(STARTED + PLAYSTATION_PAUSE_MS)))
    expect('saleEndsAt' in run.psOffer(2)!).toBe(false)
    expect(report).toMatchObject({ pricesRead: 2, removed: 0, offers: 2 })
  })

  it('publishes a free game as an offer of nothing, and a product with no name without a title', async () => {
    const run = world([{ id: 1 }, { id: 2 }])
    run.harness.sonyPrices[conceptOf(1)] = sonyPrice(
      conceptOf(1),
      sonyProduct(conceptOf(1), productOf(1), 'Game 1', [sonyFreeDownload()]),
    )
    run.harness.sonyPrices[conceptOf(2)] = sonyPrice(
      conceptOf(2),
      sonyProduct(conceptOf(2), productOf(2), '™', [sonyPurchase(49_900)]),
    )

    await run.run()

    expect(run.psOffer(1)).toMatchObject({ amount: 0, regularAmount: 0, discountPercent: 0 })
    expect(run.psOffer(2)).toMatchObject({ amount: 49_900 })
    expect('title' in run.psOffer(2)!).toBe(false)
  })

  it('leaves the game’s other offers and its Steam price alone', async () => {
    const run = world([{ id: 1, readAgo: 30 * HOUR }])
    const gog: IndexedOffer = {
      store: 'gog',
      amount: 999,
      regularAmount: 1999,
      currency: 'USD',
      discountPercent: 50,
      url: 'https://www.gog.com/en/game/game_1',
      updatedAt: ago(3 * HOUR),
    }
    run.byId(1).offers = [gog, offerOf(1, ago(30 * HOUR))]

    await run.run()

    expect(run.byId(1).offers).toEqual([gog, offerOf(1, START)])
    expect(run.byId(1)).toMatchObject({ priceUah: 499, priceUpdatedAt: START })
  })

  it('removes the offer of a game Sony answers about with no price, and remembers the day', async () => {
    const run = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, readAgo: 29 * HOUR },
      { id: 3, readAgo: 28 * HOUR },
      { id: 4 },
    ])
    // No default product; only a subscriber's entry; a concept the store no longer has.
    unsold(run, 1)
    run.harness.sonyPrices[conceptOf(2)] = sonyPrice(
      conceptOf(2),
      sonyProduct(conceptOf(2), productOf(2), 'Game 2', [sonyPlusCatalogue(49_900)]),
    )
    run.harness.sonyPrices[conceptOf(3)] = sonyNotInTheStore(conceptOf(3))
    // And a game that never had an offer: nothing to remove, and the day is remembered all the same.
    unsold(run, 4)

    const report = await run.run()

    for (const id of [1, 2, 3, 4]) expect('offers' in run.byId(id), String(id)).toBe(false)
    expect(report).toMatchObject({
      status: 'read',
      pricesRead: 0,
      removed: 3,
      failed: 0,
      offers: 0,
    })
    // Asked in the order 4, 1, 2, 3, ten seconds apart: each is stamped with its own answer.
    const stamped = await run.harness.writer.getStoreRefs([1, 2, 3, 4])
    expect(stamped.get(4)).toEqual({
      playstation: { titleId: titleOf(4), conceptId: conceptOf(4), unpricedAt: START },
    })
    expect(stamped.get(1)?.playstation?.unpricedAt).toBe(iso(STARTED + 10_000))
    expect(stamped.get(3)?.playstation?.unpricedAt).toBe(iso(STARTED + 30_000))
    // And the run's own map says the same, for whoever counts after the stage.
    expect(run.refs.get(1)).toEqual(stamped.get(1))
  })

  it('keeps everything else of a game’s reference when it stamps it', async () => {
    const run = world([{ id: 1 }])
    const record: IndexedStoreRefs = {
      gog: 'game_1',
      microsoft: null,
      playstation: { titleId: titleOf(1), conceptId: conceptOf(1) },
    }
    run.refs.set(1, record)
    unsold(run, 1)

    await run.run()

    expect((await run.harness.writer.getStoreRefs([1])).get(1)).toEqual({
      gog: 'game_1',
      microsoft: null,
      playstation: { titleId: titleOf(1), conceptId: conceptOf(1), unpricedAt: START },
    })
  })

  it.each([
    ['a 500', { status: 500 }],
    ['an answer with errors', { status: 200, body: { errors: [{ message: 'x' }], data: null } }],
    ['an answer about another concept', { status: 200, body: sonyPrice(1, null) }],
    [
      'a default product that has lost its fields',
      {
        status: 200,
        body: { data: { conceptRetrieve: { id: String(conceptOf(1)), defaultProduct: {} } } },
      },
    ],
  ])('keeps the offer and its date when the request meets %s', async (_what, response) => {
    const run = world([{ id: 1, readAgo: 30 * HOUR }])
    run.harness.sonyAnswersWith(response)

    const report = await run.run()

    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))
    expect(report).toMatchObject({
      status: 'read',
      pricesRead: 0,
      removed: 0,
      failed: 1,
      offers: 1,
    })
    // Nothing is remembered about a request that failed: the game is still the oldest next time.
    expect(await run.harness.writer.getStoreRefs([1])).toEqual(new Map())
  })

  it('says of a failure only what this job wrote, on one line', async () => {
    const run = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, readAgo: 29 * HOUR },
    ])
    run.harness.sonyAnswersWith({ status: 500, body: { message: 'x\n::error::injected' } })
    run.harness.sonyAnswersWith({
      status: 200,
      body: { errors: [{ message: 'y\n::warning::injected' }] },
    })

    await run.run()

    const lines = run.harness.logs.filter((line) => line.includes('could not be read'))
    expect(lines).toEqual([
      'playstation: the price of concept 50001 could not be read, leaving its game as it was: PLAYSTATION upstream failure: ERROR (500)',
      'playstation: the price of concept 50002 could not be read, leaving its game as it was: Sony answered about a price with errors',
    ])
    expect(run.harness.logs.join('\n')).not.toContain('injected')
  })
})

describe('refreshPlaystationOffers: mapping titles to concepts', () => {
  it('asks about the titles after the prices, and remembers what Sony said for good', async () => {
    const run = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, mapped: false },
      { id: 3, mapped: false },
      { id: 4, mapped: null },
    ])
    // Sony has no concept for the third title.
    run.harness.sonyConcepts[titleOf(3)] = sonyNoConcept(titleOf(3))

    const report = await run.run()

    expect(run.harness.sonyRequests.map((request) => request.kind)).toEqual([
      'price',
      'concept',
      'concept',
    ])
    // A title Sony was already asked about and has no concept for is never asked about again.
    expect(run.asked('concept')).toEqual([2, 3])
    expect(await run.harness.writer.getStoreRefs([1, 2, 3, 4])).toEqual(
      new Map([
        [2, { playstation: { titleId: titleOf(2), conceptId: conceptOf(2) } }],
        [3, { playstation: { titleId: titleOf(3), conceptId: null } }],
      ]),
    )
    expect(run.refs.get(2)).toEqual({
      playstation: { titleId: titleOf(2), conceptId: conceptOf(2) },
    })
    expect(report).toMatchObject({
      references: 4,
      mapped: 2,
      unmapped: 0,
      mappingsRead: 2,
      pricesRead: 1,
      requests: 3,
    })
    // A game mapped by this run is priced by the next: prices come first, and it had none.
    expect('offers' in run.byId(2)).toBe(false)
  })

  it('prices in the next run what this one mapped, as a game never read', async () => {
    const first = world([
      { id: 1, readAgo: 30 * HOUR },
      { id: 2, mapped: false },
    ])
    await first.run()

    const next = createJobHarness({ start: iso(STARTED + 6 * HOUR), writer: first.harness.writer })
    next.sonyPrices[conceptOf(2)] = first.harness.sonyPrices[conceptOf(2)]
    const report = await refreshPlaystationOffers(next.deps, first.games, first.refs, BELIEVED)

    // The game priced six hours ago is not asked about; the newly mapped one is.
    expect(next.sonyRequests.map((request) => `${request.kind} ${request.id}`)).toEqual([
      `price ${conceptOf(2)}`,
    ])
    expect(report).toMatchObject({ due: 1, pricesRead: 1, mappingsRead: 0, mapped: 2 })
    expect(first.psOffer(2)).toEqual(offerOf(2, iso(STARTED + 6 * HOUR)))
  })

  it('maps at most sixty titles a run, the most popular first', async () => {
    const run = world(many(100, (id) => ({ mapped: false, popularity: id })))

    const report = await run.run()

    expect(PLAYSTATION_MAPPINGS_PER_RUN).toBe(60)
    // No price is due, and the run still spends sixty requests and no more of its 225.
    expect(run.asked('concept')).toEqual(Array.from({ length: 60 }, (_, index) => 100 - index))
    expect(report).toMatchObject({
      mappingsRead: 60,
      mapped: 60,
      unmapped: 40,
      requests: 60,
      // Sixty a run is the design, not a stage cut short.
      stopped: null,
    })
  })

  it('counts a title whose request failed in the sixty, and asks about it again another run', async () => {
    const run = world(many(70, () => ({ mapped: false })))
    // Every fourth request fails: no three in a row do.
    run.harness.sonyAnswersWith(
      { status: 502 },
      { times: Infinity, match: (request) => Number(request.id.slice(4, 9)) % 4 === 0 },
    )

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(60)
    expect(report).toMatchObject({ mappingsRead: 45, failed: 15, mapped: 45, unmapped: 25 })
    // A failure writes nothing, least of all "no concept": that would be for good.
    expect((await run.harness.writer.getStoreRefs([4])).has(4)).toBe(false)
    expect(run.refs.get(4)).toEqual({ playstation: { titleId: titleOf(4) } })
  })

  it('maps only with what the prices left of the run’s requests', async () => {
    const run = world([
      ...many(200, () => ({ readAgo: 30 * HOUR })),
      ...many(100, () => ({ mapped: false }), 1_001),
    ])

    const report = await run.run()

    expect(run.asked('price')).toHaveLength(200)
    expect(run.asked('concept')).toHaveLength(25)
    expect(report).toMatchObject({
      pricesRead: 200,
      mappingsRead: 25,
      requests: PLAYSTATION_REQUESTS_PER_RUN,
      stopped: { reason: 'requests' },
    })
  })

  it('maps nothing in a run whose prices took every request', async () => {
    const run = world([
      ...many(300, () => ({ readAgo: 30 * HOUR })),
      ...many(10, () => ({ mapped: false }), 1_001),
    ])

    const report = await run.run()

    expect(run.asked('price')).toHaveLength(PLAYSTATION_REQUESTS_PER_RUN)
    expect(run.asked('concept')).toHaveLength(0)
    expect(report).toMatchObject({ due: 300, pricesRead: 225, mappingsRead: 0, unmapped: 10 })
  })

  it('writes what it learns ten games at a time, and what is left when it ends', async () => {
    const run = world(many(25, () => ({ mapped: false })))
    const setStoreRefs = vi.spyOn(run.harness.writer, 'setStoreRefs')

    await run.run()

    expect(PLAYSTATION_REF_BATCH_SIZE).toBe(10)
    expect(setStoreRefs.mock.calls.map(([entries]) => [...entries].length)).toEqual([10, 10, 5])
  })
})

describe('refreshPlaystationOffers: how a run ends', () => {
  it('stops at the run’s 225 requests, and leaves the rest as it was for the next run', async () => {
    const run = world(many(240, (id) => ({ readAgo: (500 - id) * HOUR })))

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(PLAYSTATION_REQUESTS_PER_RUN)
    expect(report).toMatchObject({
      status: 'read',
      due: 240,
      pricesRead: 225,
      requests: 225,
      stopped: { reason: 'requests' },
      offers: 240,
    })
    // The fifteen read most recently were not reached.
    expect(run.psOffer(226)).toEqual(offerOf(226, ago((500 - 226) * HOUR)))
    // Running out of the ration is the design: nobody is warned of it.
    expect(playstationWarnings(report)).toEqual([])
  })

  it('never asks faster than a request every ten seconds, through the whole stage', async () => {
    const run = world([
      ...many(40, () => ({ readAgo: 30 * HOUR })),
      ...many(20, () => ({ mapped: false }), 1_001),
    ])
    run.harness.sonyState.latencyMs = 400

    await run.run()

    const left = run.harness.sonyRequests.map((request) => request.at)
    expect(left).toHaveLength(60)
    const gaps = left.slice(1).map((at, index) => at - left[index]!)
    // Ten seconds from the end of one request to the start of the next, both kinds alike.
    expect(new Set(gaps)).toEqual(new Set([PLAYSTATION_PAUSE_MS + 400]))
  })

  it('stops at forty minutes when Sony is slow, with games still waiting', async () => {
    const run = world(many(225, () => ({ readAgo: 30 * HOUR })))
    run.harness.sonyState.latencyMs = 5_000

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(160)
    expect(run.harness.clock.now() - STARTED).toBeLessThanOrEqual(PLAYSTATION_BUDGET_MS)
    expect(report).toMatchObject({ pricesRead: 160, stopped: { reason: 'time' } })
    expect(playstationWarnings(report)).toEqual([])
  })

  it.each([
    ['a 403', { status: 403 }, 'HTTP 403'],
    ['a 429', { status: 429 }, 'HTTP 429'],
    ['a challenge page', { status: 200, html: true }, 'a page instead of data'],
  ])(
    'stops at %s, asks nothing more, and says so in a warning',
    async (_what, response, detail) => {
      const run = world([
        ...many(10, (id) => ({ readAgo: (100 - id) * HOUR })),
        ...many(5, () => ({ mapped: false }), 1_001),
      ])
      run.harness.sonyAnswersWith(response, { match: (request) => request.id === '50004' })

      const report = await run.run()

      // Three answered, the fourth refused, and nothing after it: no price, and no mapping either.
      expect(run.asked('price')).toEqual([1, 2, 3, 4])
      expect(run.asked('concept')).toEqual([])
      expect(report).toMatchObject({
        status: 'read',
        pricesRead: 3,
        failed: 1,
        requests: 4,
        stopped: { reason: 'refused', detail },
      })
      // The game that was refused and the games never reached are as they were.
      for (const id of [4, 5, 10])
        expect(run.psOffer(id)).toEqual(offerOf(id, ago((100 - id) * HOUR)))
      expect(playstationWarnings(report)).toEqual([
        `PlayStation Store prices: Sony refused a request (${detail}), so nothing more was asked in this run, after 4 requests — every offer that was not read stands as it was`,
      ])
    },
  )

  it('warns of a refusal that came with the last question of the run, too', async () => {
    const run = world([{ id: 1, readAgo: 30 * HOUR }])
    run.harness.sonyAnswersWith({ status: 403 })

    const report = await run.run()

    expect(report.stopped).toEqual({ reason: 'refused', detail: 'HTTP 403' })
    expect(playstationWarnings(report)).toHaveLength(1)
  })

  it('stops at three failures in a row, and says so in a warning', async () => {
    const run = world(many(10, (id) => ({ readAgo: (100 - id) * HOUR })))
    run.harness.sonyAnswersWith({ status: 500 }, { times: Infinity })

    const report = await run.run()

    expect(run.asked('price')).toEqual([1, 2, 3])
    expect(report).toMatchObject({
      pricesRead: 0,
      failed: 3,
      requests: 3,
      stopped: { reason: 'failures', detail: '3 requests in a row failed' },
      offers: 10,
    })
    expect(playstationWarnings(report)).toEqual([
      'PlayStation Store prices: 3 requests in a row failed, so nothing more was asked in this run, after 3 requests — every offer that was not read stands as it was',
    ])
  })

  it('does not stop at failures that are not in a row', async () => {
    const run = world(many(9, (id) => ({ readAgo: (100 - id) * HOUR })))
    run.harness.sonyAnswersWith(
      { status: 500 },
      { times: Infinity, match: (request) => Number(request.id) % 3 !== 0 },
    )

    const report = await run.run()

    expect(run.asked('price')).toHaveLength(9)
    expect(report).toMatchObject({ pricesRead: 3, failed: 6, stopped: null })
    expect(playstationWarnings(report)).toEqual([])
  })
})

describe('refreshPlaystationOffers: the floor under a run’s removals', () => {
  /** `count` games carrying an offer, the first `unsoldCount` of which Sony no longer prices. */
  function carrying(count: number, unsoldCount: number): World {
    const run = world(many(count, (id) => ({ readAgo: (500 - id) * HOUR })))
    for (let id = 1; id <= unsoldCount; id += 1) unsold(run, id)
    return run
  }

  it('removes no offer when more than half of twenty answers would remove one', async () => {
    const run = carrying(20, 11)

    const report = await run.run()

    const reason =
      'asked about 20 games that carried an offer and 11 of the answers would remove it: over half, so the answers are not believed and no offer is removed'
    expect(report).toMatchObject({
      status: 'failed',
      pricesRead: 9,
      removed: 0,
      failed: 0,
      offers: 20,
      error: reason,
    })
    // The eleven keep the offer they had, under its old date.
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(499 * HOUR)))
    expect(run.psOffer(11)).toEqual(offerOf(11, ago(489 * HOUR)))
    // The nine that were priced are today's: only the removals are held back.
    expect(run.psOffer(12)?.updatedAt).toBe(iso(STARTED + 11 * PLAYSTATION_PAUSE_MS))
    expect(playstationWarnings(report)).toEqual([
      `PlayStation Store prices: ${reason} — the prices that were read are published`,
    ])
  })

  it('removes them when exactly half would go, and when fewer than twenty were asked about', async () => {
    const half = carrying(20, 10)
    expect(await half.run()).toMatchObject({ status: 'read', removed: 10, offers: 10 })
    expect('offers' in half.byId(1)).toBe(false)

    const few = carrying(19, 19)
    expect(await few.run()).toMatchObject({ status: 'read', removed: 19, offers: 0 })

    expect(OFFER_FLOOR_MIN_CARRIED).toBe(20)
    expect(removalsNotBelieved(20, 10)).toBeNull()
    expect(removalsNotBelieved(20, 11)).not.toBeNull()
    expect(removalsNotBelieved(19, 19)).toBeNull()
    expect(removalsNotBelieved(225, 113)).not.toBeNull()
    expect(removalsNotBelieved(225, 112)).toBeNull()
  })

  it('weighs only the games that carried an offer, and only those that were answered about', async () => {
    // Thirty games never priced, none of which Sony prices now: nothing to remove, so no floor.
    const fresh = world(many(30, () => ({})))
    for (let id = 1; id <= 30; id += 1) unsold(fresh, id)
    expect(await fresh.run()).toMatchObject({ status: 'read', removed: 0, pricesRead: 0 })

    // Twenty-five carried: eleven unsold, nine priced, and five whose requests failed. Twenty
    // were answered about, and eleven of twenty is over half.
    const run = carrying(25, 11)
    run.harness.sonyAnswersWith(
      { status: 500 },
      {
        times: Infinity,
        match: (request) => [13, 16, 19, 22, 25].includes(Number(request.id) - 50_000),
      },
    )
    expect(await run.run()).toMatchObject({ status: 'failed', failed: 5, removed: 0, offers: 25 })
  })

  it('asks about a game whose removal was not believed a day later, not with the next run', async () => {
    const run = carrying(20, 11)
    await run.run()
    const stamped = await run.harness.writer.getStoreRefs([1])
    expect(stamped.get(1)?.playstation?.unpricedAt).toBe(START)

    const next = createJobHarness({ start: iso(STARTED + 6 * HOUR), writer: run.harness.writer })
    const report = await refreshPlaystationOffers(next.deps, run.games, run.refs, BELIEVED)

    // Six hours on nothing is due: the nine were priced, and the eleven were answered about.
    expect(next.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'read', due: 0, offers: 20 })
  })
})

describe('refreshPlaystationOffers: the mapping it is handed', () => {
  it('asks nothing and reports no references when no game has a PlayStation title', async () => {
    const run = world([])
    run.games.push(document({ id: 1 }))
    run.refs.set(1, { gog: 'game_1', playstation: null })

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'no-references', references: 0, requests: 0 })
    expect(playstationWarnings(report)).toEqual([])
  })

  it('asks nothing while the references look lost, and says so in a warning', async () => {
    const run = world(many(5, () => ({ readAgo: 30 * HOUR })))
    const lost =
      'carried 400, the mapping names a product for 5 of those games: under half, so the store references look lost'

    const report = await run.run({ lost, dropped: 0 })

    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'references-lost', error: lost, requests: 0, offers: 5 })
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))
    expect(playstationWarnings(report)).toEqual([
      `PlayStation Store prices not refreshed: ${lost} — every offer is kept as it was and Sony was not asked`,
    ])
  })

  it('reports what a believed mapping cost the store, and warns from twenty offers up', async () => {
    const run = world([{ id: 1, readAgo: 3 * HOUR }])

    expect((await run.run({ lost: null, dropped: 19 })).dropped).toBe(19)
    expect(playstationWarnings(await run.run({ lost: null, dropped: 19 }))).toEqual([])
    expect(playstationWarnings(await run.run({ lost: null, dropped: 20 }))).toEqual([
      'PlayStation Store: 20 offers dropped because their games no longer have a store reference',
    ])
    expect('dropped' in (await run.run())).toBe(false)
  })

  it('takes nothing of a reference on trust', async () => {
    const run = world([{ id: 1 }, { id: 2 }, { id: 3 }])
    run.refs.set(1, { playstation: { titleId: 'NPUB31077_00', conceptId: 7 } })
    run.refs.set(2, { playstation: { titleId: titleOf(2), conceptId: '50002' } } as never)

    const report = await run.run()

    // A title that is not one is no reference; a concept that is not one reads as not asked yet.
    expect(report).toMatchObject({ references: 2, mapped: 2, pricesRead: 1, mappingsRead: 1 })
    expect(run.harness.sonyRequests.map((request) => `${request.kind} ${request.id}`)).toEqual([
      'price 50003',
      `concept ${titleOf(2)}`,
    ])
  })
})

/**
 * "An offer needs a reference" is one rule for every store, kept by the stage before this one
 * (`refreshOffers`); its verdict on this store is what this stage is handed.
 */
describe('refreshOffers and the PlayStation Store’s offers', () => {
  it('drops the offer of a game with no PlayStation title, and counts it', async () => {
    const run = world(many(3, () => ({ readAgo: 3 * HOUR })))
    run.refs.set(2, { playstation: null })
    run.refs.delete(3)

    const result = await refreshOffers(run.harness.deps, run.games, run.refs, null)

    expect(result.playstation).toEqual({ lost: null, dropped: 2 })
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(3 * HOUR)))
    expect('offers' in run.byId(2)).toBe(false)
    expect('offers' in run.byId(3)).toBe(false)
    // The store has no stamp of its own: it is never read in full.
    expect(result.offersReadAt).toEqual({})
    // And GOG and the Microsoft Store are not asked about games that are not theirs.
    expect(run.harness.gogPages).toHaveLength(0)
  })

  it('keeps every offer, and says the references look lost, when the mapping forgot most games', async () => {
    const run = world(many(20, () => ({ readAgo: 3 * HOUR })))
    for (let id = 1; id <= 11; id += 1) run.refs.delete(id)

    const result = await refreshOffers(run.harness.deps, run.games, run.refs, null)

    expect(result.playstation).toEqual({
      lost: 'carried 20, the mapping names a product for 9 of those games: under half, so the store references look lost',
      dropped: 0,
    })
    for (const game of run.games) expect(game.offers).toHaveLength(1)

    // And the stage that reads the store asks nothing on the strength of such a mapping.
    const report = await run.run(result.playstation)
    expect(report).toMatchObject({ status: 'references-lost', offers: 20, requests: 0 })
    expect(run.harness.sonyRequests).toHaveLength(0)
  })

  it('counts a title Sony has not been asked about yet as a reference', async () => {
    const run = world([{ id: 1, readAgo: 3 * HOUR, mapped: false }])

    const result = await refreshOffers(run.harness.deps, run.games, run.refs, null)

    expect(result.playstation).toEqual({ lost: null, dropped: 0 })
    expect(run.psOffer(1)).toBeDefined()
  })
})

describe('refreshPlaystationOffers and the writer’s lock', () => {
  it('gives the lock a sign of life after every request, through forty minutes of them', async () => {
    const run = world(many(230, () => ({ readAgo: 30 * HOUR })))
    const renewLock = vi.spyOn(run.harness.writer, 'renewLock')

    await run.run()

    expect(run.harness.clock.now() - STARTED).toBeGreaterThan(30 * MINUTE)
    expect(renewLock).toHaveBeenCalledTimes(PLAYSTATION_REQUESTS_PER_RUN)
  })

  it('renews after a request that failed as after one that was answered', async () => {
    const run = world(many(4, () => ({ readAgo: 30 * HOUR })))
    run.harness.sonyAnswersWith({ status: 500 }, { times: 2 })
    const renewLock = vi.spyOn(run.harness.writer, 'renewLock')

    await run.run()

    expect(renewLock).toHaveBeenCalledTimes(4)
  })

  it('stops asking Sony for a run whose lock will not renew, and fails as the index’s failure', async () => {
    const run = world([
      ...many(10, () => ({ readAgo: 30 * HOUR })),
      ...many(3, () => ({ mapped: false }), 1_001),
    ])
    unsold(run, 1)
    let renewals = 0
    vi.spyOn(run.harness.writer, 'renewLock').mockImplementation(async () => {
      renewals += 1
      if (renewals === 2) throw new Error('the index is unreachable')
    })

    await expect(run.run()).rejects.toThrow('the index is unreachable')

    // Two requests were made before the lock was known lost, and none after.
    expect(run.harness.sonyRequests).toHaveLength(2)
    // What Sony had said by then was kept all the same: it cost a request.
    expect((await run.harness.writer.getStoreRefs([1])).get(1)?.playstation?.unpricedAt).toBe(START)
  })
})
