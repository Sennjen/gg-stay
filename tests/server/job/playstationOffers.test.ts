import { describe, expect, it, vi } from 'vitest'
import { OFFER_FLOOR_MIN_CARRIED, refreshOffers } from '../../../scripts/index/offers'
import {
  PLAYSTATION_BUDGET_MS,
  PLAYSTATION_PAUSE_MS,
  PLAYSTATION_REQUESTS_PER_RUN,
} from '../../../scripts/index/playstation'
import {
  noConceptNotBelieved,
  nothingPriced,
  PLAYSTATION_MAPPINGS_PER_RUN,
  PLAYSTATION_NO_CONCEPT_KEPT_MS,
  PLAYSTATION_REREAD_AFTER_MS,
  refreshPlaystationOffers,
  removalsNotBelieved,
  type PlaystationAsks,
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
 * what an answer does to an offer, what is remembered of the asking, and how the stage ends. The
 * transport under it is the real one, on the fake clock (`harness.ts`), so "a request" below is a
 * request the transport let out.
 */

const START = '2026-10-13T06:15:00.000Z'
const STARTED = Date.parse(START)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STORE = 'playstation-store'
const BELIEVED = { lost: null, dropped: 0 }

const iso = (at: number) => new Date(at).toISOString()
const ago = (ms: number) => iso(STARTED - ms)
/** The moment the `n`th request of a stage that began at `START` left, counted from nought. */
const leftAt = (n: number) => iso(STARTED + n * PLAYSTATION_PAUSE_MS)
/**
 * The date the game of the `n`th request is stamped with: written before the request leaves, so
 * while the pause before it is still to be waited out.
 */
const stampedAt = (n: number) => leftAt(Math.max(0, n - 1))

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
  /** `false` for a title Sony has not answered about, `null` for one it has no concept for. */
  mapped?: boolean | null
  /** How long before the run Sony was last asked about the game; never when left out. */
  askedAgo?: number
  /** How long before the run the offer on the game's document was read; no offer when left out. */
  readAgo?: number
  popularity?: number
  /** The game whose concept and product this one shares; its own when left out. */
  conceptOf?: number
  /** The game whose title this one's link names too; its own when left out. */
  titleOf?: number
}

interface World {
  harness: JobHarness
  games: IndexedGame[]
  refs: StoreRefMap
  byId: (id: number) => IndexedGame
  psOffer: (id: number) => IndexedOffer | undefined
  run: (
    asks?: PlaystationAsks,
    options?: { verdict?: { lost: string | null; dropped: number }; refusal?: string | null },
  ) => Promise<PlaystationReport>
  /** The games asked about, in order, by the kind of question. */
  asked: (kind: 'price' | 'concept') => number[]
  /** What the permanent mapping says of a game's PlayStation title after the run. */
  stored: (id: number) => Promise<IndexedStoreRefs['playstation']>
}

function document(spec: Spec): IndexedGame {
  const product = spec.conceptOf ?? spec.id
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
    ...(spec.readAgo === undefined ? {} : { offers: [offerOf(product, ago(spec.readAgo))] }),
  }
}

/**
 * A run's games as the stage finds them, and a Sony that knows every one of them: each title in
 * a concept of its own unless the game shares another's, each concept with a product at 499,00 ₴.
 */
function world(specs: Spec[], start = START): World {
  const harness = createJobHarness({ start })
  const games = specs.map(document)
  const refs: StoreRefMap = new Map()
  for (const spec of specs) {
    const title = titleOf(spec.titleOf ?? spec.id)
    const concept = spec.conceptOf ?? spec.id
    refs.set(spec.id, {
      playstation: {
        titleId: title,
        ...(spec.mapped === false
          ? {}
          : { conceptId: spec.mapped === null ? null : conceptOf(concept) }),
        ...(spec.askedAgo === undefined ? {} : { askedAt: ago(spec.askedAgo) }),
      },
    })
    harness.sonyConcepts[title] = sonyConcept(conceptOf(concept), [title])
    harness.sonyPrices[conceptOf(concept)] = sonyPrice(
      conceptOf(concept),
      sonyProduct(conceptOf(concept), productOf(concept), `Game ${concept}`, [
        sonyPurchase(49_900),
      ]),
    )
  }
  const byId = (id: number) => games.find((game) => game.id === id)!
  return {
    harness,
    games,
    refs,
    byId,
    psOffer: (id) => byId(id).offers?.find((offer) => offer.store === STORE),
    run: (asks = 'prices', options = {}) =>
      refreshPlaystationOffers(harness.deps, games, refs, options.verdict ?? BELIEVED, {
        asks,
        refusal: options.refusal ?? null,
      }),
    asked: (kind) =>
      harness.sonyRequests
        .filter((request) => request.kind === kind)
        .map((request) =>
          kind === 'price' ? Number(request.id) - 50_000 : Number(request.id.slice(4, 9)),
        ),
    stored: async (id) => (await harness.writer.getStoreRefs([id])).get(id)?.playstation,
  }
}

/** `count` games numbered from `from`, each made by `spec`. */
const many = (count: number, spec: (id: number) => Omit<Spec, 'id'>, from = 1): Spec[] =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, ...spec(from + index) }))

/** A game asked about, and its offer read, this long before the run: one whose price is due. */
const read = (age: number): Omit<Spec, 'id'> => ({ askedAgo: age, readAgo: age })

/** Makes Sony answer about a game's concept that it has no default product. */
const unsold = (run: World, id: number) =>
  void (run.harness.sonyPrices[conceptOf(id)] = sonyPrice(conceptOf(id), null))

/** The same games and mapping, seen by a later run on the same index. */
function later(run: World, at: number, asks: PlaystationAsks = 'prices') {
  const next = createJobHarness({ start: iso(at), writer: run.harness.writer })
  Object.assign(next.sonyPrices, run.harness.sonyPrices)
  Object.assign(next.sonyConcepts, run.harness.sonyConcepts)
  return {
    harness: next,
    run: () => refreshPlaystationOffers(next.deps, run.games, run.refs, BELIEVED, { asks }),
    sent: () => next.sonyRequests.map((request) => `${request.kind} ${request.id}`),
  }
}

describe('a prices run: which prices it reads', () => {
  it('asks first about a game never asked about, then about the one asked longest ago', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, ...read(50 * HOUR) },
      { id: 3 },
      { id: 4, ...read(21 * HOUR) },
      { id: 5 },
      { id: 6, ...read(72 * HOUR) },
    ])

    const report = await run.run()

    // The two never asked about, the more popular of them first; then by the age of the asking.
    expect(run.asked('price')).toEqual([3, 5, 6, 2, 1, 4])
    expect(report).toMatchObject({
      status: 'read',
      asks: 'prices',
      due: 6,
      pricesRead: 6,
      requests: 6,
    })
  })

  it('does not ask about a game asked about in the last twenty hours', async () => {
    const run = world([
      { id: 1, ...read(6 * HOUR) },
      { id: 2, ...read(PLAYSTATION_REREAD_AFTER_MS - 1) },
      { id: 3, ...read(PLAYSTATION_REREAD_AFTER_MS) },
      { id: 4, ...read(26 * HOUR) },
    ])

    const report = await run.run()

    expect(PLAYSTATION_REREAD_AFTER_MS).toBe(20 * HOUR)
    expect(run.asked('price')).toEqual([4, 3])
    expect(report).toMatchObject({ due: 2, pricesRead: 2, stopped: null })
    // What was not asked about is exactly as it was, date and all.
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(6 * HOUR)))
    expect(run.psOffer(2)).toEqual(offerOf(2, ago(PLAYSTATION_REREAD_AFTER_MS - 1)))
    expect(await run.stored(1)).toBeUndefined()
  })

  it('goes by the date of the asking, never by the date of the offer', async () => {
    const run = world([
      // An old offer, and Sony asked about it two hours ago: a run that did not publish, or an
      // answer that was not believed. Not asked again.
      { id: 1, askedAgo: 2 * HOUR, readAgo: 60 * HOUR },
      // No offer at all, and asked five hours ago: Sony said "no price", or the request failed.
      { id: 2, askedAgo: 5 * HOUR },
      // A fresh offer on the document and no date of any asking: asked, as one never asked.
      { id: 3, readAgo: 3 * HOUR },
      { id: 4, askedAgo: 21 * HOUR, readAgo: 2 * HOUR },
    ])

    await run.run()

    expect(run.asked('price')).toEqual([3, 4])
  })

  it('asks nobody anything when every game was asked about today', async () => {
    const run = world(many(30, () => read(3 * HOUR)))

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'read', due: 0, requests: 0, stopped: null, offers: 30 })
  })

  it('asks about a game whose date cannot be read as one never asked about', async () => {
    const run = world([{ id: 1, ...read(30 * HOUR) }, { id: 2 }, { id: 3 }])
    run.refs.set(2, {
      playstation: { titleId: titleOf(2), conceptId: conceptOf(2), askedAt: 'the day before' },
    })
    run.refs.set(3, {
      playstation: { titleId: titleOf(3), conceptId: conceptOf(3), askedAt: '2026-10-13T06:00:00' },
    })

    await run.run()

    expect(run.asked('price')).toEqual([2, 3, 1])
  })

  it('takes a date ahead of the clock for "just now", and writes it back as now', async () => {
    const run = world([{ id: 1, ...read(30 * HOUR) }, { id: 2 }])
    run.refs.set(2, {
      playstation: {
        titleId: titleOf(2),
        conceptId: conceptOf(2),
        askedAt: iso(STARTED + 5 * DAY),
      },
    })

    await run.run()

    // Not first in every run until its date passes, and not put off for five days either.
    expect(run.asked('price')).toEqual([1])
    expect(await run.stored(2)).toEqual({
      titleId: titleOf(2),
      conceptId: conceptOf(2),
      askedAt: START,
    })
    const day = later(run, STARTED + 21 * HOUR)
    await day.run()
    expect(day.sent()).toContain(`price ${conceptOf(2)}`)
  })
})

describe('a prices run: every request is stamped before it leaves', () => {
  it('writes the date of the asking to the permanent mapping, whatever comes of the request', async () => {
    const run = world([
      { id: 1, ...read(50 * HOUR) },
      { id: 2, ...read(40 * HOUR) },
      { id: 3, ...read(30 * HOUR) },
      { id: 4, ...read(25 * HOUR) },
      { id: 5, ...read(24 * HOUR) },
    ])
    // A price; no price; a failure; a refusal; and a game the stage never reaches.
    unsold(run, 2)
    run.harness.sonyAnswersWith({ status: 500 }, { match: (request) => request.id === '50003' })
    run.harness.sonyAnswersWith({ status: 403 }, { match: (request) => request.id === '50004' })

    const report = await run.run()

    expect(run.asked('price')).toEqual([1, 2, 3, 4])
    expect(report).toMatchObject({ pricesRead: 1, removed: 1, failed: 2, requests: 4 })
    for (const [index, id] of [1, 2, 3, 4].entries()) {
      expect(await run.stored(id), `game ${id}`).toEqual({
        titleId: titleOf(id),
        conceptId: conceptOf(id),
        askedAt: stampedAt(index),
      })
    }
    // Never asked, never stamped: it is still the oldest when the next run comes.
    expect(await run.stored(5)).toBeUndefined()
    expect(run.refs.get(5)).toEqual({
      playstation: { titleId: titleOf(5), conceptId: conceptOf(5), askedAt: ago(24 * HOUR) },
    })
    // And the run's own map says what the permanent one does.
    expect(run.refs.get(3)?.playstation).toEqual(await run.stored(3))
  })

  it('writes it before the request is sent, not after the answer', async () => {
    const run = world(many(3, () => read(30 * HOUR)))
    const events: string[] = []
    const setStoreRefs = run.harness.writer.setStoreRefs.bind(run.harness.writer)
    vi.spyOn(run.harness.writer, 'setStoreRefs').mockImplementation(async (entries) => {
      const written = [...entries]
      events.push(`stamp ${written.map(([id]) => id).join(',')}`)
      await setStoreRefs(written)
    })
    run.harness.sonyAnswersWith(
      {},
      { times: Infinity, match: (request) => (events.push(`ask ${request.id}`), false) },
    )

    await run.run()

    expect(events).toEqual(['stamp 1', 'ask 50001', 'stamp 2', 'ask 50002', 'stamp 3', 'ask 50003'])
  })

  it('sends nothing to Sony when the index will not take the date', async () => {
    const run = world(many(5, () => read(30 * HOUR)))
    vi.spyOn(run.harness.writer, 'setStoreRefs').mockRejectedValue(
      new Error('the index is unreachable'),
    )

    await expect(run.run()).rejects.toThrow('the index is unreachable')

    expect(run.harness.sonyRequests).toHaveLength(0)
  })

  it('does not ask again, six hours on, about a game whose request failed: a day on it does', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, ...read(25 * HOUR) },
    ])
    run.harness.sonyAnswersWith({ status: 500 })

    const report = await run.run()

    expect(run.asked('price')).toEqual([1, 2])
    expect(report).toMatchObject({ pricesRead: 1, failed: 1, requests: 2 })
    // The one that failed keeps the offer it had, under its old date.
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))

    // The next prices run: the old date on the offer would have had it asked about first.
    const soon = later(run, STARTED + 6 * HOUR)
    await soon.run()
    expect(soon.sent()).toEqual([])

    const day = later(run, STARTED + 20 * HOUR + PLAYSTATION_PAUSE_MS)
    await day.run()
    expect(day.sent()).toEqual([`price ${conceptOf(1)}`, `price ${conceptOf(2)}`])
  })

  it('keeps three games that fail every time in their places, instead of at the head of every run', async () => {
    // Twelve games, read a day apart from one another by an hour each; three of them answer with
    // an error whenever they are asked about.
    const run = world(many(12, (id) => read((40 - id) * HOUR)))
    const failing = (request: { id: string }) => [3, 7, 11].includes(Number(request.id) - 50_000)
    run.harness.sonyAnswersWith({ status: 500 }, { times: Infinity, match: failing })

    const first = await run.run()
    expect(first).toMatchObject({ pricesRead: 9, failed: 3, stopped: null })

    // A day on, and a day after that: the same three fail, and never three in a row.
    for (const days of [1, 2]) {
      const next = later(run, STARTED + days * (20 * HOUR + 5 * MINUTE))
      next.harness.sonyAnswersWith({ status: 500 }, { times: Infinity, match: failing })
      const report = await next.run()

      expect(next.harness.sonyRequests, `day ${days}`).toHaveLength(12)
      expect(report).toMatchObject({ pricesRead: 9, failed: 3, stopped: null })
      expect(playstationWarnings(report)).toEqual([])
    }
  })
})

describe('a prices run: what an answer does to an offer', () => {
  it('gives a priced game today’s offer: the product, its price, the end of its sale', async () => {
    const run = world([{ id: 1 }, { id: 2, ...read(30 * HOUR) }])
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
    expect(run.psOffer(2)).toEqual(offerOf(2, leftAt(1)))
    expect('saleEndsAt' in run.psOffer(2)!).toBe(false)
    expect(report).toMatchObject({ pricesRead: 2, removed: 0, offers: 2 })
  })

  it('reads a discount that is for an experiment’s buyers as the regular price', async () => {
    const run = world([{ id: 1, ...read(30 * HOUR) }])
    run.harness.sonyPrices[conceptOf(1)] = sonyPrice(
      conceptOf(1),
      sonyProduct(conceptOf(1), productOf(1), 'Game 1', [
        sonyPlusCatalogue(259_900),
        sonyPurchase(259_900, 64_975, {
          endTime: JOB_PLAYSTATION_SALE_ENDS,
          qualifications: [{ type: 'USER_IN_EXPERIMENT', value: 'CrossChannel.IPT_PILOT._.1.1' }],
        }),
      ]),
    )

    await run.run()

    // 2 599,00 ₴, no discount and no end of a sale: the offer stays, and promises nothing.
    expect(run.psOffer(1)).toEqual(
      offerOf(1, START, { amount: 259_900, regularAmount: 259_900, discountPercent: 0 }),
    )
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
    const run = world([{ id: 1, ...read(30 * HOUR) }])
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

  it('removes the offer of a game Sony answers about with no price', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, ...read(29 * HOUR) },
      { id: 3, ...read(28 * HOUR) },
      { id: 4 },
    ])
    // No default product; only a subscriber's entry; a concept the store no longer has.
    unsold(run, 1)
    run.harness.sonyPrices[conceptOf(2)] = sonyPrice(
      conceptOf(2),
      sonyProduct(conceptOf(2), productOf(2), 'Game 2', [sonyPlusCatalogue(49_900)]),
    )
    run.harness.sonyPrices[conceptOf(3)] = sonyNotInTheStore(conceptOf(3))
    // And a game that never had an offer: nothing to remove.
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
    // Each is asked about again in a day, and not before: the date of the asking says so.
    const soon = later(run, STARTED + 6 * HOUR)
    await soon.run()
    expect(soon.sent()).toEqual([])
  })

  it('keeps everything else of a game’s record when it stamps it', async () => {
    const run = world([{ id: 1 }])
    // A record with fields this job writes for other stores, and one it has never heard of.
    const record = {
      gog: 'game_1',
      microsoft: null,
      links: [{ store_id: 3, url: 'https://store.playstation.com/en-us/product/x' }],
      playstation: { titleId: titleOf(1), conceptId: conceptOf(1), productId: 'not this job’s' },
    }
    run.refs.set(1, record as never)

    await run.run()

    expect((await run.harness.writer.getStoreRefs([1])).get(1)).toEqual({
      gog: 'game_1',
      microsoft: null,
      links: record.links,
      // The store's own field is written as this job knows it, and no wider.
      playstation: { titleId: titleOf(1), conceptId: conceptOf(1), askedAt: START },
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
    [
      'a purchase that has lost a field',
      {
        status: 200,
        body: sonyPrice(
          conceptOf(1),
          sonyProduct(conceptOf(1), productOf(1), 'Game 1', [
            sonyPurchase(49_900, 49_900, { price: { isExclusive: undefined } }),
          ]),
        ),
      },
    ],
  ])('keeps the offer and its date when the request meets %s', async (_what, response) => {
    const run = world([{ id: 1, ...read(30 * HOUR) }])
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
  })

  it('says of a failure only what this job wrote, on one line', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, ...read(29 * HOUR) },
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

describe('a prices run: one concept is one request', () => {
  it('asks once about the games that share a concept, and gives every one of them the answer', async () => {
    // Three games RAWG files apart — an edition, a remaster — that Sony gathers in one concept.
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, conceptOf: 1 },
      { id: 3, conceptOf: 1, ...read(50 * HOUR) },
      { id: 4, ...read(25 * HOUR) },
    ])

    const report = await run.run()

    expect(run.asked('price')).toEqual([1, 4])
    expect(report).toMatchObject({ due: 4, pricesRead: 4, requests: 2, offers: 4 })
    for (const id of [1, 2, 3]) {
      expect(run.psOffer(id), `game ${id}`).toEqual(offerOf(1, START))
      expect(await run.stored(id)).toMatchObject({ conceptId: conceptOf(1), askedAt: START })
    }
  })

  it('removes the offer of every one of them when the answer is no price, and weighs each', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, conceptOf: 1, ...read(30 * HOUR) },
      { id: 3, conceptOf: 1 },
    ])
    unsold(run, 1)

    const report = await run.run()

    expect(report).toMatchObject({ removed: 2, requests: 1, offers: 0 })
  })

  it('does not ask about a concept any of whose games was asked about in the last twenty hours', async () => {
    const run = world([
      { id: 1, ...read(40 * HOUR) },
      // Its title was mapped by the nightly run three hours ago: that was a question about it.
      { id: 2, conceptOf: 1, askedAgo: 3 * HOUR },
      { id: 3, ...read(30 * HOUR) },
    ])

    await run.run()

    expect(run.asked('price')).toEqual([3])
  })

  it('counts the twenty-five games of one concept as one of the run’s 225 requests', async () => {
    const run = world([
      ...many(25, () => ({ conceptOf: 1, ...read(30 * HOUR) })),
      ...many(230, () => read(29 * HOUR), 1_001),
    ])

    const report = await run.run()

    expect(run.harness.sonyRequests).toHaveLength(PLAYSTATION_REQUESTS_PER_RUN)
    expect(report).toMatchObject({ due: 255, pricesRead: 25 + 224, requests: 225 })
  })
})

describe('a prices run: how it ends', () => {
  it('stops at the run’s 225 requests, and leaves the rest as it was for the next run', async () => {
    const run = world(many(240, (id) => read((500 - id) * HOUR)))

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
    // The fifteen asked about most recently were not reached, and not stamped.
    expect(run.psOffer(226)).toEqual(offerOf(226, ago((500 - 226) * HOUR)))
    expect(await run.stored(226)).toBeUndefined()
    // Running out of the ration is the design: nobody is warned of it.
    expect(playstationWarnings(report)).toEqual([])
  })

  it('never asks faster than a request every ten seconds, through the whole stage', async () => {
    const run = world(many(60, () => read(30 * HOUR)))
    run.harness.sonyState.latencyMs = 400

    await run.run()

    const left = run.harness.sonyRequests.map((request) => request.at)
    expect(left).toHaveLength(60)
    const gaps = left.slice(1).map((at, index) => at - left[index]!)
    // Ten seconds from the end of one request to the start of the next.
    expect(new Set(gaps)).toEqual(new Set([PLAYSTATION_PAUSE_MS + 400]))
  })

  it('stops at forty minutes when Sony is slow, with games still waiting', async () => {
    const run = world(many(225, () => read(30 * HOUR)))
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
      const run = world(many(10, (id) => read((100 - id) * HOUR)))
      run.harness.sonyAnswersWith(response, { match: (request) => request.id === '50004' })

      const report = await run.run()

      // Three answered, the fourth refused, and nothing after it.
      expect(run.asked('price')).toEqual([1, 2, 3, 4])
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
        `PlayStation Store: Sony refused a request (${detail}), so nothing more was asked in this run, after 4 requests — every offer that was not read stands as it was`,
      ])
    },
  )

  it('warns of a refusal that came with the last question of the run, too', async () => {
    const run = world([{ id: 1, ...read(30 * HOUR) }])
    run.harness.sonyAnswersWith({ status: 403 })

    const report = await run.run()

    expect(report.stopped).toEqual({ reason: 'refused', detail: 'HTTP 403' })
    expect(playstationWarnings(report)).toHaveLength(1)
  })

  it('stops at three failures in a row, and says so in a warning', async () => {
    const run = world(many(10, (id) => read((100 - id) * HOUR)))
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
      'PlayStation Store: 3 requests in a row failed, so nothing more was asked in this run, after 3 requests — every offer that was not read stands as it was',
    ])
  })

  it('does not stop at failures that are not in a row', async () => {
    const run = world(many(9, (id) => read((100 - id) * HOUR)))
    run.harness.sonyAnswersWith(
      { status: 500 },
      { times: Infinity, match: (request) => Number(request.id) % 3 !== 0 },
    )

    const report = await run.run()

    expect(run.asked('price')).toHaveLength(9)
    expect(report).toMatchObject({ pricesRead: 3, failed: 6, stopped: null })
    expect(playstationWarnings(report)).toEqual([])
  })

  it('says how old the oldest price it publishes is', async () => {
    const run = world([
      { id: 1, ...read(3 * HOUR) },
      { id: 2, ...read(19 * HOUR) },
      // Asked about five hours ago and failed: the offer on the document is from the day before.
      { id: 3, askedAgo: 5 * HOUR, readAgo: 31 * HOUR + 20 * MINUTE },
      { id: 4, ...read(25 * HOUR) },
    ])

    const report = await run.run()

    expect(run.asked('price')).toEqual([4])
    expect(report.oldestPriceAgeMs).toBe(31 * HOUR + 20 * MINUTE)
    expect((await world([{ id: 1 }]).run('nothing')).oldestPriceAgeMs).toBeNull()
  })
})

describe('a prices run: the floor under its answers', () => {
  /** `count` games carrying an offer, the first `unsoldCount` of which Sony no longer prices. */
  function carrying(count: number, unsoldCount: number): World {
    const run = world(many(count, (id) => read((500 - id) * HOUR)))
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
    expect(run.psOffer(12)?.updatedAt).toBe(leftAt(11))
    expect(playstationWarnings(report)).toEqual([
      `PlayStation Store: ${reason} — the prices that were read are published`,
    ])
  })

  it('removes them when exactly half would go, and when fewer than twenty were asked about', async () => {
    const half = carrying(20, 10)
    expect(await half.run()).toMatchObject({ status: 'read', removed: 10, offers: 10 })
    expect('offers' in half.byId(1)).toBe(false)

    // Under twenty, a run that prices something is believed about the rest.
    const few = carrying(19, 18)
    expect(await few.run()).toMatchObject({ status: 'read', removed: 18, offers: 1 })

    expect(OFFER_FLOOR_MIN_CARRIED).toBe(20)
    expect(removalsNotBelieved(20, 10)).toBeNull()
    expect(removalsNotBelieved(20, 11)).not.toBeNull()
    expect(removalsNotBelieved(19, 19)).toBeNull()
    expect(removalsNotBelieved(225, 113)).not.toBeNull()
    expect(removalsNotBelieved(225, 112)).toBeNull()
  })

  it('weighs only the games that carried an offer, and only those that were answered about', async () => {
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

  it('does not believe a run that asked about twenty games and found a price for none', async () => {
    // The store's first days: no game carries an offer yet, so the floor above weighs nothing.
    const fresh = world(many(30, () => ({})))
    for (let id = 1; id <= 30; id += 1) unsold(fresh, id)

    const report = await fresh.run()

    const reason =
      'asked about 30 games and not one of the answers is a price anyone can pay, so the answers are not believed and no offer is removed'
    expect(report).toMatchObject({ status: 'failed', pricesRead: 0, removed: 0, error: reason })
    expect(playstationWarnings(report)).toEqual([
      `PlayStation Store: ${reason} — the prices that were read are published`,
    ])

    // And it keeps the few offers such a run would have removed.
    const mixed = world([...many(5, () => read(30 * HOUR)), ...many(20, () => ({}), 101)])
    for (const game of mixed.games) unsold(mixed, game.id)
    expect(await mixed.run()).toMatchObject({ status: 'failed', removed: 0, offers: 5 })

    expect(nothingPriced(20, 0)).not.toBeNull()
    expect(nothingPriced(19, 0)).toBeNull()
    expect(nothingPriced(200, 1)).toBeNull()
  })

  it('asks about a game whose removal was not believed a day later, not with the next run', async () => {
    const run = carrying(20, 11)
    await run.run()

    // Six hours on nothing is due: every game was asked about, believed or not.
    const next = later(run, STARTED + 6 * HOUR)
    const report = await next.run()

    expect(next.harness.sonyRequests).toHaveLength(0)
    expect(report).toMatchObject({ status: 'read', due: 0, offers: 20 })
  })
})

describe('the nightly run: mapping titles to concepts', () => {
  it('asks which concept each waiting title belongs to, and remembers the answer', async () => {
    const run = world([
      { id: 1, ...read(30 * HOUR) },
      { id: 2, mapped: false },
      { id: 3, mapped: false },
      { id: 4, mapped: null, askedAgo: 3 * DAY },
    ])
    // Sony has no concept for the third title.
    run.harness.sonyConcepts[titleOf(3)] = sonyNoConcept(titleOf(3))

    const report = await run.run('mappings')

    // Titles only: the price of the first game is the prices runs' to read, however old it is.
    expect(run.harness.sonyRequests.map((request) => request.kind)).toEqual(['concept', 'concept'])
    // A title Sony said has no concept, three days ago, is not asked about again yet.
    expect(run.asked('concept')).toEqual([2, 3])
    expect(await run.stored(2)).toEqual({
      titleId: titleOf(2),
      conceptId: conceptOf(2),
      askedAt: START,
    })
    expect(await run.stored(3)).toEqual({ titleId: titleOf(3), conceptId: null, askedAt: START })
    expect(run.refs.get(2)?.playstation).toEqual(await run.stored(2))
    expect(report).toMatchObject({
      status: 'read',
      asks: 'mappings',
      references: 4,
      mapped: 2,
      withoutConcept: 2,
      unmapped: 0,
      due: 2,
      mappingsRead: 2,
      noConcept: 1,
      pricesRead: 0,
      requests: 2,
      offers: 1,
    })
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))
  })

  it('never asks again about a title that has a concept, however long ago it was asked about', async () => {
    const run = world([
      // Mapped by a build that did not date the asking; and one not asked about for forty days.
      { id: 1 },
      { id: 2, askedAgo: 40 * DAY },
      { id: 3, mapped: false },
    ])

    const report = await run.run('mappings')

    expect(run.asked('concept')).toEqual([3])
    expect(report).toMatchObject({ due: 1, mappingsRead: 1, mapped: 3, requests: 1 })
  })

  it('writes the date of the asking before the request is sent, as a prices run does', async () => {
    const run = world(many(3, () => ({ mapped: false })))
    const events: string[] = []
    const setStoreRefs = run.harness.writer.setStoreRefs.bind(run.harness.writer)
    vi.spyOn(run.harness.writer, 'setStoreRefs').mockImplementation(async (entries) => {
      const written = [...entries]
      for (const [id, record] of written) {
        const { conceptId, askedAt } = record.playstation ?? {}
        events.push(`write ${id}: ${conceptId ?? 'no concept yet'}, asked ${askedAt}`)
      }
      await setStoreRefs(written)
    })
    run.harness.sonyAnswersWith(
      {},
      { times: Infinity, match: (request) => (events.push(`ask ${request.id}`), false) },
    )

    await run.run('mappings')

    expect(events).toEqual(
      [1, 2, 3].flatMap((id, index) => [
        `write ${id}: no concept yet, asked ${stampedAt(index)}`,
        `ask ${titleOf(id)}`,
        `write ${id}: ${conceptOf(id)}, asked ${stampedAt(index)}`,
      ]),
    )
  })

  it('sends nothing to Sony when the index will not take the date of a mapping', async () => {
    const run = world(many(5, () => ({ mapped: false })))
    vi.spyOn(run.harness.writer, 'setStoreRefs').mockRejectedValue(
      new Error('the index is unreachable'),
    )

    await expect(run.run('mappings')).rejects.toThrow('the index is unreachable')

    expect(run.harness.sonyRequests).toHaveLength(0)
  })

  it('leaves the price of a title it mapped to the prices run twenty hours on', async () => {
    const run = world([{ id: 1, mapped: false }])
    await run.run('mappings')

    // The 06:15 prices run, three hours after the night's mapping: the game was asked about.
    const morning = later(run, STARTED + 3 * HOUR)
    expect(await morning.run()).toMatchObject({ mapped: 1, due: 0, requests: 0 })

    const nextNight = later(run, STARTED + 20 * HOUR)
    expect(await nextNight.run()).toMatchObject({ due: 1, pricesRead: 1 })
    expect(nextNight.sent()).toEqual([`price ${conceptOf(1)}`])
    expect(run.psOffer(1)).toEqual(offerOf(1, iso(STARTED + 20 * HOUR)))
  })

  it('maps at most two hundred titles a night, the most popular first', async () => {
    const run = world(many(300, (id) => ({ mapped: false, popularity: id })))
    // Half a second an answer, as Sony was seen to take.
    run.harness.sonyState.latencyMs = 500

    const report = await run.run('mappings')

    expect(PLAYSTATION_MAPPINGS_PER_RUN).toBe(200)
    expect(run.asked('concept')).toEqual(Array.from({ length: 200 }, (_, index) => 300 - index))
    expect(report).toMatchObject({
      due: 300,
      mappingsRead: 200,
      mapped: 200,
      unmapped: 100,
      requests: 200,
      // Two hundred a night is the design, not a stage cut short: the rest is held over.
      stopped: null,
      heldOver: 100,
    })
    expect(playstationWarnings(report)).toEqual([])
    // Thirty-five minutes of it, inside the forty the transport gives a run.
    const took = run.harness.clock.now() - STARTED
    expect(took).toBe(200 * 500 + 199 * PLAYSTATION_PAUSE_MS)
    expect(took).toBeLessThan(PLAYSTATION_BUDGET_MS)
    // And nothing is held over on a night that asks about all there is.
    expect(await world(many(3, () => ({ mapped: false }))).run('mappings')).not.toHaveProperty(
      'heldOver',
    )
  })

  it('is bound by the run’s forty minutes and its 225 requests, whatever the night’s number', async () => {
    expect(PLAYSTATION_MAPPINGS_PER_RUN).toBeLessThanOrEqual(PLAYSTATION_REQUESTS_PER_RUN)

    // A slow Sony: five seconds an answer. The forty minutes end the night at 160 titles.
    const slow = world(many(300, () => ({ mapped: false })))
    slow.harness.sonyState.latencyMs = 5_000
    const cut = await slow.run('mappings')
    expect(slow.harness.sonyRequests).toHaveLength(160)
    expect(cut).toMatchObject({
      mappingsRead: 160,
      requests: 160,
      stopped: { reason: 'time' },
      heldOver: 100,
    })
    expect(slow.harness.clock.now() - STARTED).toBeLessThanOrEqual(
      PLAYSTATION_BUDGET_MS + PLAYSTATION_PAUSE_MS,
    )
    // Running out of the time is the design: no warning.
    expect(playstationWarnings(cut)).toEqual([])

    // A run whose transport has already made thirty requests: the 225 end the night at 195.
    const spent = world(many(300, () => ({ mapped: false })))
    for (let asked = 0; asked < 30; asked += 1) await spent.harness.deps.playstation.price(1)
    const capped = await spent.run('mappings')
    expect(spent.asked('concept')).toHaveLength(195)
    expect(spent.harness.sonyRequests).toHaveLength(PLAYSTATION_REQUESTS_PER_RUN)
    expect(capped).toMatchObject({ mappingsRead: 195, stopped: { reason: 'requests' } })
  })

  it('asks first about a title never asked about, then about the one asked longest ago', async () => {
    const run = world([
      { id: 1, mapped: false, askedAgo: 2 * DAY },
      { id: 2, mapped: false },
      { id: 3, mapped: false, askedAgo: 5 * DAY },
      { id: 4, mapped: false },
      { id: 5, mapped: null, askedAgo: 40 * DAY },
    ])

    await run.run('mappings')

    expect(run.asked('concept')).toEqual([2, 4, 5, 3, 1])
  })

  it('stamps a title whose request failed, counts it in the two hundred, and asks again another night', async () => {
    const run = world(many(210, () => ({ mapped: false })))
    // Every fourth request fails: no three in a row do.
    const failing = (request: { id: string }) => Number(request.id.slice(4, 9)) % 4 === 0
    run.harness.sonyAnswersWith({ status: 502 }, { times: Infinity, match: failing })

    const report = await run.run('mappings')

    expect(run.harness.sonyRequests).toHaveLength(200)
    expect(report).toMatchObject({ mappingsRead: 150, failed: 50, mapped: 150, unmapped: 60 })
    // A failure is not "no concept", which would stand for a month. But it was asked.
    expect(await run.stored(4)).toEqual({ titleId: titleOf(4), askedAt: stampedAt(3) })

    // The same night again, should the run be started twice: the failed ones are not asked,
    // the ten never reached are.
    const again = later(run, STARTED + 2 * HOUR, 'mappings')
    await again.run()
    expect(again.sent()).toEqual(
      Array.from({ length: 10 }, (_, index) => `concept ${titleOf(201 + index)}`),
    )

    // The next night they are, after everything that has not been asked yet.
    const nextNight = later(run, STARTED + DAY, 'mappings')
    await nextNight.run()
    expect(nextNight.sent()).toEqual(
      Array.from({ length: 50 }, (_, index) => `concept ${titleOf(4 * (index + 1))}`),
    )
  })

  it('asks once about a title two games link, and gives both the answer', async () => {
    const run = world([
      { id: 1, mapped: false },
      { id: 2, mapped: false, titleOf: 1, conceptOf: 1 },
      { id: 3, mapped: false },
    ])

    const report = await run.run('mappings')

    expect(run.asked('concept')).toEqual([1, 3])
    expect(report).toMatchObject({ due: 3, mappingsRead: 3, mapped: 3, requests: 2 })
    expect(await run.stored(2)).toEqual({
      titleId: titleOf(1),
      conceptId: conceptOf(1),
      askedAt: START,
    })
  })

  it('asks again, after thirty days, about a title Sony said has no concept', async () => {
    const run = world([
      { id: 1, mapped: null, askedAgo: PLAYSTATION_NO_CONCEPT_KEPT_MS - 1 },
      { id: 2, mapped: null, askedAgo: PLAYSTATION_NO_CONCEPT_KEPT_MS },
      { id: 3, mapped: null, askedAgo: 45 * DAY },
      // Written by a build that did not date the answer: asked, as one never asked about.
      { id: 4, mapped: null },
    ])
    // The second has come to the store since; the third still has no concept.
    run.harness.sonyConcepts[titleOf(3)] = sonyNoConcept(titleOf(3))
    run.harness.sonyConcepts[titleOf(4)] = sonyNoConcept(titleOf(4))

    const report = await run.run('mappings')

    expect(PLAYSTATION_NO_CONCEPT_KEPT_MS).toBe(30 * DAY)
    expect(run.asked('concept')).toEqual([4, 3, 2])
    expect(await run.stored(1)).toBeUndefined()
    expect(await run.stored(2)).toEqual({
      titleId: titleOf(2),
      conceptId: conceptOf(2),
      askedAt: stampedAt(2),
    })
    // "None" again, for another thirty days from today.
    expect(await run.stored(3)).toEqual({
      titleId: titleOf(3),
      conceptId: null,
      askedAt: stampedAt(1),
    })
    expect(report).toMatchObject({ mapped: 1, withoutConcept: 3, mappingsRead: 3, noConcept: 2 })
  })

  it('does not keep "no concept" for a title whose request then fails', async () => {
    const run = world([{ id: 1, mapped: null, askedAgo: 31 * DAY }])
    run.harness.sonyAnswersWith({ status: 500 })

    await run.run('mappings')

    // Asked again, and unanswered: it is tried the next night, not in a month.
    expect(await run.stored(1)).toEqual({ titleId: titleOf(1), askedAt: START })
  })

  it('stops at a refusal or at three failures in a row, like a prices run, and says which', async () => {
    const refused = world(many(10, () => ({ mapped: false })))
    refused.harness.sonyAnswersWith(
      { status: 403 },
      { match: (request) => request.id === titleOf(3) },
    )

    const report = await refused.run('mappings')

    expect(refused.asked('concept')).toEqual([1, 2, 3])
    expect(report).toMatchObject({ mappingsRead: 2, failed: 1, stopped: { reason: 'refused' } })
    expect(playstationWarnings(report)).toEqual([
      'PlayStation Store: Sony refused a request (HTTP 403), so nothing more was asked in this run, after 3 requests — every title that was not answered about waits for another night',
    ])

    const failing = world(many(10, () => ({ mapped: false })))
    failing.harness.sonyAnswersWith({ status: 500 }, { times: Infinity })
    expect(await failing.run('mappings')).toMatchObject({
      failed: 3,
      requests: 3,
      stopped: { reason: 'failures' },
    })
  })
})

describe('the nightly run: the floor under "no concept"', () => {
  /** `count` waiting titles, the first `noneCount` of which Sony says have no concept. */
  function waiting(count: number, noneCount: number): World {
    const run = world(many(count, () => ({ mapped: false })))
    for (let id = 1; id <= noneCount; id += 1) {
      run.harness.sonyConcepts[titleOf(id)] = sonyNoConcept(titleOf(id))
    }
    return run
  }

  it('remembers none of them when more than half of twenty titles are said to have no concept', async () => {
    const run = waiting(20, 11)

    const report = await run.run('mappings')

    const reason =
      'asked about 20 titles and 11 of the answers say the title has no concept: over half, so the answers are not believed and none of them is remembered'
    expect(report).toMatchObject({
      status: 'failed',
      mappingsRead: 20,
      noConcept: 11,
      mapped: 9,
      withoutConcept: 0,
      unmapped: 11,
      error: reason,
    })
    // Asked, and no answer kept: the title is asked about again another night.
    expect(await run.stored(1)).toEqual({ titleId: titleOf(1), askedAt: START })
    // The concepts that were named are kept: only "none" is held back.
    expect(await run.stored(12)).toMatchObject({ conceptId: conceptOf(12) })
    expect(playstationWarnings(report)).toEqual([
      `PlayStation Store: ${reason} — the concepts that were named are kept`,
    ])

    const nextNight = later(run, STARTED + DAY, 'mappings')
    await nextNight.run()
    expect(nextNight.harness.sonyRequests).toHaveLength(11)
  })

  it('remembers them when exactly half say so, and when fewer than twenty titles were answered about', async () => {
    const half = waiting(20, 10)
    expect(await half.run('mappings')).toMatchObject({ status: 'read', withoutConcept: 10 })
    expect(await half.stored(1)).toMatchObject({ conceptId: null })

    const few = waiting(19, 19)
    expect(await few.run('mappings')).toMatchObject({ status: 'read', withoutConcept: 19 })

    expect(noConceptNotBelieved(20, 10)).toBeNull()
    expect(noConceptNotBelieved(20, 11)).not.toBeNull()
    expect(noConceptNotBelieved(19, 19)).toBeNull()
    expect(noConceptNotBelieved(60, 31)).not.toBeNull()
  })

  it('weighs the titles that were answered about, not those whose request failed', async () => {
    // Twenty-four asked: four fail, eleven of the twenty answers say "none".
    const run = waiting(24, 11)
    run.harness.sonyAnswersWith(
      { status: 500 },
      {
        times: Infinity,
        match: (request) => [13, 16, 19, 22].includes(Number(request.id.slice(4, 9))),
      },
    )

    expect(await run.run('mappings')).toMatchObject({
      status: 'failed',
      mappingsRead: 20,
      noConcept: 11,
      failed: 4,
    })
  })

  it('writes what it holds back only at the end of the night', async () => {
    const run = waiting(3, 3)
    const setStoreRefs = vi.spyOn(run.harness.writer, 'setStoreRefs')

    await run.run('mappings')

    // Three dates of asking, one by one, and then the three answers together.
    expect(setStoreRefs.mock.calls.map(([entries]) => [...entries].length)).toEqual([1, 1, 1, 3])
  })
})

describe('which kind of run asks Sony what', () => {
  const games = (): Spec[] => [
    { id: 1, ...read(30 * HOUR) },
    { id: 2, ...read(45 * HOUR) },
    { id: 3, mapped: false },
    { id: 4, mapped: null, askedAgo: 40 * DAY },
  ]

  it('reads prices in a prices run, and maps no title', async () => {
    const run = world(games())

    const report = await run.run('prices')

    expect(run.harness.sonyRequests.map((request) => request.kind)).toEqual(['price', 'price'])
    expect(report).toMatchObject({ asks: 'prices', pricesRead: 2, mappingsRead: 0, unmapped: 1 })
  })

  it('maps titles in the nightly run, and reads no price', async () => {
    const run = world(games())

    const report = await run.run('mappings')

    expect(run.harness.sonyRequests.map((request) => request.kind)).toEqual(['concept', 'concept'])
    expect(report).toMatchObject({ asks: 'mappings', pricesRead: 0, mappingsRead: 2, offers: 2 })
  })

  it('asks nothing in a languages run, and still says where the store stands', async () => {
    const run = world(games())
    const setStoreRefs = vi.spyOn(run.harness.writer, 'setStoreRefs')

    const report = await run.run('nothing', { verdict: { lost: null, dropped: 3 } })

    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(setStoreRefs).not.toHaveBeenCalled()
    expect(report).toEqual({
      status: 'not-in-this-run',
      asks: 'nothing',
      references: 4,
      mapped: 2,
      withoutConcept: 1,
      unmapped: 1,
      due: 0,
      pricesRead: 0,
      mappingsRead: 0,
      noConcept: 0,
      removed: 0,
      failed: 0,
      requests: 0,
      offers: 2,
      oldestPriceAgeMs: 45 * HOUR,
      stopped: null,
      // What the rule about references cost reaches the summary in every kind of run.
      dropped: 3,
    })
    expect(playstationWarnings(report)).toEqual([])
    expect(playstationWarnings({ ...report, dropped: 20 })).toEqual([
      'PlayStation Store: 20 offers dropped because their games no longer have a store reference',
    ])
  })

  it.each(['prices', 'mappings'] as const)(
    'asks nothing in a %s run that is going to be refused publication',
    async (asks) => {
      const run = world(games())
      const refusal = 'the run priced 12 games, against 2 552 in the published version'

      const report = await run.run(asks, { refusal })

      expect(run.harness.sonyRequests).toHaveLength(0)
      expect(report).toMatchObject({ status: 'run-refused', asks, requests: 0, error: refusal })
      // Nothing was asked, so nothing is stamped: the games are as due as they were.
      expect(await run.stored(2)).toBeUndefined()
      // The run is red and says why itself; this stage has nothing to add.
      expect(playstationWarnings(report)).toEqual([])
    },
  )
})

describe('the mapping the stage is handed', () => {
  it('asks nothing and reports no references when no game has a PlayStation title', async () => {
    const run = world([])
    run.games.push(document({ id: 1 }))
    run.refs.set(1, { gog: 'game_1', playstation: null })

    for (const asks of ['prices', 'mappings', 'nothing'] as const) {
      const report = await run.run(asks)

      expect(report).toMatchObject({ status: 'no-references', references: 0, requests: 0 })
      expect(playstationWarnings(report)).toEqual([])
    }
    expect(run.harness.sonyRequests).toHaveLength(0)
  })

  it('asks nothing while the references look lost, in any kind of run, and says so in a warning', async () => {
    const run = world(many(5, () => read(30 * HOUR)))
    const lost =
      'carried 400, the mapping names a product for 5 of those games: under half, so the store references look lost'

    for (const asks of ['prices', 'mappings', 'nothing'] as const) {
      const report = await run.run(asks, { verdict: { lost, dropped: 0 } })

      expect(report).toMatchObject({
        status: 'references-lost',
        error: lost,
        requests: 0,
        offers: 5,
      })
      expect(playstationWarnings(report)).toEqual([
        `PlayStation Store prices not refreshed: ${lost} — every offer is kept as it was and Sony was not asked`,
      ])
    }
    expect(run.harness.sonyRequests).toHaveLength(0)
    expect(run.psOffer(1)).toEqual(offerOf(1, ago(30 * HOUR)))
  })

  it('reports what a believed mapping cost the store, and warns from twenty offers up', async () => {
    const run = world([{ id: 1, ...read(3 * HOUR) }])

    expect((await run.run('prices', { verdict: { lost: null, dropped: 19 } })).dropped).toBe(19)
    expect(
      playstationWarnings(await run.run('prices', { verdict: { lost: null, dropped: 19 } })),
    ).toEqual([])
    expect(
      playstationWarnings(await run.run('prices', { verdict: { lost: null, dropped: 20 } })),
    ).toEqual([
      'PlayStation Store: 20 offers dropped because their games no longer have a store reference',
    ])
    expect('dropped' in (await run.run())).toBe(false)
  })

  it('takes nothing of a reference on trust', async () => {
    const run = world([{ id: 1 }, { id: 2 }, { id: 3 }])
    run.refs.set(1, { playstation: { titleId: 'NPUB31077_00', conceptId: 7 } })
    run.refs.set(2, { playstation: { titleId: titleOf(2), conceptId: '50002' } } as never)

    // A title that is not one is no reference; a concept that is not one reads as not answered.
    expect(await run.run('prices')).toMatchObject({ references: 2, mapped: 1, unmapped: 1 })
    expect(await run.run('mappings')).toMatchObject({ mapped: 2, mappingsRead: 1 })
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
    const run = world(many(3, () => read(3 * HOUR)))
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
    const run = world(many(20, () => read(3 * HOUR)))
    for (let id = 1; id <= 11; id += 1) run.refs.delete(id)

    const result = await refreshOffers(run.harness.deps, run.games, run.refs, null)

    expect(result.playstation).toEqual({
      lost: 'carried 20, the mapping names a product for 9 of those games: under half, so the store references look lost',
      dropped: 0,
    })
    for (const game of run.games) expect(game.offers).toHaveLength(1)

    // And the stage that reads the store asks nothing on the strength of such a mapping.
    const report = await run.run('prices', { verdict: result.playstation })
    expect(report).toMatchObject({ status: 'references-lost', offers: 20, requests: 0 })
    expect(run.harness.sonyRequests).toHaveLength(0)
  })

  it('counts a title Sony has not answered about yet as a reference', async () => {
    const run = world([{ id: 1, readAgo: 3 * HOUR, mapped: false }])

    const result = await refreshOffers(run.harness.deps, run.games, run.refs, null)

    expect(result.playstation).toEqual({ lost: null, dropped: 0 })
    expect(run.psOffer(1)).toBeDefined()
  })
})

describe('the stage and the writer’s lock', () => {
  it('gives the lock a sign of life after every request, through forty minutes of them', async () => {
    const run = world(many(230, () => read(30 * HOUR)))
    const renewLock = vi.spyOn(run.harness.writer, 'renewLock')

    await run.run()

    expect(run.harness.clock.now() - STARTED).toBeGreaterThan(30 * MINUTE)
    expect(renewLock).toHaveBeenCalledTimes(PLAYSTATION_REQUESTS_PER_RUN)
  })

  it('renews after a request that failed as after one that was answered, in either kind of run', async () => {
    const run = world([
      ...many(4, () => read(30 * HOUR)),
      ...many(3, () => ({ mapped: false }), 11),
    ])
    run.harness.sonyAnswersWith({ status: 500 }, { times: 2 })
    const renewLock = vi.spyOn(run.harness.writer, 'renewLock')

    await run.run('prices')
    expect(renewLock).toHaveBeenCalledTimes(4)
    await run.run('mappings')
    expect(renewLock).toHaveBeenCalledTimes(7)
  })

  it('stops asking Sony for a run whose lock will not renew, and fails as the index’s failure', async () => {
    const run = world(many(10, () => read(30 * HOUR)))
    let renewals = 0
    vi.spyOn(run.harness.writer, 'renewLock').mockImplementation(async () => {
      renewals += 1
      if (renewals === 2) throw new Error('the index is unreachable')
    })

    await expect(run.run()).rejects.toThrow('the index is unreachable')

    // Two requests were made before the lock was known lost, and none after.
    expect(run.harness.sonyRequests).toHaveLength(2)
    // The third game was neither asked about nor stamped.
    expect(await run.stored(3)).toBeUndefined()
  })
})
