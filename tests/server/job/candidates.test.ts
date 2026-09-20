import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_PAGE_SIZE,
  carryPublishedForward,
  collectCandidates,
  previewOf,
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
      preview: 'https://media.rawg.io/media/screenshots/101-a.jpg',
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
      // The only screenshot RAWG listed is the cover itself, so there is nothing to preview.
      preview: null,
    })
  })

  it('always walks from the first page, so a crashed run cannot skip the top of the list', async () => {
    const crashed = createJobHarness()
    crashed.failNext((call) => call.path === 'games' && call.params.page === '2')
    await expect(collectCandidates(crashed.deps, { pages: JOB_PAGE_COUNT })).rejects.toThrow(
      /RAWG upstream failure/,
    )

    const next = createJobHarness({ writer: crashed.writer })
    const result = await collectCandidates(next.deps, { pages: JOB_PAGE_COUNT })

    expect(next.pageCalls().map((call) => call.params.page)).toEqual(['1', '2', '3'])
    expect(result.games.map((game) => game.id)).toEqual(JOB_GAMES.map((game) => game.id))
  })

  it('stops early when RAWG runs out of pages', async () => {
    const harness = createJobHarness()

    const result = await collectCandidates(harness.deps, { pages: 20 })

    expect(harness.pageCalls()).toHaveLength(JOB_PAGE_COUNT)
    expect(result.games).toHaveLength(JOB_GAMES.length)
  })
})

describe('carryPublishedForward', () => {
  const published: IndexedGame = {
    id: 101,
    slug: 'hollow-cradle',
    name: 'Hollow Cradle',
    cover: null,
    preview: null,
    released: '2021-03-11',
    popularity: 21000,
    platforms: [4],
    genres: ['action'],
    stores: ['steam'],
    gameModes: ['SINGLE'],
    ageRating: 'PEGI18',
    rating: 4.6,
    ratingsCount: 10,
    metacritic: 92,
    playtime: 43,
    priceUah: 675,
    regularPriceUah: 1349,
    discountPercent: 50,
    free: false,
    localisation: {
      text: true,
      audio: true,
      source: 'steam',
      updatedAt: '2026-09-13T00:00:00.000Z',
    },
    madeInUkraine: false,
    priceUpdatedAt: '2026-09-19T21:00:00.000Z',
  }

  it('copies the published price and languages onto a freshly mapped candidate', async () => {
    const harness = createJobHarness()
    const version = await harness.writer.beginVersion()
    await harness.writer.writeVersion(version, [published])
    await harness.writer.publish(version, {
      version,
      updatedAt: '2026-09-19T21:00:00.000Z',
      pricesUpdatedAt: '2026-09-19T21:00:00.000Z',
      gameCount: 1,
    })
    const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })

    const carried = await carryPublishedForward(harness.deps, games)

    expect(carried).toBe(1)
    expect(games.find((game) => game.id === 101)).toMatchObject({
      priceUah: 675,
      discountPercent: 50,
      priceUpdatedAt: '2026-09-19T21:00:00.000Z',
      localisation: { text: true, audio: true },
    })
    // A game the published version never had keeps its empty price.
    expect(games.find((game) => game.id === 102)).toMatchObject({ priceUah: null })
  })

  it('does nothing on a first run', async () => {
    const harness = createJobHarness()
    const { games } = await collectCandidates(harness.deps, { pages: 1 })

    expect(await carryPublishedForward(harness.deps, games)).toBe(0)
  })
})

describe('previewOf', () => {
  const cover = 'https://media.rawg.io/media/games/1.jpg'

  it('takes the first screenshot that is neither the cover entry nor the cover URL', () => {
    expect(
      previewOf(
        [
          { id: -1, image: cover },
          { id: 2, image: cover },
          { id: 3, image: 'https://media.rawg.io/media/screenshots/1-a.jpg' },
        ],
        cover,
      ),
    ).toBe('https://media.rawg.io/media/screenshots/1-a.jpg')
  })

  it('has nothing to preview when RAWG listed nothing else', () => {
    expect(previewOf([{ id: -1, image: cover }], cover)).toBeNull()
    expect(previewOf([], cover)).toBeNull()
    expect(previewOf(undefined, cover)).toBeNull()
  })

  it('drops a screenshot whose URL would not be safe to render', () => {
    expect(previewOf([{ id: 2, image: 'javascript:alert(1)' }], cover)).toBeNull()
  })
})
