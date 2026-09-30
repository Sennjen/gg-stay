import { describe, expect, it, vi } from 'vitest'
import { collectCandidates, toIndexedGame } from '../../../scripts/index/candidates'
import {
  collectStudioGames,
  MAX_STUDIO_GAMES_APPENDED,
  STUDIO_MAX_PAGES,
  STUDIO_PAGE_SIZE,
} from '../../../scripts/index/studios'
import type { IndexedGame } from '../../../server/index/document'
import type { RawgGameListItem } from '../../../server/rawg/types'
import { UpstreamError } from '../../../server/upstream/errors'
import { UKRAINIAN_STUDIO_SLUGS } from '../../../shared/ukrainianStudios'
import {
  JOB_PAGE_COUNT,
  JOB_STUDIO_GAME,
  JOB_STUDIO_GAMES,
  jobStudioPage,
} from '../../fixtures/index/jobCatalog'
import { createJobHarness, createTransportRawg, type RawgCall } from './harness'

const TWO_STUDIOS = ['frogwares', 'gsc-game-world']

async function candidatesOf(harness: ReturnType<typeof createJobHarness>) {
  return (await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })).games
}

function studioGame(id: number, added: number): RawgGameListItem {
  return { ...JOB_STUDIO_GAME, id, slug: `studio-game-${id}`, name: `Studio Game ${id}`, added }
}

function studioPage(slug: string, page: number) {
  return (call: RawgCall) => call.params.developers === slug && call.params.page === String(page)
}

describe('collectStudioGames', () => {
  it("asks RAWG for every listed studio's most added games, forty to a page", async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    const games = await candidatesOf(harness)

    await collectStudioGames(harness.deps, games)

    expect(harness.studioCalls().map((call) => call.params.developers)).toEqual([
      ...UKRAINIAN_STUDIO_SLUGS,
    ])
    expect(harness.studioCalls()[0]!.params).toEqual({
      developers: UKRAINIAN_STUDIO_SLUGS[0],
      ordering: '-added',
      page_size: String(STUDIO_PAGE_SIZE),
      page: '1',
    })
    expect(STUDIO_PAGE_SIZE).toBe(40)
  })

  it('flags a candidate already in the list and appends a studio game that is not', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    const games = await candidatesOf(harness)

    const result = await collectStudioGames(harness.deps, games, { slugs: TWO_STUDIOS })

    expect(games.filter((game) => game.madeInUkraine).map((game) => game.id)).toEqual([106, 110])
    expect(games).toHaveLength(10)
    // The same mapper as the candidates, so an appended card is the card the popularity walk
    // would have made of it — only flagged.
    expect(games.at(-1)).toEqual({ ...toIndexedGame(JOB_STUDIO_GAME)!, madeInUkraine: true })
    expect(result).toMatchObject({ flagged: 1, dropped: 0, failures: 0, attempted: 2 })
    expect(result.appended.map((game) => game.id)).toEqual([110])
  })

  it('appends a game two studio slugs both list only once', async () => {
    const harness = createJobHarness({
      studios: { boolat: [JOB_STUDIO_GAME], 'boolat-games': [JOB_STUDIO_GAME] },
    })
    const games = await candidatesOf(harness)

    const result = await collectStudioGames(harness.deps, games, {
      slugs: ['boolat', 'boolat-games'],
    })

    expect(games.filter((game) => game.id === 110)).toHaveLength(1)
    expect(result.appended).toHaveLength(1)
  })

  it('appends at most the bound, keeping the most popular, and logs how many it dropped', async () => {
    const harness = createJobHarness({
      studios: { frogwares: [studioGame(201, 10), studioGame(202, 30), studioGame(203, 20)] },
    })
    const games: IndexedGame[] = []

    const result = await collectStudioGames(harness.deps, games, {
      slugs: ['frogwares'],
      maxAppended: 2,
    })

    expect(games.map((game) => game.id)).toEqual([202, 203])
    expect(result.dropped).toBe(1)
    expect(harness.logs.some((line) => /dropped 1 studio game/.test(line))).toBe(true)
    expect(MAX_STUDIO_GAMES_APPENDED).toBe(400)
  })

  it('follows `next` for at most two pages per studio', async () => {
    const harness = createJobHarness()
    const withMore = (id: number) => ({
      count: 200,
      next: 'https://api.rawg.io/api/games?developers=frogwares&page=next',
      results: [studioGame(id, 100 - id)],
    })
    harness.answerNextWith(studioPage('frogwares', 1), withMore(1))
    harness.answerNextWith(studioPage('frogwares', 2), withMore(2))

    const games: IndexedGame[] = []
    await collectStudioGames(harness.deps, games, { slugs: ['frogwares'] })

    expect(harness.studioCalls().map((call) => call.params.page)).toEqual(['1', '2'])
    expect(STUDIO_MAX_PAGES).toBe(2)
    expect(games.map((game) => game.id)).toEqual([1, 2])
  })

  it('stops after the first page when RAWG has no next one', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })

    await collectStudioGames(harness.deps, [], { slugs: ['frogwares'] })

    expect(harness.studioCalls()).toHaveLength(1)
  })

  it('asks again for a studio page RAWG answered without a result list, and carries on', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    harness.answerNextWith(studioPage('gsc-game-world', 1), null)
    const games = await candidatesOf(harness)

    const result = await collectStudioGames(harness.deps, games, { slugs: TWO_STUDIOS })

    expect(harness.studioCalls().filter(studioPage('gsc-game-world', 1))).toHaveLength(2)
    expect(result.failures).toBe(0)
    expect(result.requests).toBe(3)
    expect(games.map((game) => game.id)).toContain(110)
  })

  it('reaches RAWG again through the real transport when a studio page came back empty', async () => {
    const harness = createJobHarness()
    const transport = createTransportRawg([
      null,
      jobStudioPage(JOB_STUDIO_GAMES, 'gsc-game-world', 1),
    ])
    const games: IndexedGame[] = []

    const result = await collectStudioGames({ ...harness.deps, rawg: transport.rawg }, games, {
      slugs: ['gsc-game-world'],
    })

    expect(transport.urls).toHaveLength(2)
    expect(result.failures).toBe(0)
    expect(games.map((game) => game.id)).toEqual([110])
  })

  it('counts a studio RAWG answers without a result list twice as a failed studio', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    harness.answerNextWith(studioPage('gsc-game-world', 1), null)
    harness.answerNextWith(studioPage('gsc-game-world', 1), { count: 0, next: null })
    const games = await candidatesOf(harness)

    const result = await collectStudioGames(harness.deps, games, {
      slugs: [...UKRAINIAN_STUDIO_SLUGS],
    })

    expect(result.failures).toBe(1)
    expect(harness.logs.some((line) => line.includes('gsc-game-world'))).toBe(true)
    // The other studio still flagged its game: one slug failing is not the stage failing.
    expect(games.find((game) => game.id === 106)?.madeInUkraine).toBe(true)
  })

  it('tolerates one failing studio of the list, and fails the stage past 5 %', async () => {
    const once = createJobHarness({ studios: JOB_STUDIO_GAMES })
    once.failNext((call) => call.params.developers === '4a-games')
    const result = await collectStudioGames(once.deps, [])
    expect(result.failures).toBe(1)
    expect(result.attempted).toBe(UKRAINIAN_STUDIO_SLUGS.length)

    const twice = createJobHarness({ studios: JOB_STUDIO_GAMES })
    twice.failNext((call) => call.params.developers === '4a-games')
    twice.failNext((call) => call.params.developers === 'best-way')
    // Two of thirty-three slugs is 6 %.
    await expect(collectStudioGames(twice.deps, [])).rejects.toThrow(/studios: 2 of 33/)
  })

  it('logs a slug RAWG does not know without counting it as a failure', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    for (const slug of ['4a-games', 'best-way']) {
      harness.failNext(
        (call) => call.params.developers === slug,
        new UpstreamError('RAWG', 'NOT_FOUND', 404),
      )
    }

    const result = await collectStudioGames(harness.deps, [])

    expect(result.failures).toBe(0)
    expect(result.unknown).toEqual(['4a-games', 'best-way'])
    expect(harness.logs.some((line) => line.includes('4a-games, best-way'))).toBe(true)
  })

  it('counts every RAWG request it makes, retries included', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })

    const result = await collectStudioGames(harness.deps, [])

    expect(result.requests).toBe(UKRAINIAN_STUDIO_SLUGS.length)
    expect(result.requests).toBe(harness.studioCalls().length)
  })

  it('renews the write lock every twenty pages, like the candidate walk', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    await collectStudioGames(harness.deps, [])

    // Thirty-three one-page studios.
    expect(renewLock).toHaveBeenCalledTimes(Math.floor(UKRAINIAN_STUDIO_SLUGS.length / 20))
  })
})
