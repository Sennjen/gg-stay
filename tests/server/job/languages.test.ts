import { describe, expect, it } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import { refreshLanguages } from '../../../scripts/index/languages'
import { refreshPrices } from '../../../scripts/index/prices'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness, type JobHarness } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

async function upToPrices(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const { appIds } = await resolveAppIds(harness.deps, games)
  await refreshPrices(harness.deps, games, appIds)
  return { games, appIds, byId: new Map(games.map((game) => [game.id, game])) }
}

describe('refreshLanguages', () => {
  it('asks Steam once per game with a Steam page', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    await refreshLanguages(harness.deps, games, appIds)

    expect(harness.languageCalls.map((call) => call.appId)).toEqual([
      '411000',
      '412000',
      '415000',
      '416000',
      '417000',
      '418000',
    ])
  })

  it('records Ukrainian text, Ukrainian audio and their absence', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds, byId } = await upToPrices(harness)

    await refreshLanguages(harness.deps, games, appIds)

    expect(byId.get(101)!.localisation).toEqual({
      text: true,
      audio: true,
      source: 'steam',
      updatedAt: RUN_AT,
    })
    expect(byId.get(102)!.localisation).toMatchObject({ text: true, audio: false })
    expect(byId.get(106)!.localisation).toMatchObject({ text: true, audio: true })
    expect(byId.get(108)!.localisation).toMatchObject({ text: false, audio: false })
  })

  it('keeps what Steam said outside the version, under the app id', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    await refreshLanguages(harness.deps, games, appIds)

    expect((await harness.writer.getLanguages(['411000'])).get('411000')).toEqual({
      text: true,
      audio: true,
      isFree: false,
      updatedAt: RUN_AT,
    })
    expect((await harness.writer.getLanguages(['415000'])).get('415000')?.isFree).toBe(true)
  })

  it('resolves the free-versus-unavailable ambiguity the batched price left behind', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds, byId } = await upToPrices(harness)
    expect(byId.get(105)).toMatchObject({ free: false, priceUah: null })

    await refreshLanguages(harness.deps, games, appIds)

    expect(byId.get(105)).toMatchObject({
      free: true,
      priceUah: 0,
      regularPriceUah: 0,
      discountPercent: 0,
      priceUpdatedAt: RUN_AT,
    })
    // Steam refuses to price this one in the region; it is not free, it is unavailable.
    expect(byId.get(107)).toMatchObject({ free: false, priceUah: null })
  })

  it('stops calling a game free once Steam stops saying so', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds, byId } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    expect(byId.get(105)).toMatchObject({ free: true, priceUah: 0 })

    harness.steamApps['415000'] = {
      success: true,
      data: { is_free: false, supported_languages: 'English, Українська' },
    }
    harness.clock.advance(WEEK_MS + 1)
    const result = await refreshLanguages(harness.deps, games, appIds)

    expect(byId.get(105)).toMatchObject({ free: false, priceUah: null, priceUpdatedAt: null })
    expect(result.pricesTouched).toBe(1)
  })

  it('never asks about a game whose record is still fresh', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    harness.languageCalls.length = 0

    harness.clock.advance(6 * 24 * 60 * 60 * 1000)
    const result = await refreshLanguages(harness.deps, games, appIds)

    expect(harness.languageCalls).toHaveLength(0)
    expect(result.fromStore).toBe(6)
  })

  it('asks again once the record is a week old', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    harness.languageCalls.length = 0

    harness.clock.advance(WEEK_MS + 1)
    await refreshLanguages(harness.deps, games, appIds)

    expect(harness.languageCalls).toHaveLength(6)
  })

  it('applies a record another run saved, whatever this run is called', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)

    const next = createJobHarness({ writer: harness.writer, start: '2026-09-21T03:00:00.000Z' })
    const fresh = await upToPrices(next)
    await refreshLanguages(next.deps, fresh.games, fresh.appIds)

    expect(next.languageCalls).toHaveLength(0)
    expect(fresh.byId.get(101)!.localisation).toMatchObject({ text: true, audio: true })
  })

  it('keeps to forty requests a minute', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    await refreshLanguages(harness.deps, games, appIds, { requestsPerMinute: 2 })

    const start = Date.parse(RUN_AT)
    expect(harness.languageCalls.map((call) => call.at - start)).toEqual([
      0, 0, 60_000, 60_000, 120_000, 120_000,
    ])
  })

  it('reads every app it has never seen, whatever the budget says', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    const result = await refreshLanguages(harness.deps, games, appIds, { budget: 1 })

    expect(result.fetched).toBe(6)
    expect(result.deferred).toBe(0)
  })

  it('spends a budget on the oldest records and leaves the rest for the next run', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await harness.writer.setLanguages([
      ['411000', { text: true, audio: true, isFree: false, updatedAt: '2026-01-01T00:00:00.000Z' }],
      [
        '412000',
        { text: true, audio: false, isFree: false, updatedAt: '2026-08-01T00:00:00.000Z' },
      ],
      ['415000', { text: true, audio: false, isFree: true, updatedAt: '2026-09-19T00:00:00.000Z' }],
      ['416000', { text: true, audio: true, isFree: false, updatedAt: '2026-09-19T00:00:00.000Z' }],
      [
        '417000',
        { text: false, audio: false, isFree: false, updatedAt: '2026-09-19T00:00:00.000Z' },
      ],
      [
        '418000',
        { text: false, audio: false, isFree: false, updatedAt: '2026-09-19T00:00:00.000Z' },
      ],
    ])

    const result = await refreshLanguages(harness.deps, games, appIds, { budget: 1 })

    expect(harness.languageCalls.map((call) => call.appId)).toEqual(['411000'])
    expect(result.deferred).toBe(1)
    // The fresh records are still applied, they are simply not re-read.
    expect(result.fromStore).toBe(6)
  })

  it('saves every record it read even when the stage gives up', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    harness.failLanguagesOnce('412000')
    harness.failLanguagesOnce('415000')

    await expect(refreshLanguages(harness.deps, games, appIds)).rejects.toThrow(
      /languages: 2 of 6 items failed/,
    )
    expect((await harness.writer.getLanguages(['411000'])).has('411000')).toBe(true)
    expect((await harness.writer.getLanguages(['412000'])).has('412000')).toBe(false)
  })

  it('counts a single failed app instead of ending the run', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds, byId } = await upToPrices(harness)
    harness.failLanguagesOnce('412000')

    const result = await refreshLanguages(harness.deps, games, appIds)

    expect(result.failures).toBe(1)
    expect(result.fetched).toBe(5)
    expect(byId.get(102)!.localisation).toBeNull()
    expect(byId.get(106)!.localisation).toMatchObject({ text: true })
  })
})
