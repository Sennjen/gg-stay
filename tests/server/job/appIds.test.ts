import { describe, expect, it, vi } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import type { JobDeps } from '../../../scripts/index/deps'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness, type JobHarness } from './harness'

async function candidatesOf(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  harness.calls.length = 0
  return games
}

describe('resolveAppIds', () => {
  it('asks for the store links of every Steam candidate, and of nobody else', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    await resolveAppIds(harness.deps, games)

    expect(harness.storeCalls().map((call) => call.path)).toEqual([
      'games/hollow-cradle/stores',
      'games/neon-district/stores',
      'games/frost-relay/stores',
      'games/quiet-orbit/stores',
      'games/amber-trail/stores',
      'games/deep-signal/stores',
      'games/silent-meridian/stores',
    ])
  })

  it('keeps the app id from the Steam link and an empty marker when there is none', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    const { appIds } = await resolveAppIds(harness.deps, games)

    expect(appIds.get(101)).toBe('411000')
    expect(appIds.get(104)).toBe('')
    expect(appIds.has(103)).toBe(false)
    expect(await harness.writer.getAppIds([101, 104])).toEqual(
      new Map([
        [101, '411000'],
        [104, ''],
      ]),
    )
  })

  it('makes no store call at all on a second run', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    await resolveAppIds(harness.deps, games)

    const second = createJobHarness({ writer: harness.writer })
    const { appIds } = await resolveAppIds(second.deps, games)

    expect(second.storeCalls()).toHaveLength(0)
    expect(appIds.get(101)).toBe('411000')
  })

  it('writes the resolved ids in batches instead of one round trip each', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    const setAppIds = vi.spyOn(harness.writer, 'setAppIds')

    await resolveAppIds(harness.deps, games, { batchSize: 3 })

    expect(setAppIds).toHaveBeenCalledTimes(3)
    expect([...setAppIds.mock.calls[0]![0]].map(([id]) => id)).toEqual([101, 102, 104])
  })

  it('keeps the ids a crashed attempt had already written and resolves only the rest', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    // Enough failures to blow the 5 % budget, which is what ends a stage.
    for (const slug of ['amber-trail', 'deep-signal', 'silent-meridian']) {
      harness.failNext((call) => call.path === `games/${slug}/stores`)
    }

    await expect(resolveAppIds(harness.deps, games, { batchSize: 2 })).rejects.toThrow(
      /over the 5% a run tolerates/,
    )

    const resumed = createJobHarness({ writer: harness.writer })
    const { appIds } = await resolveAppIds(resumed.deps, games, { batchSize: 2 })

    expect(resumed.storeCalls().map((call) => call.path)).toEqual([
      'games/amber-trail/stores',
      'games/deep-signal/stores',
      'games/silent-meridian/stores',
    ])
    expect(appIds.get(106)).toBe('416000')
    expect(appIds.get(101)).toBe('411000')
  })

  it('treats a game RAWG has no store row for as having no Steam page', async () => {
    const harness = createJobHarness()
    const deps: JobDeps = {
      ...harness.deps,
      rawg: async (path, params) =>
        path === 'games/no-such-game/stores'
          ? { count: 0, next: null, results: [] }
          : harness.deps.rawg(path, params),
    }
    const games = await candidatesOf(harness)
    const unknown = { ...games[0]!, id: 999, slug: 'no-such-game', stores: ['steam'] }

    const { appIds } = await resolveAppIds(deps, [unknown])

    expect(appIds.get(999)).toBe('')
  })
})

describe('resolveAppIds when RAWG misbehaves', () => {
  it('counts one failed game, leaves it unresolved and carries on', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    harness.failNext((call) => call.path === 'games/amber-trail/stores')

    const result = await resolveAppIds(harness.deps, games)

    expect(result.failures).toBe(1)
    expect(result.attempted).toBe(7)
    expect(result.appIds.has(106)).toBe(false)
    expect(result.appIds.get(107)).toBe('417000')
    // Not written as "has no Steam page": that would make one timeout permanent.
    expect(await harness.writer.getAppIds([106])).toEqual(new Map())
  })

  it('ends the stage when more than a twentieth of the games fail', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    for (const slug of ['amber-trail', 'deep-signal']) {
      harness.failNext((call) => call.path === `games/${slug}/stores`)
    }

    await expect(resolveAppIds(harness.deps, games)).rejects.toThrow(/app ids: 2 of 7 items failed/)
    // Whatever it did resolve before giving up is still saved: that quota is spent either way.
    expect(await harness.writer.getAppIds([101])).toEqual(new Map([[101, '411000']]))
  })
})
