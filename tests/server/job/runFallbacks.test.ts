import { describe, expect, it } from 'vitest'
import {
  formatSummary,
  runJob,
  storeWarnings,
  type JobReport,
  type StoresReport,
} from '../../../scripts/index/run'
import type { StoreReadReport } from '../../../scripts/index/offers'
import { offerWay } from '../../../server/index/document'
import { exchangeRateAt, isFreshOffer, readableOffers } from '../../../server/index/offerRules'
import { toStoreOffer } from '../../../server/index/toGraphql'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { UpstreamError } from '../../../server/upstream/errors'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import {
  gogPrice,
  gogProduct,
  JOB_MICROSOFT_ID,
  JOB_MICROSOFT_TITLE,
  microsoftDetail,
  microsoftProduct,
} from '../../fixtures/index/jobStores'
import { createFakeRedis } from '../index/fakeRedis'
import { createJobHarness, type JobHarness } from './harness'

/**
 * The whole job once RAWG's link is the first way to a product and not the only one: what a run
 * publishes when the link finds no price, what the site reads of it, what the next run does with
 * it, and what the summary and the annotations say. Game 101, "Hollow Cradle", has the GOG slug
 * `hollow_cradle`, which these worlds take out of GOG's catalog; game 109, "Lost Canton", has the
 * Microsoft product `9NLOSTCANT0N`, which they stop selling.
 */

const RUN_AT = '2026-10-13T03:00:00.000Z'
const HOUR = 3_600_000
const FULL = { mode: 'full', pages: JOB_PAGE_COUNT, forceUnlock: false } as const
const PRICES = { mode: 'prices', pages: 1, forceUnlock: false } as const

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
const SIBLING = '9N2S04LGXXH4'

/** A world in which both links lead nowhere, and each store sells the game under another product. */
function retired(harness: JobHarness): JobHarness {
  harness.gogCatalog.products = [
    gogProduct('amber_archive', gogPrice('4.99', '4.99')),
    gogProduct('hollow_cradle_complete', gogPrice('9.99', '19.99'), {
      productType: 'pack',
      title: 'Hollow Cradle - Complete Edition',
      releaseDate: '2022.06.01',
    }),
  ]
  Reflect.deleteProperty(harness.microsoftProducts, JOB_MICROSOFT_ID)
  harness.microsoftDetails[JOB_MICROSOFT_ID] = microsoftDetail(
    JOB_MICROSOFT_ID,
    JOB_MICROSOFT_TITLE,
    {
      group: 'canton',
      parents: ['9MW7MFV29CMF'],
    },
  )
  harness.microsoftDetails['9MW7MFV29CMF'] = microsoftDetail('9MW7MFV29CMF', 'Lost Canton', {
    group: 'canton',
    bundles: [JOB_MICROSOFT_ID, SIBLING],
  })
  harness.microsoftProducts[SIBLING] = microsoftProduct(SIBLING, 1199, 1199, JOB_MICROSOFT_TITLE, {
    group: 'canton',
    released: '2026-01-20T00:00:00.0000000Z',
  })
  return harness
}

describe('runJob and the stores’ own ways', () => {
  it('publishes what they found, and the site reads it as any other offer', async () => {
    const harness = retired(createJobHarness({ start: RUN_AT }))

    const report = await runJob(harness.deps, FULL)

    expect(report.outcome?.published).toBe(true)
    const meta = await harness.writer.meta()
    const rate = exchangeRateAt(meta, RUN_AT)
    const cradle = (await harness.writer.getOne(101))!
    const canton = (await harness.writer.getOne(109))!
    expect(cradle.offers).toEqual([
      {
        store: 'gog',
        via: 'edition',
        title: 'Hollow Cradle - Complete Edition',
        amount: 999,
        regularAmount: 1999,
        currency: 'USD',
        discountPercent: 50,
        url: 'https://www.gog.com/en/game/hollow_cradle_complete',
        updatedAt: RUN_AT,
      },
    ])
    expect(canton.offers).toEqual([
      {
        store: 'xbox-store',
        via: 'relation',
        title: JOB_MICROSOFT_TITLE,
        amount: 119_900,
        regularAmount: 119_900,
        currency: 'UAH',
        discountPercent: 0,
        url: 'https://www.microsoft.com/uk-ua/p/lost-canton-definitive-edition/9n2s04lgxxh4',
        updatedAt: RUN_AT,
      },
    ])
    // What the job wrote, through what the site reads: a price, fresh, with a row to show it in,
    // under the store's own title for the edition — and nothing on the row of how it was found.
    for (const game of [cradle, canton]) {
      expect(readableOffers(game)).toEqual(game.offers)
      for (const offer of readableOffers(game)) {
        expect(isFreshOffer(offer, RUN_AT)).toBe(true)
        const row = toStoreOffer(offer, rate)
        expect(row).toMatchObject({ url: offer.url, title: offer.title })
        expect(row).not.toHaveProperty('via')
      }
    }
    expect(meta?.stats).toMatchObject({ gogOfferCount: 1, microsoftOfferCount: 1 })
    expect(report.stores).toMatchObject({
      gog: { status: 'read', pricesRead: 1, otherWays: { edition: 1 } },
      microsoft: {
        status: 'read',
        pricesRead: 0,
        offers: 1,
        otherWays: { relation: 1 },
        fallbacks: { searched: 1, found: { relation: 1 }, waiting: 0, requests: 3 },
      },
    })
    // The full run asked RAWG what it always asks, and the ways asked it nothing.
    expect(harness.storeCalls()).toHaveLength(8)
  })

  it('prices what they found directly in the next run, and asks RAWG and the search nothing', async () => {
    const night = retired(createJobHarness({ start: RUN_AT }))
    await runJob(night.deps, FULL)

    const noon = later(RUN_AT, 12 * HOUR)
    const midday = retired(createJobHarness({ start: noon, writer: night.writer }))
    // The sale price of the product found last night.
    midday.microsoftProducts[SIBLING] = microsoftProduct(SIBLING, 599.5, 1199, JOB_MICROSOFT_TITLE)
    const report = await runJob(midday.deps, PRICES)

    expect(report.outcome?.published).toBe(true)
    expect(midday.calls).toHaveLength(0)
    expect(midday.microsoftBatches).toEqual([[JOB_MICROSOFT_ID, SIBLING]])
    expect(midday.microsoftDetailBatches).toEqual([])
    expect(midday.microsoftSearchNames).toEqual([])
    expect((await midday.writer.getOne(109))?.offers?.[0]).toMatchObject({
      via: 'relation',
      amount: 59_950,
      updatedAt: noon,
    })
    expect((await midday.writer.getOne(101))?.offers?.map(offerWay)).toEqual(['edition'])
    expect(report.stores?.microsoft).toMatchObject({ pricesRead: 1, otherWays: { relation: 1 } })
    expect(report.stores?.microsoft).not.toHaveProperty('fallbacks')
  })

  it('keeps what they found in the mapping, outside the version, through the Upstash adapter', async () => {
    const redis = createFakeRedis()
    const reader = createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 })
    const night = retired(
      createJobHarness({ start: RUN_AT, writer: createUpstashIndex(redis, { runId: 'night' }) }),
    )

    await runJob(night.deps, FULL)

    const refs = await night.writer.getStoreRefs([101, 109])
    expect(redis.keys()).toEqual(expect.arrayContaining(['storeref:101', 'storeref:109']))
    // RAWG's links and what the store's own ways found, side by side in one record.
    expect(refs.get(109)).toEqual({
      microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' },
      links: [
        [6, 'https://www.nintendo.com/store/products/lost-canton/'],
        [2, 'https://www.microsoft.com/en-us/p/lost-canton/9nlostcant0n?cid=msft_web_chart'],
      ],
      fallbacks: {
        microsoft: {
          searchedAt: RUN_AT,
          found: {
            id: SIBLING,
            name: 'lost-canton-definitive-edition',
            via: 'relation',
            foundAt: RUN_AT,
          },
        },
      },
    })
    expect(refs.get(101)).toEqual({
      gog: 'hollow_cradle',
      links: [
        [1, 'https://store.steampowered.com/app/411000/Hollow_Cradle/'],
        [5, 'https://www.gog.com/game/hollow_cradle'],
      ],
      fallbacks: { gog: { slug: 'hollow_cradle_complete', via: 'edition', foundAt: RUN_AT } },
    })
    expect((await reader.getOne(109))?.offers?.[0]?.via).toBe('relation')

    // The prices run six hours on reads the mapping and writes none of it.
    const morning = createJobHarness({
      start: later(RUN_AT, 6 * HOUR),
      writer: createUpstashIndex(redis, { runId: 'morning' }),
    })
    await runJob(morning.deps, PRICES)
    expect((await reader.getOne(109))?.offers?.[0]).toMatchObject({
      via: 'relation',
      updatedAt: RUN_AT,
    })
    expect((await reader.getOne(101))?.offers?.[0]).toMatchObject({
      via: 'edition',
      updatedAt: RUN_AT,
    })
  })

  it('says so in the summary, and warns when the store turned its ways away', async () => {
    const harness = retired(createJobHarness({ start: RUN_AT }))
    harness.failMicrosoftDetailsWith(
      JOB_MICROSOFT_ID,
      new UpstreamError('MICROSOFT', 'RATE_LIMITED', 429),
    )

    const report = await runJob(harness.deps, FULL)
    const summary = formatSummary(report)

    expect(report.outcome?.published).toBe(true)
    expect(summary).toContain(
      '| GOG prices | 1 reference, 1 price read, 0 failed; 1 offer published, 1 request; found by: edition 1; 1 searched for this run, 1 found (edition 1), 0 waiting |',
    )
    expect(summary).toContain(
      '| Microsoft Store prices | 1 reference, 0 prices read, 0 failed; 0 offers published, 1 request; 0 searched for this run in 1 request, 0 found, 1 waiting (stopped early: the store refused a request: MICROSOFT upstream failure: RATE_LIMITED (429)) |',
    )
    expect(harness.logs).toContain(
      "::warning::Microsoft Store: the store's own ways to a product stopped early in this run, the store refused a request (MICROSOFT upstream failure: RATE_LIMITED (429)) \u2014 1 game is left waiting for the next run that reads the store",
    )
  })
})

describe('formatSummary and storeWarnings and the stores’ own ways', () => {
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
  const references = {
    games: 3_400,
    listed: 1_700,
    asked: 1_700,
    gog: 1_204,
    microsoft: 1_162,
    playstation: 0,
    sweep: null,
  }
  const read: StoreReadReport = {
    status: 'read',
    references: 1_162,
    pricesRead: 296,
    failed: 0,
    requests: 12,
    offers: 395,
    lastReadAt: RUN_AT,
    otherWays: { relation: 12, name: 60, edition: 27 },
    fallbacks: {
      searched: 150,
      found: { relation: 12, name: 60, edition: 27 },
      waiting: 570,
      requests: 168,
    },
  }
  const stores = (
    microsoft: StoreReadReport,
    gog: StoreReadReport | null = null,
  ): StoresReport => ({
    references,
    gog,
    microsoft,
    rate: null,
    playstation: null,
  })

  it('counts each way the offers that stand were found by, and what the ways did this run', () => {
    const summary = formatSummary({
      ...base,
      stores: stores(read, {
        ...read,
        references: 1_204,
        pricesRead: 1_166,
        requests: 83,
        offers: 1_166,
        otherWays: { name: 30, edition: 25 },
        fallbacks: { searched: 93, found: { name: 30, edition: 25 }, waiting: 0, requests: 0 },
      }),
    })

    expect(summary).toContain(
      '| Microsoft Store prices | 1162 references, 296 prices read, 0 failed; 395 offers published, 12 requests; found by: link 296, relation 12, name 60, edition 27; 150 searched for this run in 168 requests, 99 found (relation 12, name 60, edition 27), 570 waiting |',
    )
    expect(summary).toContain(
      '| GOG prices | 1204 references, 1166 prices read, 0 failed; 1166 offers published, 83 requests; found by: link 1111, name 30, edition 25; 93 searched for this run, 55 found (name 30, edition 25), 0 waiting |',
    )
  })

  it('counts the ways in a run that read nothing too: the offers carried were found somehow', () => {
    const { fallbacks: _fallbacks, ...carried } = read
    const summary = formatSummary({
      ...base,
      stores: stores({ ...carried, status: 'not-due', pricesRead: 0, requests: 0 }),
    })

    expect(summary).toContain(
      `| Microsoft Store prices | 1162 references, not read: the last full read (${RUN_AT}) is under eleven hours old; 395 offers carried; found by: link 296, relation 12, name 60, edition 27 |`,
    )
  })

  it('says nothing of the ways while RAWG’s link found every offer and nobody waits', () => {
    const { otherWays: _ways, fallbacks: _fallbacks, ...linked } = read
    const summary = formatSummary({ ...base, stores: stores(linked) })

    expect(summary).toContain(
      '| Microsoft Store prices | 1162 references, 296 prices read, 0 failed; 395 offers published, 12 requests |',
    )
    expect(storeWarnings(stores(linked))).toEqual([])
    expect(storeWarnings(stores(read))).toEqual([])
  })

  it.each([
    ['refused', 'the store refused a request'],
    ['failures', 'too many of their requests failed'],
    ['time', 'they had used their ten minutes'],
    ['index', 'the index would not take what they found'],
  ] as const)('warns when the ways stopped early because %s', (stopped, why) => {
    const report = {
      ...read,
      fallbacks: { ...read.fallbacks!, searched: 3, waiting: 717, stopped, error: 'a |\nb' },
    }

    expect(storeWarnings(stores(report))).toEqual([
      `Microsoft Store: the store's own ways to a product stopped early in this run, ${why} (a | b) \u2014 717 games are left waiting for the next run that reads the store`,
    ])
    // The table keeps its columns whatever the store said.
    expect(formatSummary({ ...base, stores: stores(report) })).toContain(
      `3 searched for this run in 168 requests, 99 found (relation 12, name 60, edition 27), 717 waiting (stopped early: ${why}: a / b) |`,
    )
  })
})
