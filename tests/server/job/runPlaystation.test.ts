import { describe, expect, it, vi } from 'vitest'
import { PLAYSTATION_PAUSE_MS } from '../../../scripts/index/playstation'
import { PLAYSTATION_REFUSED_CURSOR } from '../../../scripts/index/playstationOffers'
import {
  formatSummary,
  PLAYSTATION_ASKS,
  runJob,
  type JobReport,
  type StoresReport,
} from '../../../scripts/index/run'
import type { IndexMeta, IndexedGame, IndexedOffer } from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import {
  cheaperAtOf,
  exchangeRateAt,
  freshOffers,
  listedOffers,
  pageOffers,
  readableOffers,
} from '../../../server/index/offerRules'
import { toGame, toStoreOffer } from '../../../server/index/toGraphql'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { JOB_APP_IDS, JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import {
  JOB_PLAYSTATION_CONCEPTS,
  JOB_PLAYSTATION_PRODUCTS,
  JOB_PLAYSTATION_SALE_ENDS_AT,
  JOB_PLAYSTATION_TITLES,
  sonyPrice,
} from '../../fixtures/index/jobPlaystation'
import { createFakeRedis } from '../index/fakeRedis'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The whole job with the PlayStation Store in it. RAWG lists four games of the job catalog there
 * (`tests/fixtures/index/jobPlaystation.ts`): 103 with a PlayStation 3 link, which is no
 * reference, and 101, 106 and 108 with a PlayStation 4 or PlayStation 5 title. The rules here are
 * about what each kind of run does with them, and what a run does when Sony will not answer.
 */

const RUN_AT = '2026-09-20T03:00:00.000Z'
const MINUTE = 60_000
const HOUR = 3_600_000
const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const
const PRICES = { mode: 'prices', pages: 1, forceUnlock: false } as const
const LANGUAGES = { mode: 'languages', pages: 1, forceUnlock: false } as const

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
/** The moment the `n`th request of a run that began asking at `iso` left, counted from nought. */
const request = (iso: string, n: number) => later(iso, n * PLAYSTATION_PAUSE_MS)
/** The date its game is stamped with: written before the request, so a pause before it leaves. */
const stamp = (iso: string, n: number) => request(iso, Math.max(0, n - 1))

/**
 * The first prices run that finds the night's titles due: the one twenty hours on from the night
 * that mapped them, and a little more, as the 00:15 run is from the 02:30 one.
 */
const FIRST_PRICES_AT = later(RUN_AT, 21 * HOUR)

const urlOf = (id: keyof typeof JOB_PLAYSTATION_PRODUCTS) =>
  `https://store.playstation.com/uk-ua/product/${JOB_PLAYSTATION_PRODUCTS[id]}`

/** Game 101 at Sony's: free for everybody. */
const hollowOffer = (updatedAt: string): IndexedOffer => ({
  store: 'playstation-store',
  title: 'Hollow Cradle',
  amount: 0,
  regularAmount: 0,
  discountPercent: 0,
  currency: 'UAH',
  url: urlOf(101),
  updatedAt,
})

/** Game 106: half price until the sale ends, under the game's own name. */
const amberOffer = (updatedAt: string): IndexedOffer => ({
  store: 'playstation-store',
  title: 'Amber Trail',
  amount: 39_950,
  regularAmount: 79_900,
  discountPercent: 50,
  currency: 'UAH',
  url: urlOf(106),
  updatedAt,
  saleEndsAt: JOB_PLAYSTATION_SALE_ENDS_AT,
})

/** Game 108: its regular price, and a product that is not the game by name. */
const meridianOffer = (updatedAt: string): IndexedOffer => ({
  store: 'playstation-store',
  title: 'Silent Meridian: Deluxe Edition',
  amount: 129_900,
  regularAmount: 129_900,
  discountPercent: 0,
  currency: 'UAH',
  url: urlOf(108),
  updatedAt,
})

const psOffers = (game: IndexedGame | null) =>
  (game?.offers ?? []).filter((offer) => offer.store === 'playstation-store')

/** A first full run with the PlayStation Store listed, published: the titles found and mapped. */
async function firstNight(): Promise<JobHarness> {
  const harness = createJobHarness({ start: RUN_AT, playstation: true })
  await runJob(harness.deps, FULL)
  return harness
}

const nextRun = (previous: JobHarness, start: string) =>
  createJobHarness({ writer: previous.writer, start, playstation: true })

/** The night, then the first prices run that finds its titles due, which reads the three prices. */
async function firstPrices(): Promise<{ night: JobHarness; prices: JobHarness; at: string }> {
  const night = await firstNight()
  const prices = nextRun(night, FIRST_PRICES_AT)
  await runJob(prices.deps, PRICES)
  return { night, prices, at: FIRST_PRICES_AT }
}

const sent = (harness: JobHarness) =>
  harness.sonyRequests.map((entry) => `${entry.kind} ${entry.id}`)
const EVERY_PRICE = [101, 106, 108].map(
  (id) => `price ${JOB_PLAYSTATION_CONCEPTS[id as keyof typeof JOB_PLAYSTATION_CONCEPTS]}`,
)

describe('runJob and the PlayStation Store', () => {
  it('asks one kind of question in each kind of run', () => {
    expect(PLAYSTATION_ASKS).toEqual({ prices: 'prices', full: 'mappings', languages: 'nothing' })
  })

  it('finds the titles with the nightly run, and asks Sony which concepts they belong to', async () => {
    const harness = createJobHarness({ start: RUN_AT, playstation: true })

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    // RAWG: the seven app-id lookups of any first night brought the titles of 101, 106 and 108
    // with them, and the sweep asked about 103 — on the PlayStation Store and not on Steam — and
    // about 109.
    expect(harness.storeCalls()).toHaveLength(9)
    expect(report.stores?.references).toEqual({
      games: 9,
      listed: 5,
      asked: 5,
      gog: 1,
      microsoft: 1,
      playstation: 3,
      sweep: { attempted: 2, failures: 0, remaining: 0, stopped: null },
    })
    // Sony: the three titles, the most popular game first, ten seconds apart — and no price.
    expect(sent(harness)).toEqual([
      `concept ${JOB_PLAYSTATION_TITLES[101]}`,
      `concept ${JOB_PLAYSTATION_TITLES[106]}`,
      `concept ${JOB_PLAYSTATION_TITLES[108]}`,
    ])
    const left = harness.sonyRequests.map((entry) => entry.at)
    expect([left[1]! - left[0]!, left[2]! - left[1]!]).toEqual([10_000, 10_000])
    expect(report.stores?.playstation).toEqual({
      status: 'read',
      asks: 'mappings',
      references: 3,
      mapped: 3,
      withoutConcept: 0,
      unmapped: 0,
      due: 3,
      pricesRead: 0,
      mappingsRead: 3,
      noConcept: 0,
      removed: 0,
      failed: 0,
      requests: 3,
      concepts: 3,
      offers: 0,
      oldestPriceAgeMs: null,
      oldestShownPriceAgeMs: null,
      stopped: null,
    })
    expect(await harness.writer.getStoreRefs([101, 103, 106, 108])).toEqual(
      new Map([
        [
          101,
          {
            gog: 'hollow_cradle',
            playstation: { titleId: 'PPSA10100_00', conceptId: 10_101, askedAt: stamp(RUN_AT, 0) },
          },
        ],
        // Listed there, asked, and the link is a PlayStation 3 product: no reference.
        [103, { playstation: null }],
        [
          106,
          {
            playstation: { titleId: 'CUSA10600_00', conceptId: 10_106, askedAt: stamp(RUN_AT, 1) },
          },
        ],
        [
          108,
          {
            playstation: { titleId: 'PPSA10800_00', conceptId: 10_108, askedAt: stamp(RUN_AT, 2) },
          },
        ],
      ]),
    )
    expect(psOffers(await harness.writer.getOne(106))).toEqual([])
    expect((await harness.writer.meta())?.stats).toMatchObject({ playstationOfferCount: 0 })
    // The other stores were read as on any night, and are none the worse for this one.
    expect(report.stores).toMatchObject({ gog: { status: 'read' }, microsoft: { status: 'read' } })
    expect((await harness.writer.getOne(101))?.offers).toHaveLength(1)
  })

  it('reads no price for a title the night mapped until twenty hours have passed', async () => {
    const night = await firstNight()

    // The 06:15 and the 18:15 run after it: the games were asked about that night.
    for (const hours of [3, 15]) {
      const run = nextRun(night, later(RUN_AT, hours * HOUR))
      const report = await runJob(run.deps, PRICES)

      expect(run.sonyRequests, `${hours} hours on`).toHaveLength(0)
      expect(report.stores?.playstation).toMatchObject({
        status: 'read',
        asks: 'prices',
        mapped: 3,
        due: 0,
        requests: 0,
        offers: 0,
      })
    }
  })

  it('reads the prices with the first prices run after that, and publishes them', async () => {
    const { prices, at } = await firstPrices()

    // RAWG is asked nothing by a prices run, and Sony only for the three prices.
    expect(prices.calls).toHaveLength(0)
    expect(sent(prices)).toEqual(EVERY_PRICE)
    expect(await prices.writer.getOne(106)).toMatchObject({
      // Steam's price is where it always was.
      priceUah: 599,
      steamAppId: '416000',
      offers: [amberOffer(request(at, 1))],
    })
    // Each is dated by its own answer, ten seconds after the one before.
    expect((await prices.writer.getOne(108))?.offers).toEqual([meridianOffer(request(at, 2))])
    // And stands after the offers the game already had, in the stores' own order.
    expect((await prices.writer.getOne(101))?.offers).toEqual([
      expect.objectContaining({ store: 'gog' }),
      hollowOffer(at),
    ])
    const meta = await prices.writer.meta()
    expect(meta?.stats).toMatchObject({
      playstationOfferCount: 3,
      gogOfferCount: 1,
      microsoftOfferCount: 1,
    })
    // The store has no stamp of its own in the metadata.
    expect(Object.keys(meta?.offersReadAt ?? {}).sort()).toEqual(['gog', 'xbox-store'])
    // The version is published when the stage is over, twenty seconds in.
    expect(meta?.updatedAt).toBe(request(at, 2))
    // What is remembered of the asking is on the reference, not only on the offer.
    expect((await prices.writer.getStoreRefs([108])).get(108)).toEqual({
      playstation: { titleId: 'PPSA10800_00', conceptId: 10_108, askedAt: stamp(at, 2) },
    })
  })

  // The job's tests and the site's tests each read their own fixtures; this is the one place
  // what the job really writes for this store is put through what the site really reads.
  it('writes offers that the site reads as they stand', async () => {
    const { prices, at } = await firstPrices()
    const now = later(at, 5 * MINUTE)
    const rate = exchangeRateAt(await prices.writer.meta(), now)

    const amber = (await prices.writer.getOne(106))!
    expect(readableOffers(amber)).toEqual(amber.offers)
    expect(toStoreOffer(readableOffers(amber)[0]!, rate)).toMatchObject({
      store: 'playstation-store',
      url: urlOf(106),
      title: 'Amber Trail',
      isFree: false,
      updatedAt: request(at, 1),
      // 399,50 ₴ against 799,00 ₴, in whole hryvnia.
      priceUah: 400,
      regularPriceUah: 799,
      discountPercent: 50,
    })

    const meridian = (await prices.writer.getOne(108))!
    expect(readableOffers(meridian)).toEqual(meridian.offers)
    expect(toStoreOffer(readableOffers(meridian)[0]!, rate)).toMatchObject({
      title: 'Silent Meridian: Deluxe Edition',
      priceUah: 1299,
      regularPriceUah: null,
      discountPercent: 0,
    })

    // Both of a game's offers are read, each of its own store.
    const hollow = (await prices.writer.getOne(101))!
    expect(readableOffers(hollow)).toEqual(hollow.offers)
    expect(toStoreOffer(readableOffers(hollow)[1]!, rate)).toMatchObject({
      store: 'playstation-store',
      title: 'Hollow Cradle',
      isFree: true,
      priceUah: 0,
    })
  })

  // What the pages do with this store's offers is the next change's to decide (the design,
  // section 4). Until then no page shows them by the other stores' rules.
  it('publishes them without any page showing or weighing them yet', async () => {
    const { prices, at } = await firstPrices()
    const now = later(at, 5 * MINUTE)
    const rate = exchangeRateAt(await prices.writer.meta(), now)
    const terms = { now, rate }

    // RAWG lists the game on the store, the offer is readable and fresh, and it is far below
    // Steam's price: every reason the other stores' rules would have to show and name it.
    const amber = (await prices.writer.getOne(106))!
    expect(amber.stores).toContain('playstation-store')
    expect(amber.priceUah).toBeGreaterThan(400 * 1.1)
    expect(pageOffers(amber)).toEqual([])
    expect(listedOffers(amber)).toEqual([])
    expect(freshOffers(amber, now)).toEqual([])
    expect(cheaperAtOf(amber, now, rate)).toBeNull()
    const page = toGame(amber, terms)
    expect(page.stores.map((row) => row.store)).toEqual(['steam'])
    expect(page.stores.some((row) => row.cheapest)).toBe(false)

    // And a game with a GOG offer is weighed exactly as if Sony gave nothing away.
    const hollow = (await prices.writer.getOne(101))!
    const without = { ...hollow, offers: hollow.offers!.filter((offer) => offer.store === 'gog') }
    expect(psOffers(hollow)[0]).toMatchObject({ amount: 0 })
    expect(pageOffers(hollow)).toEqual(without.offers)
    expect(toGame(hollow, terms)).toEqual(toGame(without, terms))
    expect(cheaperAtOf(hollow, now, rate)).toBe(cheaperAtOf(without, now, rate))
  })

  it('does not ask about a game again before twenty hours have passed', async () => {
    const { night, at } = await firstPrices()

    for (const hours of [6, 12, 19]) {
      const run = nextRun(night, later(at, hours * HOUR))
      const report = await runJob(run.deps, PRICES)

      expect(run.sonyRequests, `${hours} hours on`).toHaveLength(0)
      expect(report.stores?.playstation).toMatchObject({
        status: 'read',
        due: 0,
        requests: 0,
        offers: 3,
        stopped: null,
      })
      // Carried into the new version under the date of the read.
      expect((await run.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])
    }

    // The third game was stamped ten seconds after the first two: twenty hours on, to the
    // second, two are due and it is not yet.
    const due = later(at, 20 * HOUR)
    const next = nextRun(night, due)
    await runJob(next.deps, PRICES)

    expect(sent(next)).toEqual(EVERY_PRICE.slice(0, 2))
    expect(psOffers(await next.writer.getOne(101))).toEqual([hollowOffer(due)])
    expect((await next.writer.getOne(108))?.offers).toEqual([meridianOffer(request(at, 2))])
  })

  it('reads no price in the nightly run, which carries the offers and maps what is waiting', async () => {
    const { night, at } = await firstPrices()
    // A day and more after the prices were read: every one of them would be due.
    const nextNight = nextRun(night, later(at, 26 * HOUR))

    const report = await runJob(nextNight.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    // Every title has its answer, so there is nothing to map either.
    expect(nextNight.sonyRequests).toHaveLength(0)
    expect(nextNight.storeCalls()).toHaveLength(0)
    expect((await nextNight.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])
    expect(report.stores?.playstation).toMatchObject({
      status: 'read',
      asks: 'mappings',
      references: 3,
      mapped: 3,
      due: 0,
      offers: 3,
      // The first of the three prices was read twenty-six hours before this run began.
      oldestPriceAgeMs: 26 * HOUR,
    })
  })

  it('asks Sony nothing in a languages run, and still reports the store', async () => {
    const { night, at } = await firstPrices()
    const weekly = nextRun(night, later(at, 26 * HOUR))

    const report = await runJob(weekly.deps, LANGUAGES)

    expect(report.outcome?.published).toBe(true)
    expect(weekly.sonyRequests).toHaveLength(0)
    expect(psOffers(await weekly.writer.getOne(101))).toEqual([hollowOffer(at)])
    expect(report.stores?.playstation).toMatchObject({
      status: 'not-in-this-run',
      asks: 'nothing',
      references: 3,
      mapped: 3,
      offers: 3,
      requests: 0,
    })
    expect(formatSummary(report)).toContain(
      '| PlayStation Store prices | 3 references, 3 mapped to a concept, 0 with none, 0 waiting to be; not read in this kind of run; 3 offers carried, the oldest read 26 h ago |',
    )
  })

  it('removes the offer of a game Sony stops pricing, and asks about it a day later', async () => {
    const { night, at } = await firstPrices()
    const day = later(at, 24 * HOUR)
    const gone = nextRun(night, day)
    gone.sonyPrices[JOB_PLAYSTATION_CONCEPTS[106]] = sonyPrice(JOB_PLAYSTATION_CONCEPTS[106], null)

    const report = await runJob(gone.deps, PRICES)

    expect(report.stores?.playstation).toMatchObject({ pricesRead: 2, removed: 1, offers: 2 })
    expect(psOffers(await gone.writer.getOne(106))).toEqual([])
    expect((await gone.writer.getStoreRefs([106])).get(106)).toEqual({
      playstation: { titleId: 'CUSA10600_00', conceptId: 10_106, askedAt: stamp(day, 1) },
    })

    // Six hours on it is not asked about; a day on it is, and the price is back.
    const soon = nextRun(night, later(day, 6 * HOUR))
    await runJob(soon.deps, PRICES)
    expect(soon.sonyRequests).toHaveLength(0)

    const back = nextRun(night, later(day, 21 * HOUR))
    await runJob(back.deps, PRICES)
    expect(sent(back)).toEqual(EVERY_PRICE)
    expect(psOffers(await back.writer.getOne(106))).toHaveLength(1)
  })
})

/**
 * The date of a read used to live on the offer alone, in a version that is published forty
 * minutes later or not at all. A run that asked and then did not publish left every game as due
 * as it had been, and the next run asked Sony about the same games six hours after they were
 * asked.
 */
describe('runJob when the run that asked does not publish', () => {
  it('does not ask again, six hours on, about games a failed run asked about', async () => {
    const { night, at } = await firstPrices()
    const day = later(at, 24 * HOUR)
    const failing = nextRun(night, day)
    // The version is read, the prices are read — and the write of the version breaks.
    vi.spyOn(failing.writer, 'writeVersion').mockRejectedValue(new Error('the index is full'))

    const error = await runJob(failing.deps, PRICES).catch((caught: unknown) => caught)

    expect((error as { stage: string }).stage).toBe('publish')
    expect(sent(failing)).toEqual(EVERY_PRICE)
    vi.restoreAllMocks()
    // Nothing was published: the offers are yesterday's, under yesterday's dates.
    expect((await night.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])

    const soon = nextRun(night, later(day, 6 * HOUR))
    const report = await runJob(soon.deps, PRICES)
    expect(soon.sonyRequests).toHaveLength(0)
    expect(report.stores?.playstation).toMatchObject({ due: 0, offers: 3 })

    // A day after the asking they are asked about again, like any other game.
    const next = nextRun(night, later(day, 21 * HOUR))
    await runJob(next.deps, PRICES)
    expect(sent(next)).toEqual(EVERY_PRICE)
  })

  it('asks Sony nothing in a prices run that is going to be refused publication', async () => {
    const { night, at } = await firstPrices()
    const refused = nextRun(night, later(at, 24 * HOUR))
    // The published version prices far more games than this run will: the gate will refuse it.
    const meta = (await night.writer.meta())!
    vi.spyOn(refused.writer, 'meta').mockResolvedValue({
      ...meta,
      stats: { ...meta.stats, pricedCount: 100 },
    })

    const report = await runJob(refused.deps, PRICES)

    expect(report.outcome).toMatchObject({ published: false })
    expect(refused.sonyRequests).toHaveLength(0)
    expect(report.stores?.playstation).toMatchObject({
      status: 'run-refused',
      requests: 0,
      offers: 3,
      error: 'the run priced 5 games, against 100 in the published version',
    })
    expect(formatSummary(report)).toContain(
      'not read: the run is going to be refused publication (the run priced 5 games, against 100 in the published version); 3 offers carried',
    )
    vi.restoreAllMocks()

    // The games were not asked about, so the next run that may publish asks about them.
    const next = nextRun(night, later(at, 30 * HOUR))
    await runJob(next.deps, PRICES)
    expect(sent(next)).toEqual(EVERY_PRICE)
  })

  it('asks Sony nothing in a nightly run whose candidates have collapsed', async () => {
    // A first version with far more candidates than this night will find.
    const before = createJobHarness({ start: RUN_AT, playstation: true })
    await runJob(before.deps, FULL)
    const meta = (await before.writer.meta())!
    const truncated = createJobHarness({
      writer: before.writer,
      start: later(RUN_AT, 24 * HOUR),
      playstation: true,
    })
    // Its titles are waiting again, as on a night after RAWG named some more.
    await before.writer.setStoreRefs([
      [106, { playstation: { titleId: 'CUSA10600_00' } }],
      [108, { playstation: { titleId: 'PPSA10800_00' } }],
    ])
    vi.spyOn(truncated.writer, 'meta').mockResolvedValue({
      ...meta,
      stats: { ...meta.stats, candidateCount: 3_000 },
    })

    const report = await runJob(truncated.deps, FULL)

    expect(report.outcome).toMatchObject({ published: false })
    expect(truncated.sonyRequests).toHaveLength(0)
    expect(report.stores?.playstation).toMatchObject({ status: 'run-refused', unmapped: 2 })
  })
})

/** A document without what this build added for the store, as a run sees it whatever Sony does. */
function withoutPlaystation(games: IndexedGame[]) {
  return games
    .map((game) => {
      const offers = (game.offers ?? []).filter((offer) => offer.store !== 'playstation-store')
      const { offers: _offers, ...rest } = game
      return offers.length > 0 ? { ...rest, offers } : rest
    })
    .sort((left, right) => left.id - right.id)
}

function withoutPlaystationMeta(meta: IndexMeta | null) {
  if (!meta) return null
  // The publication's own clock and length move with the stage: it waits on Sony.
  const { updatedAt: _published, stats, ...rest } = meta
  const { playstationOfferCount: _count, durationMs: _duration, ...others } = stats ?? {}
  return { ...rest, stats: others }
}

describe('runJob when Sony will not answer', () => {
  const warnings = (harness: JobHarness) =>
    harness.logs.filter((line) => line.startsWith('::warning::PlayStation Store'))

  it.each([
    ['is down', { status: 503 }, 'failures', 3],
    ['times out', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'failures', 3],
    ['answers every request with errors', { status: 200, body: { errors: [{}] } }, 'failures', 3],
    ['refuses the job', { status: 403 }, 'refused', 1],
    ['rate-limits the job', { status: 429 }, 'refused', 1],
    ['answers with a challenge', { status: 200, html: true }, 'refused', 1],
  ])(
    'does everything it would have done when Sony %s, and only the refresh is missing',
    async (_what, outcome, reason, requests) => {
      // Two worlds from the same first day; a day on, one of them finds Sony like this.
      const day = later(FIRST_PRICES_AT, 24 * HOUR)
      const up = nextRun((await firstPrices()).night, day)
      const down = nextRun((await firstPrices()).night, day)
      down.sonyAnswersWith(outcome, { times: Infinity })

      const withSony = await runJob(up.deps, PRICES)
      const without = await runJob(down.deps, PRICES)

      expect(without.outcome?.published).toBe(true)
      // Everything that is not this store's is the same run: documents, counts, stamps, failures.
      expect(withoutPlaystation(await down.writer.allGames())).toEqual(
        withoutPlaystation(await up.writer.allGames()),
      )
      expect(withoutPlaystationMeta(await down.writer.meta())).toEqual(
        withoutPlaystationMeta(await up.writer.meta()),
      )
      expect(without.pricesFetched).toBe(withSony.pricesFetched)
      // A request Sony failed is not one of the run's item failures, and trips no gate.
      expect(without.failures).toBe(0)
      expect(withSony.failures).toBe(0)
      expect(down.gogPages).toEqual(up.gogPages)
      expect(down.priceBatches).toEqual(up.priceBatches)

      // What is missing is the refresh: yesterday's offers, under yesterday's dates.
      expect((await up.writer.getOne(106))?.offers).toEqual([amberOffer(request(day, 1))])
      expect((await down.writer.getOne(106))?.offers).toEqual([
        amberOffer(request(FIRST_PRICES_AT, 1)),
      ])
      expect((await down.writer.getOne(108))?.offers).toEqual([
        meridianOffer(request(FIRST_PRICES_AT, 2)),
      ])
      expect((await down.writer.meta())?.stats).toMatchObject({ playstationOfferCount: 3 })
      // The stage stopped, at the first refusal or the third failure, and asked no more.
      expect(down.sonyRequests).toHaveLength(requests)
      expect(without.stores?.playstation).toMatchObject({
        status: 'read',
        pricesRead: 0,
        removed: 0,
        failed: requests,
        requests,
        offers: 3,
        stopped: { reason },
      })
      // And the run says so, since its colour does not.
      expect(warnings(down)).toHaveLength(1)
      expect(warnings(up)).toEqual([])
    },
  )

  it('keeps silent for a day after a refusal, in every kind of run, and warns of it once', async () => {
    const { night, at } = await firstPrices()
    const day = later(at, 24 * HOUR)
    const until = later(day, 24 * HOUR)
    const refused = nextRun(night, day)
    refused.sonyAnswersWith({ status: 429 }, { times: Infinity })

    const report = await runJob(refused.deps, PRICES)

    expect(sent(refused)).toEqual([EVERY_PRICE[0]])
    expect(report.outcome?.published).toBe(true)
    expect(report.stores?.playstation).toMatchObject({
      stopped: { reason: 'refused' },
      refusedAt: day,
      silentUntil: until,
    })
    expect(warnings(refused)).toEqual([
      `::warning::PlayStation Store: Sony refused a request (HTTP 429), so nothing more was asked in this run, after 1 request, and no run asks anything before ${until} — every offer that was not read stands as it was`,
    ])
    expect(formatSummary(report)).toContain(
      `1 request; stopped: Sony refused a request (HTTP 429), refused at ${day}, silent until ${until} |`,
    )
    // The moment is beside the job's cursors, not in the version the run published.
    expect(await night.writer.getCursor(PLAYSTATION_REFUSED_CURSOR)).toBe(day)

    // Sony would answer again, and nobody asks: not the day's prices runs, not the night's run
    // between them, not the prices run a minute short of the twenty-four hours.
    for (const [after, options] of [
      [6 * HOUR, PRICES],
      [12 * HOUR, PRICES],
      [14 * HOUR, FULL],
      [18 * HOUR, PRICES],
      [24 * HOUR - MINUTE, PRICES],
    ] as const) {
      const silent = nextRun(night, later(day, after))
      const quiet = await runJob(silent.deps, options)

      expect(silent.sonyRequests, `${options.mode} at +${after / HOUR} h`).toHaveLength(0)
      expect(quiet.outcome?.published).toBe(true)
      expect(quiet.stores?.playstation).toMatchObject({
        status: 'silent',
        requests: 0,
        offers: 3,
        refusedAt: day,
        silentUntil: until,
      })
      expect(formatSummary(quiet)).toContain(
        `not read: Sony refused a request, refused at ${day}, silent until ${until}; 3 offers carried`,
      )
      // Said once, by the run that was refused.
      expect(warnings(silent)).toEqual([])
    }
    // The offers are still the ones the last answered run read.
    expect((await night.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])

    // A day after the refusal the next run asks again: the two games not asked about for two
    // days first, then the one the refusal came to.
    const again = nextRun(night, until)
    const answered = await runJob(again.deps, PRICES)
    expect(sent(again)).toEqual([EVERY_PRICE[1], EVERY_PRICE[2], EVERY_PRICE[0]])
    expect(answered.stores?.playstation).toMatchObject({ status: 'read', pricesRead: 3 })
    expect(answered.stores?.playstation).not.toHaveProperty('silentUntil')
    expect(await night.writer.getCursor(PLAYSTATION_REFUSED_CURSOR)).toBeNull()
    expect(warnings(again)).toEqual([])
  })

  it('remembers a refusal in a run that then publishes nothing', async () => {
    const { night, at } = await firstPrices()
    const day = later(at, 24 * HOUR)
    const refused = nextRun(night, day)
    refused.sonyAnswersWith({ status: 403 }, { times: Infinity })
    vi.spyOn(refused.writer, 'writeVersion').mockRejectedValue(new Error('the index is full'))

    const error = await runJob(refused.deps, PRICES).catch((caught: unknown) => caught)

    expect((error as { stage: string }).stage).toBe('publish')
    vi.restoreAllMocks()
    // No version, no metadata of this run — and the next run knows all the same.
    const next = nextRun(night, later(day, 6 * HOUR))
    const report = await runJob(next.deps, PRICES)
    expect(next.sonyRequests).toHaveLength(0)
    expect(report.stores?.playstation).toMatchObject({ status: 'silent', refusedAt: day })
  })

  it('stops the night’s mapping at a refusal as well, and silences the day that follows', async () => {
    const night = createJobHarness({ start: RUN_AT, playstation: true })
    night.sonyAnswersWith({ status: 403 }, { times: Infinity })

    const report = await runJob(night.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(night.sonyRequests).toHaveLength(1)
    expect(report.stores?.playstation).toMatchObject({
      asks: 'mappings',
      mapped: 0,
      unmapped: 3,
      stopped: { reason: 'refused' },
      refusedAt: RUN_AT,
    })
    const until = later(RUN_AT, 24 * HOUR)
    expect(warnings(night)).toEqual([
      `::warning::PlayStation Store: Sony refused a request (HTTP 403), so nothing more was asked in this run, after 1 request, and no run asks anything before ${until} — every title that was not answered about waits for another night`,
    ])

    // The next night comes a day later to the minute, and maps what the refusal left.
    const nextNight = nextRun(night, until)
    const mapped = await runJob(nextNight.deps, FULL)
    expect(nextNight.sonyRequests.map((entry) => entry.kind)).toEqual([
      'concept',
      'concept',
      'concept',
    ])
    expect(mapped.stores?.playstation).toMatchObject({ status: 'read', mapped: 3, unmapped: 0 })
  })

  it('writes no warning in a run that read everything, or had nothing due', async () => {
    const { night, prices, at } = await firstPrices()
    expect(warnings(night)).toEqual([])
    expect(warnings(prices)).toEqual([])

    const idle = nextRun(night, later(at, 6 * HOUR))
    await runJob(idle.deps, PRICES)
    expect(warnings(idle)).toEqual([])
  })

  it('keeps Sony’s own words out of the log, whatever it answers', async () => {
    const { night, at } = await firstPrices()
    const run = nextRun(night, later(at, 24 * HOUR))
    run.sonyAnswersWith(
      { status: 200, body: { errors: [{ message: 'a\n::error::injected', extensions: {} }] } },
      { times: Infinity },
    )

    await runJob(run.deps, PRICES)

    expect(run.logs.join('\n')).not.toContain('injected')
    expect(warnings(run)).toEqual([
      '::warning::PlayStation Store: 3 requests in a row failed, so nothing more was asked in this run, after 3 requests — every offer that was not read stands as it was',
    ])
  })

  it('asks Sony nothing in a run Steam has already failed', async () => {
    const { night, at } = await firstPrices()
    const failing = nextRun(night, later(at, 24 * HOUR))
    for (const appId of Object.values(JOB_APP_IDS)) failing.failPriceChunkWith(appId)

    const error = await runJob(failing.deps, PRICES).catch((caught: unknown) => caught)

    expect((error as { stage: string }).stage).toBe('prices')
    expect((error as { report: JobReport }).report.stores?.playstation).toBeNull()
    expect(failing.sonyRequests).toHaveLength(0)
  })
})

describe('runJob over what the build before the PlayStation Store published', () => {
  /**
   * A version as the build before this one left it: the mapping written for GOG and the Xbox
   * store alone, documents and metadata with nothing of this store — and RAWG listing four of
   * the games on the PlayStation Store all along.
   */
  async function publishedByThePreviousBuild(): Promise<JobHarness> {
    const before = createJobHarness({ start: RUN_AT })
    await runJob(before.deps, FULL)
    const games = (await before.writer.allGames()).map((game) =>
      [101, 103, 106, 108].includes(game.id)
        ? { ...game, stores: [...game.stores, 'playstation-store'] }
        : game,
    )
    const meta = (await before.writer.meta())!
    delete meta.stats?.playstationOfferCount

    const writer = createMemoryGameIndex()
    await writer.setAppIds(Object.entries(JOB_APP_IDS).map(([id, appId]) => [Number(id), appId]))
    await writer.setStoreRefs(await before.writer.getStoreRefs(games.map((game) => game.id)))
    const version = await writer.beginVersion()
    await writer.writeVersion(version, games)
    await writer.publish(version, { ...meta, version })
    return createJobHarness({ writer, start: RUN_AT, playstation: true })
  }

  it('refreshes prices over it, with nothing to ask Sony and nothing lost', async () => {
    const old = await publishedByThePreviousBuild()
    const morning = nextRun(old, later(RUN_AT, 6 * HOUR))

    const report = await runJob(morning.deps, PRICES)

    expect(report.outcome?.published).toBe(true)
    expect(morning.sonyRequests).toHaveLength(0)
    expect(report.stores).toMatchObject({
      // Four games are listed on a store their record says nothing about: the sweep's work, at
      // night. Only 109, on the Xbox store alone, has been asked about everything.
      references: { listed: 5, asked: 1, gog: 1, microsoft: 1, playstation: 0 },
      playstation: { status: 'no-references', references: 0, requests: 0 },
    })
    // The GOG offer of a game that is now waiting to be asked about another store stands.
    expect((await morning.writer.getOne(101))?.offers).toHaveLength(1)
    expect((await morning.writer.getOne(106))?.priceUah).toBe(599)
  })

  it('sweeps it on the next full run: one RAWG request for each game listed on the store', async () => {
    const old = await publishedByThePreviousBuild()
    const nextNight = nextRun(old, later(RUN_AT, 24 * HOUR))

    const report = await runJob(nextNight.deps, FULL)

    expect(nextNight.storeCalls().map((call) => call.path)).toEqual([
      'games/hollow-cradle/stores',
      'games/paper-harbour/stores',
      'games/amber-trail/stores',
      'games/silent-meridian/stores',
    ])
    expect(report.stores?.references).toMatchObject({
      listed: 5,
      asked: 5,
      playstation: 3,
      sweep: { attempted: 4, failures: 0, remaining: 0 },
    })
    // And the same run asks Sony about the three titles the sweep found.
    expect(report.stores?.playstation).toMatchObject({ mappingsRead: 3, mapped: 3 })
    // The reference the mapping already held is as it was, beside the new one.
    expect((await nextNight.writer.getStoreRefs([101])).get(101)).toMatchObject({
      gog: 'hollow_cradle',
      playstation: { titleId: 'PPSA10100_00', conceptId: 10_101 },
    })
    expect((await nextNight.writer.getOne(101))?.offers).toHaveLength(1)
  })
})

describe('runJob and the PlayStation Store, through the Upstash adapter', () => {
  const adapterRun = (
    redis: ReturnType<typeof createFakeRedis>,
    runId: string,
    start: string,
  ): JobHarness =>
    createJobHarness({ start, playstation: true, writer: createUpstashIndex(redis, { runId }) })

  it('keeps what Sony said in the permanent mapping, and publishes offers a reader finds', async () => {
    const redis = createFakeRedis()
    const reader = createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 })

    await runJob(adapterRun(redis, 'the-full-run', RUN_AT).deps, FULL)

    // One key for each game RAWG lists on one of the stores, as before this store was read.
    expect(
      redis
        .keys()
        .filter((key) => key.startsWith('storeref:'))
        .sort(),
    ).toEqual(['storeref:101', 'storeref:103', 'storeref:106', 'storeref:108', 'storeref:109'])

    const prices = adapterRun(redis, 'the-prices-run', FIRST_PRICES_AT)
    await runJob(prices.deps, PRICES)

    // The concepts, and the dates of the asking, were read back from the mapping: Sony is asked
    // for prices, not for titles, and not before the twenty hours.
    expect(sent(prices)).toEqual(EVERY_PRICE)
    expect(psOffers(await reader.getOne(106))).toEqual([amberOffer(request(FIRST_PRICES_AT, 1))])
    expect((await reader.meta())?.stats).toMatchObject({ playstationOfferCount: 3 })
  })

  it('adds a command for each request to Sony, and one for each answer it has to remember', async () => {
    /** What the night and the first prices run after it cost the index, with Sony up or refusing. */
    async function traffic(sonyAnswers: boolean) {
      const redis = createFakeRedis()
      const night = adapterRun(redis, 'the-full-run', RUN_AT)
      if (!sonyAnswers) night.sonyAnswersWith({ status: 403 }, { times: Infinity })
      const full = (await runJob(night.deps, FULL)).writes!

      const morning = adapterRun(redis, 'the-prices-run', FIRST_PRICES_AT)
      const prices = (await runJob(morning.deps, PRICES)).writes!
      return { full, prices }
    }
    const asking = await traffic(true)
    const refused = await traffic(false)

    // The night: three dates of asking and three concepts, against the one date of the request
    // that was refused and the moment of the refusal. Each a command in a request of its own;
    // and each world looks once for a refusal to keep silent after.
    expect(asking.full.requests - refused.full.requests).toBe(4)
    expect(asking.full.commands - refused.full.commands).toBe(4)
    // The prices run: three dates of asking, where the refused world keeps silent, and would
    // have no concept to ask about if it did not.
    expect(asking.prices.requests - refused.prices.requests).toBe(3)
    expect(asking.prices.commands - refused.prices.commands).toBe(3)
  })
})

describe('formatSummary and the PlayStation Store', () => {
  it('gains a row for the store in the nightly run, and names it among the references', async () => {
    const harness = createJobHarness({ start: RUN_AT, playstation: true })

    const summary = formatSummary(await runJob(harness.deps, FULL))

    expect(summary).toContain(
      '| Store references | 5 of 9 games on GOG, the Xbox store or the PlayStation Store at RAWG, 5 asked; 1 with a GOG page, 1 with a Microsoft Store product, 3 with a PlayStation title; RAWG: 2 lookups this run, 0 failed, 0 left for the next full run |',
    )
    expect(summary).toContain(
      '| PlayStation Store prices | 3 references, 3 mapped to a concept, 0 with none, 0 waiting to be; 3 titles answered about of 3 due, 0 of them with no concept, 0 failed; prices are read by the prices runs: 0 offers carried, no price to date; 3 requests; everything due was asked |',
    )
    expect(harness.logs.filter((line) => line.startsWith('playstation:'))).toEqual([
      'playstation: 3 references; 3 titles answered about of 3 due, 0 of them with no concept, 0 failed, in 3 requests',
    ])
  })

  it('says what a prices run read, and how old the oldest price is', async () => {
    const { night, prices, at } = await firstPrices()

    expect(prices.logs.filter((line) => line.startsWith('playstation:'))).toEqual([
      'playstation: 3 references; 3 prices read of 3 due, 0 offers removed, 0 failed, in 3 requests',
    ])
    const idle = nextRun(night, later(at, 6 * HOUR))
    expect(formatSummary(await runJob(idle.deps, PRICES))).toContain(
      '| PlayStation Store prices | 3 references, 3 mapped to a concept, 0 with none, 0 waiting to be; 0 prices read of 0 due, 0 removed, 0 failed; 3 offers published, the oldest read 6 h ago; 0 requests; everything due was asked |',
    )
  })

  it('says when no game has a title', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    expect(formatSummary(await runJob(harness.deps, FULL))).toContain(
      '| PlayStation Store prices | no references, nothing to read |',
    )
  })

  const base: JobReport = {
    mode: 'prices',
    dryRun: false,
    outcome: null,
    studios: null,
    pricesFetched: 0,
    languagesFetched: 0,
    failures: 0,
    durationMs: 1_000,
    writes: null,
  }
  const read: NonNullable<StoresReport['playstation']> = {
    status: 'read',
    asks: 'prices',
    references: 810,
    mapped: 640,
    withoutConcept: 60,
    unmapped: 110,
    due: 300,
    pricesRead: 220,
    mappingsRead: 0,
    noConcept: 0,
    removed: 3,
    failed: 2,
    requests: 225,
    concepts: 610,
    offers: 598,
    oldestPriceAgeMs: 31 * HOUR + 59 * MINUTE,
    oldestShownPriceAgeMs: 31 * HOUR + 59 * MINUTE,
    stopped: null,
  }
  const MAPPING = '810 references, 640 mapped to a concept, 60 with none, 110 waiting to be'
  const rowOf = (playstation: Partial<NonNullable<StoresReport['playstation']>> | null) =>
    formatSummary({
      ...base,
      stores: {
        references: {
          games: 3_400,
          listed: 2_400,
          asked: 2_400,
          gog: 410,
          microsoft: 380,
          playstation: 810,
          sweep: null,
        },
        gog: null,
        microsoft: null,
        rate: null,
        playstation: playstation === null ? null : { ...read, ...playstation },
      },
    })

  it('says why the stage stopped, in every way it can', () => {
    expect(rowOf(null)).not.toContain('PlayStation Store prices')
    expect(
      rowOf({ stopped: { reason: 'requests', detail: 'the run has made its 225 requests' } }),
    ).toContain(
      `| PlayStation Store prices | ${MAPPING}; 220 prices read of 300 due, 3 removed, 2 failed; 598 offers published, the oldest read 31 h ago; 225 requests; stopped at its requests for one run, the rest waits for the next |`,
    )
    expect(
      rowOf({ stopped: { reason: 'time', detail: 'the run has used its forty minutes' } }),
    ).toContain('225 requests; stopped at its forty minutes, the rest waits for the next run |')
    expect(
      rowOf({
        stopped: { reason: 'refused', detail: 'HTTP 403' },
        refusedAt: '2026-10-13T06:20:00.000Z',
        silentUntil: '2026-10-14T06:20:00.000Z',
      }),
    ).toContain(
      '225 requests; stopped: Sony refused a request (HTTP 403), refused at 2026-10-13T06:20:00.000Z, silent until 2026-10-14T06:20:00.000Z |',
    )
    expect(
      rowOf({ stopped: { reason: 'failures', detail: '3 requests in a row failed' } }),
    ).toContain('225 requests; stopped: 3 requests in a row failed |')
  })

  it('says what the nightly run mapped, and that it reads no price', () => {
    const night = {
      asks: 'mappings',
      due: 170,
      mappingsRead: 168,
      noConcept: 17,
      pricesRead: 0,
      removed: 0,
      requests: 170,
    } as const
    expect(rowOf(night)).toContain(
      `| PlayStation Store prices | ${MAPPING}; 168 titles answered about of 170 due, 17 of them with no concept, 2 failed; prices are read by the prices runs: 598 offers carried, the oldest read 31 h ago; 170 requests; everything due was asked |`,
    )
    // A night with more waiting than it asks about says how many it left.
    expect(
      rowOf({ ...night, due: 460, mappingsRead: 198, requests: 200, heldOver: 260 }),
    ).toContain(
      '198 titles answered about of 460 due, 17 of them with no concept, 2 failed; prices are read by the prices runs: 598 offers carried, the oldest read 31 h ago; 200 requests; the 200 titles of one night were asked about, 260 wait for another night |',
    )
  })

  it('says, in a run that keeps silent after a refusal, when it was and until when', () => {
    expect(
      rowOf({
        status: 'silent',
        requests: 0,
        refusedAt: '2026-10-13T06:20:00.000Z',
        silentUntil: '2026-10-14T06:20:00.000Z',
        dropped: 2,
      }),
    ).toContain(
      `| PlayStation Store prices | ${MAPPING}; not read: Sony refused a request, refused at 2026-10-13T06:20:00.000Z, silent until 2026-10-14T06:20:00.000Z; 598 offers carried, the oldest read 31 h ago; 2 offers dropped because their games no longer have a store reference |`,
    )
  })

  it('says when a run of its kind does not ask, and when a run is going to be refused', () => {
    expect(rowOf({ status: 'not-in-this-run', asks: 'nothing', requests: 0 })).toContain(
      `| PlayStation Store prices | ${MAPPING}; not read in this kind of run; 598 offers carried, the oldest read 31 h ago |`,
    )
    expect(
      rowOf({ status: 'run-refused', requests: 0, error: 'the run priced no games | at\nall' }),
    ).toContain(
      `${MAPPING}; not read: the run is going to be refused publication (the run priced no games / at all); 598 offers carried, the oldest read 31 h ago |`,
    )
  })

  it('says what a floor saw, and what the mapping cost, without breaking the table', () => {
    expect(
      rowOf({ status: 'failed', removed: 0, error: 'asked about 40 | and\n30 would go' }),
    ).toContain('225 requests; everything due was asked (asked about 40 / and 30 would go) |')
    expect(
      rowOf({ status: 'references-lost', error: 'carried 600, the mapping names 12', dropped: 4 }),
    ).toContain(
      `| PlayStation Store prices | ${MAPPING}; not read (carried 600, the mapping names 12); 598 offers kept as they were, the oldest read 31 h ago; the next run looks again; 4 offers dropped because their games no longer have a store reference |`,
    )
    expect(rowOf({ dropped: 1 })).toContain(
      'everything due was asked; 1 offer dropped because its game no longer has a store reference |',
    )
    expect(rowOf({ offers: 0, oldestPriceAgeMs: null })).toContain(
      '0 offers published, no price to date;',
    )
    expect(rowOf({ oldestPriceAgeMs: 59 * MINUTE })).toContain('the oldest read under an hour ago;')
  })
})
