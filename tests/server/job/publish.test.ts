import { describe, expect, it } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import type { JobDeps } from '../../../scripts/index/deps'
import { refreshLanguages } from '../../../scripts/index/languages'
import { refreshPrices } from '../../../scripts/index/prices'
import { publishVersion } from '../../../scripts/index/publish'
import type { IndexedGame } from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness, type JobHarness } from './harness'

const RUN_AT = '2026-09-20T03:00:00.000Z'

async function indexedGames(harness: JobHarness): Promise<IndexedGame[]> {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  const appIds = await resolveAppIds(harness.deps, games)
  await refreshPrices(harness.deps, games, appIds)
  await refreshLanguages(harness.deps, games, appIds)
  return games
}

async function publish(deps: JobDeps, games: IndexedGame[]) {
  const version = await deps.writer.beginVersion()
  return publishVersion(deps, {
    version,
    games,
    pricesUpdatedAt: RUN_AT,
    pricesFetched: 6,
    languagesFetched: 6,
    failures: 0,
    durationMs: 1_234,
  })
}

describe('publishVersion', () => {
  it('publishes the first run and reports it through the reader', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)

    const outcome = await publish(harness.deps, games)

    expect(outcome.published).toBe(true)
    expect(await harness.writer.meta()).toEqual({
      version: 1,
      updatedAt: RUN_AT,
      pricesUpdatedAt: RUN_AT,
      gameCount: 9,
      stats: {
        gamesIndexed: 9,
        pricesFetched: 6,
        languagesFetched: 6,
        failures: 0,
        durationMs: 1_234,
        pricedCount: 5,
        textCount: 4,
        audioCount: 2,
      },
    })
  })

  it('leaves the documents and facets a reader query needs', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    await publish(harness.deps, await indexedGames(harness))

    const cheap = await harness.writer.search({ priceMaxUah: 600, sort: 'PRICE_ASC' })
    const voiced = await harness.writer.search({ ukrainianLocalisation: 'AUDIO' })
    const onSale = await harness.writer.search({ onSaleMinPercent: 25, sort: 'DISCOUNT_DESC' })

    expect(cheap.ids).toEqual([105, 102, 106])
    expect(cheap.total).toBe(3)
    expect(voiced.ids).toEqual([101, 106])
    expect(onSale.ids).toEqual([101, 106])
    expect((await harness.writer.getOne(101))?.priceUah).toBe(675)
  })

  it('refuses a run that lost more than half the published games', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)
    const before = await harness.writer.search({})

    const outcome = await publish(harness.deps, games.slice(0, 4))

    expect(outcome.published).toBe(false)
    expect(outcome.reason).toMatch(/fewer than half/)
    expect(await harness.writer.currentVersion()).toBe(1)
    expect(await harness.writer.search({})).toEqual(before)
  })

  it('accepts a run that kept exactly half', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)

    const outcome = await publish(harness.deps, games.slice(0, 5))

    expect(outcome.published).toBe(true)
    expect(await harness.writer.currentVersion()).toBe(2)
  })

  it('refuses a run with no prices when the published version has some', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)
    const unpriced = games.map((game) => ({ ...game, priceUah: null, free: false }))

    const outcome = await publish(harness.deps, unpriced)

    expect(outcome.published).toBe(false)
    expect(outcome.reason).toMatch(/priced no games/)
    expect(await harness.writer.currentVersion()).toBe(1)
    expect((await harness.writer.getOne(101))?.priceUah).toBe(675)
  })

  it('accepts a first run with no prices at all', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)

    const outcome = await publish(
      harness.deps,
      games.map((game) => ({ ...game, priceUah: null, free: false })),
    )

    expect(outcome.published).toBe(true)
  })

  it('discards the refused draft instead of leaving it behind', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)

    const refused = await publish(harness.deps, games.slice(0, 1))

    // Nothing of the refused version is left: it cannot even be published after the fact.
    await expect(harness.writer.writeVersion(refused.meta.version, games)).rejects.toThrow(
      /Unknown index version/,
    )
    expect(await harness.writer.currentVersion()).toBe(1)
  })
})
