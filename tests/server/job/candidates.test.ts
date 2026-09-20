import { describe, expect, it } from 'vitest'
import {
  CANDIDATES_STAGE,
  CANDIDATE_PAGE_SIZE,
  collectCandidates,
} from '../../../scripts/index/candidates'
import type { IndexedGame } from '../../../server/index/document'
import { JOB_GAMES, JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { createJobHarness } from './harness'

describe('collectCandidates', () => {
  it('asks RAWG for the most added games, one page at a time', async () => {
    const harness = createJobHarness()

    const result = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })

    expect(harness.pageCalls()).toHaveLength(JOB_PAGE_COUNT)
    expect(harness.pageCalls()[0]!.params).toMatchObject({
      ordering: '-added',
      page_size: String(CANDIDATE_PAGE_SIZE),
      page: '1',
    })
    expect(result.games.map((game) => game.id)).toEqual(JOB_GAMES.map((game) => game.id))
  })

  it('stops at the page limit even when RAWG has more pages', async () => {
    const harness = createJobHarness()

    const result = await collectCandidates(harness.deps, { pages: 1 })

    expect(harness.pageCalls()).toHaveLength(1)
    expect(result.games).toHaveLength(3)
  })

  it('maps a game to the indexed card with the catalog lookups', async () => {
    const harness = createJobHarness()

    const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
    const hollowCradle = games.find((game) => game.id === 101)

    expect(hollowCradle).toEqual({
      id: 101,
      slug: 'hollow-cradle',
      name: 'Hollow Cradle',
      cover: 'https://media.rawg.io/media/games/101.jpg',
      released: '2021-03-11',
      popularity: 21000,
      platforms: [4, 187],
      genres: ['action'],
      stores: ['steam', 'gog'],
      gameModes: ['SINGLE'],
      ageRating: 'PEGI18',
      rating: 4.65,
      ratingsCount: 6800,
      metacritic: 92,
      playtime: 43,
      priceUah: null,
      regularPriceUah: null,
      discountPercent: 0,
      free: false,
      localisation: null,
      madeInUkraine: false,
      priceUpdatedAt: null,
    })
  })

  it('keeps the unknowns of a sparse game as nulls rather than zeroes', async () => {
    const harness = createJobHarness()

    const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
    const paperHarbour = games.find((game) => game.id === 103)

    expect(paperHarbour).toMatchObject({
      metacritic: null,
      ageRating: null,
      stores: [],
      gameModes: ['SINGLE'],
    })
  })

  it('records the last finished page and clears the cursor when it completes', async () => {
    const harness = createJobHarness()

    await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })

    expect(await harness.writer.getCursor(CANDIDATES_STAGE)).toBeNull()
  })

  it('resumes after the cursor, repeating no page and losing no game', async () => {
    const crashed = createJobHarness()
    crashed.failNext((call) => call.path === 'games' && call.params.page === '2')
    const collected: IndexedGame[] = []

    await expect(
      collectCandidates(crashed.deps, { pages: JOB_PAGE_COUNT, collected }),
    ).rejects.toThrow(/RAWG upstream failure/)
    expect(collected.map((game) => game.id)).toEqual([101, 102, 103])
    expect(await crashed.writer.getCursor(CANDIDATES_STAGE)).toBe('1')

    const resumed = createJobHarness({ writer: crashed.writer })
    const result = await collectCandidates(resumed.deps, { pages: JOB_PAGE_COUNT, collected })

    expect(resumed.pageCalls().map((call) => call.params.page)).toEqual(['2', '3'])
    expect(result.games.map((game) => game.id)).toEqual(JOB_GAMES.map((game) => game.id))
  })

  it('stops early when RAWG runs out of pages', async () => {
    const harness = createJobHarness()

    const result = await collectCandidates(harness.deps, { pages: 20 })

    expect(harness.pageCalls()).toHaveLength(JOB_PAGE_COUNT)
    expect(result.games).toHaveLength(JOB_GAMES.length)
  })
})
