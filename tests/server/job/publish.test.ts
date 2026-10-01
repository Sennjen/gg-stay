import { describe, expect, it, vi } from 'vitest'
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
  const { appIds } = await resolveAppIds(harness.deps, games)
  await refreshPrices(harness.deps, games, appIds)
  await refreshLanguages(harness.deps, games, appIds)
  return games
}

async function publish(deps: JobDeps, games: IndexedGame[], candidateCount?: number) {
  const version = await deps.writer.beginVersion()
  return publishVersion(deps, {
    version,
    games,
    candidateCount,
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
        madeInUkraineCount: 0,
        similarCount: 0,
        similarMedianLength: 0,
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

    // Exactly half the games, and all five priced ones, so only the game-count gate is in play.
    const half = games.filter((game) => [101, 102, 105, 106, 108].includes(game.id))
    const outcome = await publish(harness.deps, half)

    expect(half).toHaveLength(5)
    expect(outcome.published).toBe(true)
    expect(await harness.writer.currentVersion()).toBe(2)
  })

  it('refuses a run that priced far fewer games than the published version', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)
    // Five priced before; a partial Steam outage leaves three, which is under three quarters.
    const halfPriced = games.map((game) =>
      [101, 102].includes(game.id) ? { ...game, priceUah: null, free: false } : game,
    )

    const outcome = await publish(harness.deps, halfPriced)

    expect(outcome.published).toBe(false)
    expect(outcome.reason).toMatch(/priced 3 games, against 5/)
    expect(await harness.writer.currentVersion()).toBe(1)
  })

  it('accepts the ordinary churn of a game or two losing its price', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    await publish(harness.deps, games)
    const oneFewer = games.map((game) =>
      game.id === 101 ? { ...game, priceUah: null, free: false } : game,
    )

    expect((await publish(harness.deps, oneFewer)).published).toBe(true)
  })

  it('gives the draft back when the write itself fails', async () => {
    const harness = createJobHarness({ start: RUN_AT })
    const games = await indexedGames(harness)
    const discardVersion = vi.spyOn(harness.writer, 'discardVersion')
    vi.spyOn(harness.writer, 'writeVersion').mockRejectedValueOnce(new Error('request too large'))

    await expect(publish(harness.deps, games)).rejects.toThrow(/request too large/)

    expect(discardVersion).toHaveBeenCalledWith(1)
    expect(await harness.writer.currentVersion()).toBeNull()
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
      /was never begun/,
    )
    expect(await harness.writer.currentVersion()).toBe(1)
  })

  describe('with studio games added to the candidates', () => {
    const flagged = (games: IndexedGame[]) =>
      games.map((game) => ({ ...game, madeInUkraine: true }))

    it('measures the game-count gate on the candidates, not on the studio games', async () => {
      const harness = createJobHarness({ start: RUN_AT })
      const games = await indexedGames(harness)
      await publish(harness.deps, games, games.length)

      // The popularity walk collapsed to three games; two studio games bring the total to five,
      // which is half of the published nine and would pass a gate counted on the total.
      const collapsed = [...games.slice(0, 3), ...flagged(games.slice(5, 7))]
      const outcome = await publish(harness.deps, collapsed, 3)

      expect(collapsed.length).toBeGreaterThanOrEqual(games.length / 2)
      expect(outcome.published).toBe(false)
      expect(outcome.reason).toMatch(/3 candidates, fewer than half of the published 9/)
      expect(await harness.writer.currentVersion()).toBe(1)
    })

    it("compares with the published version's candidates, not its total", async () => {
      const harness = createJobHarness({ start: RUN_AT })
      const games = await indexedGames(harness)
      // Eight candidates and one studio game published.
      await publish(harness.deps, [...games.slice(0, 8), ...flagged(games.slice(8))], 8)

      // Four candidates keep exactly half of eight, though not half of the nine published games.
      const half = games.filter((game) => [101, 102, 105, 106].includes(game.id))
      const outcome = await publish(harness.deps, half, 4)

      expect(outcome.published).toBe(true)
    })

    it('records the candidates and the games made in Ukraine in the run stats', async () => {
      const harness = createJobHarness({ start: RUN_AT })
      const games = await indexedGames(harness)

      await publish(harness.deps, [...games.slice(0, 7), ...flagged(games.slice(7))], 7)

      expect((await harness.writer.meta())?.stats).toMatchObject({
        gamesIndexed: 9,
        candidateCount: 7,
        madeInUkraineCount: 2,
      })
    })

    it('keeps the published candidate count through a run that walks no candidates', async () => {
      const harness = createJobHarness({ start: RUN_AT })
      const games = await indexedGames(harness)
      await publish(harness.deps, games, 7)

      await publish(harness.deps, games)

      expect((await harness.writer.meta())?.stats?.candidateCount).toBe(7)
    })
  })
})
