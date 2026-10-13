import { describe, expect, it } from 'vitest'
import { PLAYSTATION_PAUSE_MS } from '../../../scripts/index/playstation'
import {
  formatSummary,
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
 * about what each run of the job does with them, and what a run does when Sony will not answer.
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

/** A first full run with the PlayStation Store listed, published. */
async function firstNight(): Promise<JobHarness> {
  const harness = createJobHarness({ start: RUN_AT, playstation: true })
  await runJob(harness.deps, FULL)
  return harness
}

const nextRun = (previous: JobHarness, start: string) =>
  createJobHarness({ writer: previous.writer, start, playstation: true })

/** The night, then the prices run six hours on, which reads the three prices. */
async function firstMorning(): Promise<{ night: JobHarness; morning: JobHarness; at: string }> {
  const night = await firstNight()
  const at = later(RUN_AT, 6 * HOUR)
  const morning = nextRun(night, at)
  await runJob(morning.deps, PRICES)
  return { night, morning, at }
}

const sent = (harness: JobHarness) =>
  harness.sonyRequests.map((entry) => `${entry.kind} ${entry.id}`)
const EVERY_PRICE = [101, 106, 108].map(
  (id) => `price ${JOB_PLAYSTATION_CONCEPTS[id as keyof typeof JOB_PLAYSTATION_CONCEPTS]}`,
)

describe('runJob and the PlayStation Store', () => {
  it('finds the titles with a full run, and asks Sony which concepts they belong to', async () => {
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
    // Sony: the three titles, the most popular game first, ten seconds apart. No price yet — a
    // game mapped by one run is priced by the next.
    expect(sent(harness)).toEqual([
      `concept ${JOB_PLAYSTATION_TITLES[101]}`,
      `concept ${JOB_PLAYSTATION_TITLES[106]}`,
      `concept ${JOB_PLAYSTATION_TITLES[108]}`,
    ])
    const left = harness.sonyRequests.map((entry) => entry.at)
    expect([left[1]! - left[0]!, left[2]! - left[1]!]).toEqual([10_000, 10_000])
    expect(report.stores?.playstation).toEqual({
      status: 'read',
      references: 3,
      mapped: 3,
      unmapped: 0,
      due: 0,
      pricesRead: 0,
      mappingsRead: 3,
      removed: 0,
      failed: 0,
      requests: 3,
      offers: 0,
      stopped: null,
    })
    expect(await harness.writer.getStoreRefs([101, 103, 106, 108])).toEqual(
      new Map([
        [
          101,
          { gog: 'hollow_cradle', playstation: { titleId: 'PPSA10100_00', conceptId: 10_101 } },
        ],
        // Listed there, asked, and the link is a PlayStation 3 product: no reference.
        [103, { playstation: null }],
        [106, { playstation: { titleId: 'CUSA10600_00', conceptId: 10_106 } }],
        [108, { playstation: { titleId: 'PPSA10800_00', conceptId: 10_108 } }],
      ]),
    )
    expect(psOffers(await harness.writer.getOne(106))).toEqual([])
    expect((await harness.writer.meta())?.stats).toMatchObject({ playstationOfferCount: 0 })
    // The other stores were read as on any night, and are none the worse for this one.
    expect(report.stores).toMatchObject({ gog: { status: 'read' }, microsoft: { status: 'read' } })
    expect((await harness.writer.getOne(101))?.offers).toHaveLength(1)
  })

  it('reads the prices with the next run, and publishes them beside the other stores’', async () => {
    const { morning, at } = await firstMorning()

    // RAWG is asked nothing by a prices run, and Sony only for the three prices.
    expect(morning.calls).toHaveLength(0)
    expect(sent(morning)).toEqual(EVERY_PRICE)
    expect(await morning.writer.getOne(106)).toMatchObject({
      // Steam's price is where it always was.
      priceUah: 599,
      steamAppId: '416000',
      offers: [amberOffer(request(at, 1))],
    })
    // Each is dated by its own answer, ten seconds after the one before.
    expect((await morning.writer.getOne(108))?.offers).toEqual([meridianOffer(request(at, 2))])
    // And stands after the offers the game already had, in the stores' own order.
    expect((await morning.writer.getOne(101))?.offers).toEqual([
      expect.objectContaining({ store: 'gog', updatedAt: RUN_AT }),
      hollowOffer(at),
    ])
    const meta = await morning.writer.meta()
    expect(meta?.stats).toMatchObject({
      playstationOfferCount: 3,
      gogOfferCount: 1,
      microsoftOfferCount: 1,
    })
    // The store has no stamp of its own; the other two keep theirs.
    expect(meta?.offersReadAt).toEqual({ gog: RUN_AT, 'xbox-store': RUN_AT })
    // The version is published when the stage is over, twenty seconds in.
    expect(meta?.updatedAt).toBe(request(at, 2))
  })

  // The job's tests and the site's tests each read their own fixtures; this is the one place
  // what the job really writes for this store is put through what the site really reads.
  it('writes offers that the site reads as they stand', async () => {
    const { morning, at } = await firstMorning()
    const now = later(at, 5 * MINUTE)
    const rate = exchangeRateAt(await morning.writer.meta(), now)

    const amber = (await morning.writer.getOne(106))!
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

    const meridian = (await morning.writer.getOne(108))!
    expect(readableOffers(meridian)).toEqual(meridian.offers)
    expect(toStoreOffer(readableOffers(meridian)[0]!, rate)).toMatchObject({
      title: 'Silent Meridian: Deluxe Edition',
      priceUah: 1299,
      regularPriceUah: null,
      discountPercent: 0,
    })

    // Both of a game's offers are read, each of its own store.
    const hollow = (await morning.writer.getOne(101))!
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
    const { morning, at } = await firstMorning()
    const now = later(at, 5 * MINUTE)
    const rate = exchangeRateAt(await morning.writer.meta(), now)
    const terms = { now, rate }

    // RAWG lists the game on the store, the offer is readable and fresh, and it is far below
    // Steam's price: every reason the other stores' rules would have to show and name it.
    const amber = (await morning.writer.getOne(106))!
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
    const hollow = (await morning.writer.getOne(101))!
    const without = { ...hollow, offers: hollow.offers!.filter((offer) => offer.store === 'gog') }
    expect(psOffers(hollow)[0]).toMatchObject({ amount: 0 })
    expect(pageOffers(hollow)).toEqual(without.offers)
    expect(toGame(hollow, terms)).toEqual(toGame(without, terms))
    expect(toGame(hollow, terms).stores.map((row) => row.store)).toEqual(['steam', 'gog'])
    expect(cheaperAtOf(hollow, now, rate)).toBe(cheaperAtOf(without, now, rate))
  })

  it('does not ask about a game again before twenty hours have passed', async () => {
    const { night, at } = await firstMorning()

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

    // The prices were read ten seconds apart: twenty hours on, to the second, the first of them
    // is due and the other two are not yet.
    const due = later(at, 20 * HOUR)
    const next = nextRun(night, due)
    await runJob(next.deps, PRICES)

    expect(sent(next)).toEqual([`price ${JOB_PLAYSTATION_CONCEPTS[101]}`])
    expect(psOffers(await next.writer.getOne(101))).toEqual([hollowOffer(due)])
    expect((await next.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])
  })

  it('carries the offers through a full run, which maps every document afresh from RAWG', async () => {
    const { night, at } = await firstMorning()
    const nextNight = nextRun(night, later(at, 15 * HOUR))

    const report = await runJob(nextNight.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    expect(nextNight.sonyRequests).toHaveLength(0)
    expect(nextNight.storeCalls()).toHaveLength(0)
    expect((await nextNight.writer.getOne(106))?.offers).toEqual([amberOffer(request(at, 1))])
    expect(report.stores?.playstation).toMatchObject({ references: 3, mapped: 3, offers: 3 })
  })

  it('reads them in a languages run too, when that is the run that finds them due', async () => {
    const { night, at } = await firstMorning()
    const weekly = nextRun(night, later(at, 26 * HOUR))

    const report = await runJob(weekly.deps, LANGUAGES)

    expect(report.outcome?.published).toBe(true)
    expect(weekly.priceBatches).toHaveLength(0)
    expect(sent(weekly)).toEqual(EVERY_PRICE)
    expect(psOffers(await weekly.writer.getOne(101))).toEqual([hollowOffer(later(at, 26 * HOUR))])
  })

  it('removes the offer of a game Sony stops pricing, and asks about it a day later', async () => {
    const { night, at } = await firstMorning()
    const day = later(at, 24 * HOUR)
    const gone = nextRun(night, day)
    gone.sonyPrices[JOB_PLAYSTATION_CONCEPTS[106]] = sonyPrice(JOB_PLAYSTATION_CONCEPTS[106], null)

    const report = await runJob(gone.deps, PRICES)

    expect(report.stores?.playstation).toMatchObject({ pricesRead: 2, removed: 1, offers: 2 })
    expect(psOffers(await gone.writer.getOne(106))).toEqual([])
    expect((await gone.writer.getStoreRefs([106])).get(106)).toEqual({
      playstation: { titleId: 'CUSA10600_00', conceptId: 10_106, unpricedAt: request(day, 1) },
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
      // Two worlds from the same morning; a day on, one of them finds Sony like this.
      const day = later(RUN_AT, 30 * HOUR)
      const up = nextRun((await firstMorning()).night, day)
      const down = nextRun((await firstMorning()).night, day)
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
      const read = later(RUN_AT, 6 * HOUR)
      expect((await up.writer.getOne(106))?.offers).toEqual([amberOffer(request(day, 1))])
      expect((await down.writer.getOne(106))?.offers).toEqual([amberOffer(request(read, 1))])
      expect((await down.writer.getOne(108))?.offers).toEqual([meridianOffer(request(read, 2))])
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

  it('stops at the first refusal: one request, and no more until the next run', async () => {
    const { night, at } = await firstMorning()
    const refused = nextRun(night, later(at, 24 * HOUR))
    refused.sonyAnswersWith({ status: 429 }, { times: Infinity })

    await runJob(refused.deps, PRICES)

    expect(sent(refused)).toEqual([`price ${JOB_PLAYSTATION_CONCEPTS[101]}`])
    expect(warnings(refused)).toEqual([
      '::warning::PlayStation Store prices: Sony refused a request (HTTP 429), so nothing more was asked in this run, after 1 request — every offer that was not read stands as it was',
    ])

    // The next run asks again, from the oldest.
    const after = nextRun(night, later(at, 30 * HOUR))
    await runJob(after.deps, PRICES)
    expect(sent(after)).toEqual(EVERY_PRICE)
  })

  it('writes no warning in a run that read everything, or had nothing due', async () => {
    const { night, morning, at } = await firstMorning()
    expect(warnings(night)).toEqual([])
    expect(warnings(morning)).toEqual([])

    const idle = nextRun(night, later(at, 6 * HOUR))
    await runJob(idle.deps, PRICES)
    expect(warnings(idle)).toEqual([])
  })

  it('keeps Sony’s own words out of the log, whatever it answers', async () => {
    const { night, at } = await firstMorning()
    const run = nextRun(night, later(at, 24 * HOUR))
    run.sonyAnswersWith(
      { status: 200, body: { errors: [{ message: 'a\n::error::injected', extensions: {} }] } },
      { times: Infinity },
    )

    await runJob(run.deps, PRICES)

    expect(run.logs.join('\n')).not.toContain('injected')
    expect(warnings(run)).toEqual([
      '::warning::PlayStation Store prices: 3 requests in a row failed, so nothing more was asked in this run, after 3 requests — every offer that was not read stands as it was',
    ])
  })

  it('asks Sony nothing in a run Steam has already failed', async () => {
    const { night, at } = await firstMorning()
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
    expect((await nextNight.writer.getStoreRefs([101])).get(101)).toEqual({
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

    const at = later(RUN_AT, 6 * HOUR)
    const morning = adapterRun(redis, 'the-prices-run', at)
    await runJob(morning.deps, PRICES)

    // The concepts were read back from the mapping: Sony is asked for prices, not for titles.
    expect(sent(morning)).toEqual(EVERY_PRICE)
    expect(psOffers(await reader.getOne(106))).toEqual([amberOffer(request(at, 1))])
    expect((await reader.meta())?.stats).toMatchObject({ playstationOfferCount: 3 })
  })

  it('adds one command to a run that maps titles, and none to a run that reads prices', async () => {
    /** What a full run and the prices run after it cost the index, with Sony up or refusing. */
    async function traffic(sonyAnswers: boolean) {
      const redis = createFakeRedis()
      const night = adapterRun(redis, 'the-full-run', RUN_AT)
      if (!sonyAnswers) night.sonyAnswersWith({ status: 403 }, { times: Infinity })
      const full = (await runJob(night.deps, FULL)).writes!

      const morning = adapterRun(redis, 'the-prices-run', later(RUN_AT, 6 * HOUR))
      if (!sonyAnswers) morning.sonyAnswersWith({ status: 403 }, { times: Infinity })
      const prices = (await runJob(morning.deps, PRICES)).writes!
      return {
        full,
        prices,
        mapped: sonyAnswers ? await night.writer.getStoreRefs([101, 106, 108]) : null,
      }
    }
    const asking = await traffic(true)
    const refused = await traffic(false)

    // The three titles Sony mapped are one `MSET`, in one request.
    expect(asking.full.requests - refused.full.requests).toBe(1)
    expect(asking.full.commands - refused.full.commands).toBe(1)
    const written = [...asking.mapped!].reduce(
      (bytes, [id, refs]) => bytes + `storeref:${id}`.length + JSON.stringify(refs).length,
      0,
    )
    expect(asking.full.bytes - refused.full.bytes).toBeGreaterThanOrEqual(written)
    expect(asking.full.bytes - refused.full.bytes).toBeLessThan(written + 64)

    // The prices run after it: Sony mapped nothing in the refused world, so it has nothing to
    // price there; in the other, three offers are on the documents and nothing else was sent.
    expect(asking.prices.requests).toBe(refused.prices.requests)
    expect(asking.prices.commands).toBe(refused.prices.commands)
    expect(asking.prices.bytes).toBeGreaterThan(refused.prices.bytes)
  })
})

describe('formatSummary and the PlayStation Store', () => {
  it('gains a row for the store, and names it among the references', async () => {
    const harness = createJobHarness({ start: RUN_AT, playstation: true })

    const summary = formatSummary(await runJob(harness.deps, FULL))

    expect(summary).toContain(
      '| Store references | 5 of 9 games on GOG, the Xbox store or the PlayStation Store at RAWG, 5 asked; 1 with a GOG page, 1 with a Microsoft Store product, 3 with a PlayStation title; RAWG: 2 lookups this run, 0 failed, 0 left for the next full run |',
    )
    expect(summary).toContain(
      '| PlayStation Store prices | 3 references, 3 mapped to a concept, 0 waiting to be; 0 prices read of 0 due, 0 removed, 3 titles mapped, 0 failed; 0 offers published, 3 requests; everything due was asked |',
    )
  })

  it('says in the log what a prices run read', async () => {
    const { morning } = await firstMorning()

    expect(morning.logs.filter((line) => line.startsWith('playstation:'))).toEqual([
      'playstation: 3 references; 3 prices read of 3 due, 0 offers removed, 0 titles mapped, 0 failed, in 3 requests',
    ])
  })

  it('says when no game has a title, and nothing for a run that never reached the store', async () => {
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
    references: 810,
    mapped: 640,
    unmapped: 110,
    due: 300,
    pricesRead: 220,
    mappingsRead: 0,
    removed: 3,
    failed: 2,
    requests: 225,
    offers: 598,
    stopped: null,
  }
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
      '| PlayStation Store prices | 810 references, 640 mapped to a concept, 110 waiting to be; 220 prices read of 300 due, 3 removed, 0 titles mapped, 2 failed; 598 offers published, 225 requests; stopped at its requests for one run, the rest waits for the next |',
    )
    expect(
      rowOf({ stopped: { reason: 'time', detail: 'the run has used its forty minutes' } }),
    ).toContain('225 requests; stopped at its forty minutes, the rest waits for the next run |')
    expect(rowOf({ stopped: { reason: 'refused', detail: 'HTTP 403' } })).toContain(
      '225 requests; stopped: Sony refused a request (HTTP 403) |',
    )
    expect(
      rowOf({ stopped: { reason: 'failures', detail: '3 requests in a row failed' } }),
    ).toContain('225 requests; stopped: 3 requests in a row failed |')
  })

  it('says what the floor saw, and what the mapping cost, without breaking the table', () => {
    expect(
      rowOf({ status: 'failed', removed: 0, error: 'asked about 40 | and\n30 would go' }),
    ).toContain('225 requests; everything due was asked (asked about 40 / and 30 would go) |')
    expect(
      rowOf({ status: 'references-lost', error: 'carried 600, the mapping names 12', dropped: 4 }),
    ).toContain(
      '| PlayStation Store prices | 810 references, not read (carried 600, the mapping names 12); 598 offers kept as they were; the next run looks again; 4 offers dropped because their games no longer have a store reference |',
    )
    expect(rowOf({ dropped: 1 })).toContain(
      'everything due was asked; 1 offer dropped because its game no longer has a store reference |',
    )
  })
})
