import { describe, expect, it } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import { LANGUAGES_STAGE, refreshLanguages } from '../../../scripts/index/languages'
import { refreshPrices } from '../../../scripts/index/prices'
import type { IndexedGame } from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness, type JobHarness } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'

async function upToPrices(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const appIds = await resolveAppIds(harness.deps, games)
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

  it('never asks about a game whose language information is still fresh', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    harness.languageCalls.length = 0

    harness.clock.advance(6 * 24 * 60 * 60 * 1000)
    await refreshLanguages(harness.deps, games, appIds)

    expect(harness.languageCalls).toHaveLength(0)
  })

  it('asks again once the information is a week old', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    harness.languageCalls.length = 0

    harness.clock.advance(8 * 24 * 60 * 60 * 1000)
    await refreshLanguages(harness.deps, games, appIds)

    expect(harness.languageCalls).toHaveLength(6)
  })

  it('carries the published version forward instead of re-reading it', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)
    await refreshLanguages(harness.deps, games, appIds)
    const version = await harness.writer.beginVersion()
    await harness.writer.writeVersion(version, games)
    await harness.writer.publish(version, {
      version,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: games.length,
    })

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

  it('stops at the request budget and resumes after the cursor', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    const first = await refreshLanguages(harness.deps, games, appIds, { limit: 2 })

    expect(first.fetched).toBe(2)
    expect(await harness.writer.getCursor(LANGUAGES_STAGE)).toBe('102')

    const resumed = createJobHarness({ writer: harness.writer, start: RUN_AT })
    const carried: IndexedGame[] = games.map((game) => ({ ...game, localisation: null }))
    await refreshLanguages(resumed.deps, carried, appIds, { limit: 2 })

    expect(resumed.languageCalls.map((call) => call.appId)).toEqual(['415000', '416000'])
  })

  it('counts a failed app instead of ending the run', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds, byId } = await upToPrices(harness)
    harness.failLanguagesOnce('412000')

    const result = await refreshLanguages(harness.deps, games, appIds)

    expect(result.failures).toBe(1)
    expect(result.fetched).toBe(5)
    expect(byId.get(102)!.localisation).toBeNull()
    expect(byId.get(106)!.localisation).toMatchObject({ text: true })
  })

  it('clears the cursor when every game has been read', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await upToPrices(harness)

    await refreshLanguages(harness.deps, games, appIds)

    expect(await harness.writer.getCursor(LANGUAGES_STAGE)).toBeNull()
  })
})
