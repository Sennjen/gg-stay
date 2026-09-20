import { describe, expect, it } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import { refreshPrices } from '../../../scripts/index/prices'
import type { IndexedGame } from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness, type JobHarness } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'

async function pricedRun(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const appIds = await resolveAppIds(harness.deps, games)
  const stats = await refreshPrices(harness.deps, games, appIds)
  const byId = new Map(games.map((game) => [game.id, game]))
  return { games, appIds, stats, byId }
}

describe('refreshPrices', () => {
  it('asks Steam once, for every app id it knows and no other', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    await pricedRun(harness)

    expect(harness.priceBatches).toHaveLength(1)
    expect(harness.priceBatches[0]).toEqual([
      '411000',
      '412000',
      '415000',
      '416000',
      '417000',
      '418000',
    ])
  })

  it('attaches the hryvnia price, the discount and the moment it was read', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const { byId } = await pricedRun(harness)

    expect(byId.get(101)).toMatchObject({
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      free: false,
      priceUpdatedAt: RUN_AT,
    })
    expect(byId.get(102)).toMatchObject({
      priceUah: 449,
      regularPriceUah: 449,
      discountPercent: 0,
    })
  })

  it('leaves a game Steam will not price in the region without a price', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const { byId } = await pricedRun(harness)

    expect(byId.get(107)).toMatchObject({ priceUah: null, priceUpdatedAt: null })
  })

  it('leaves a game with no Steam page alone', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const { byId } = await pricedRun(harness)

    expect(byId.get(103)).toMatchObject({ priceUah: null, free: false, priceUpdatedAt: null })
    expect(byId.get(104)).toMatchObject({ priceUah: null, priceUpdatedAt: null })
    expect(byId.get(109)).toMatchObject({ priceUah: null, priceUpdatedAt: null })
  })

  it('keeps a game already known to be free free when the batched call says nothing', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const { games, appIds } = await pricedRun(harness)
    const quietOrbit = games.find((game) => game.id === 105)!
    Object.assign(quietOrbit, {
      free: true,
      priceUah: 0,
      regularPriceUah: 0,
      priceUpdatedAt: '2026-09-13T03:00:00.000Z',
    } satisfies Partial<IndexedGame>)

    harness.clock.advance(60_000)
    await refreshPrices(harness.deps, games, appIds)

    expect(quietOrbit).toMatchObject({
      free: true,
      priceUah: 0,
      discountPercent: 0,
      priceUpdatedAt: '2026-09-20T03:01:00.000Z',
    })
  })

  it('counts what it priced', async () => {
    const harness = createJobHarness({ start: RUN_AT })

    const { stats } = await pricedRun(harness)

    expect(stats).toEqual({ requested: 6, priced: 4 })
  })
})
