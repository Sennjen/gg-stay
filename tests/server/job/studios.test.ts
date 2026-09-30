import { describe, expect, it, vi } from 'vitest'
import { collectCandidates, toIndexedGame } from '../../../scripts/index/candidates'
import { collectStudioGames, STUDIO_PAGE_SIZE } from '../../../scripts/index/studios'
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
/** The harness clock's default start: the night the first version is built. */
const FIRST_NIGHT = '2026-09-20T03:00:00.000Z'
const DAY_MS = 86_400_000

function nightsLater(nights: number): string {
  return new Date(Date.parse(FIRST_NIGHT) + nights * DAY_MS).toISOString()
}

async function publishAll(
  writer: ReturnType<typeof createJobHarness>['writer'],
  games: IndexedGame[],
) {
  const version = await writer.beginVersion()
  await writer.writeVersion(version, games)
  await writer.publish(version, {
    version,
    updatedAt: FIRST_NIGHT,
    pricesUpdatedAt: FIRST_NIGHT,
    gameCount: games.length,
  })
}

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
  })

  it('flags a candidate already in the list and appends a studio game that is not', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    const games = await candidatesOf(harness)

    const result = await collectStudioGames(harness.deps, games, { slugs: TWO_STUDIOS })

    expect(games.filter((game) => game.madeInUkraine).map((game) => game.id)).toEqual([106, 110])
    expect(games).toHaveLength(10)
    // The same mapper as the candidates, so an appended card is the card the popularity walk
    // would have made of it — only flagged.
    expect(games.at(-1)).toEqual({
      ...toIndexedGame(JOB_STUDIO_GAME)!,
      madeInUkraine: true,
      studioSlugs: ['gsc-game-world'],
      studioSeenAt: FIRST_NIGHT,
    })
    expect(games.find((game) => game.id === 106)?.studioSlugs).toEqual(['frogwares'])
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
    // A GitHub Actions annotation each, so the slug shows on the run page and not only in the log.
    expect(harness.logs.filter((line) => line.startsWith('::warning '))).toEqual([
      expect.stringContaining('"4a-games"'),
      expect.stringContaining('"best-way"'),
    ])
  })

  it('keeps the first page of a studio whose second page RAWG no longer has', async () => {
    const harness = createJobHarness()
    harness.answerNextWith(studioPage('frogwares', 1), {
      count: 41,
      next: 'https://api.rawg.io/api/games?developers=frogwares&page=2',
      results: [studioGame(1, 50)],
    })
    harness.failNext(studioPage('frogwares', 2), new UpstreamError('RAWG', 'NOT_FOUND', 404))
    const games: IndexedGame[] = []

    const result = await collectStudioGames(harness.deps, games, { slugs: ['frogwares'] })

    expect(games.map((game) => game.id)).toEqual([1])
    expect(result).toMatchObject({ failures: 0, unknown: [], empty: [] })
  })

  it('fails a studio whose list is the whole catalog, as when RAWG ignores the filter', async () => {
    const harness = createJobHarness()
    harness.answerNextWith(studioPage('frogwares', 1), {
      count: 900_000,
      next: null,
      results: [studioGame(1, 50)],
    })
    const games: IndexedGame[] = []

    const result = await collectStudioGames(harness.deps, games, {
      slugs: TWO_STUDIOS,
    })

    expect(result.failed).toEqual(['frogwares'])
    expect(games).toEqual([])
  })

  it('lists the slugs that gave no games, and the studios none of whose slugs did', async () => {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })

    const result = await collectStudioGames(harness.deps, [], {
      slugs: ['frogwares', 'boolat-games', 'boolat', 'boolat-game-development-company'],
    })

    expect(result.empty).toEqual(['boolat-games', 'boolat', 'boolat-game-development-company'])
    expect(result.studiosWithoutGames).toEqual(['Boolat Games'])
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

describe('collectStudioGames keeping what the published version had', () => {
  async function publishFirstNight() {
    const harness = createJobHarness({ studios: JOB_STUDIO_GAMES })
    const games = await candidatesOf(harness)
    await collectStudioGames(harness.deps, games, { slugs: TWO_STUDIOS })
    Object.assign(
      games.find((game) => game.id === 110)!,
      {
        priceUah: 239,
        localisation: { text: true, audio: true, source: 'steam', updatedAt: FIRST_NIGHT },
      },
    )
    await publishAll(harness.writer, games)
    return harness.writer
  }

  it.each([
    [
      'failed',
      (harness: ReturnType<typeof createJobHarness>) =>
        harness.failNext((call) => call.params.developers === 'gsc-game-world'),
    ],
    [
      'is unknown to RAWG',
      (harness: ReturnType<typeof createJobHarness>) =>
        harness.failNext(
          (call) => call.params.developers === 'gsc-game-world',
          new UpstreamError('RAWG', 'NOT_FOUND', 404),
        ),
    ],
    [
      'listed no games',
      (harness: ReturnType<typeof createJobHarness>) =>
        harness.answerNextWith(studioPage('gsc-game-world', 1), {
          count: 0,
          next: null,
          results: [],
        }),
    ],
  ])('keeps the published games of a slug that %s tonight', async (_name, breakIt) => {
    const writer = await publishFirstNight()
    const tonight = createJobHarness({ writer, studios: JOB_STUDIO_GAMES, start: nightsLater(1) })
    breakIt(tonight)
    const games = await candidatesOf(tonight)

    const result = await collectStudioGames(tonight.deps, games, {
      slugs: TWO_STUDIOS,
    })

    // 110 is back as it was published, price and languages and all, still noted under its
    // studio, and still dated by the night it was last found.
    expect(games.find((game) => game.id === 110)).toMatchObject({
      madeInUkraine: true,
      priceUah: 239,
      localisation: { text: true, audio: true, source: 'steam', updatedAt: FIRST_NIGHT },
      studioSlugs: ['gsc-game-world'],
      studioSeenAt: FIRST_NIGHT,
    })
    expect(result).toMatchObject({ kept: 1, madeInUkraine: 2, previousMadeInUkraine: 2 })
    expect(result.degraded).toBe(false)
  })

  it.each([
    ['listed no games', 'empty'],
    ['is unknown to RAWG', 'unknown'],
  ])(
    'drops the games of a slug that %s once they have not been found for a week',
    async (_name, kind) => {
      const writer = await publishFirstNight()
      const breakIt = (harness: ReturnType<typeof createJobHarness>) =>
        kind === 'empty'
          ? harness.answerNextWith(studioPage('gsc-game-world', 1), {
              count: 0,
              next: null,
              results: [],
            })
          : harness.failNext(
              (call) => call.params.developers === 'gsc-game-world',
              new UpstreamError('RAWG', 'NOT_FOUND', 404),
            )

      const sixNights = createJobHarness({
        writer,
        studios: JOB_STUDIO_GAMES,
        start: nightsLater(7),
      })
      breakIt(sixNights)
      const stillKept = await candidatesOf(sixNights)
      await collectStudioGames(sixNights.deps, stillKept, { slugs: TWO_STUDIOS })
      expect(stillKept.map((game) => game.id)).toContain(110)

      const eightNights = createJobHarness({
        writer,
        studios: JOB_STUDIO_GAMES,
        start: nightsLater(8),
      })
      breakIt(eightNights)
      const games = await candidatesOf(eightNights)
      const result = await collectStudioGames(eightNights.deps, games, { slugs: TWO_STUDIOS })

      expect(games.map((game) => game.id)).not.toContain(110)
      expect(result).toMatchObject({ expired: 1, kept: 0, degraded: false })
      expect(eightNights.logs).toContain(
        'studios: dropped 1 published games of unknown or empty slugs not found for 7 days',
      )
    },
  )

  it('keeps the games of a failing slug however long ago they were found', async () => {
    const writer = await publishFirstNight()
    const monthLater = createJobHarness({
      writer,
      studios: JOB_STUDIO_GAMES,
      start: nightsLater(30),
    })
    monthLater.failNext((call) => call.params.developers === 'gsc-game-world')
    const games = await candidatesOf(monthLater)

    const result = await collectStudioGames(monthLater.deps, games, { slugs: TWO_STUDIOS })

    expect(games.map((game) => game.id)).toContain(110)
    expect(result).toMatchObject({ kept: 1, expired: 0 })
  })

  it('leaves the degraded state the night after a studio holding most flags leaves the list', async () => {
    const REMOVED = [301, 302, 303].map((id) => studioGame(id, 100 + id))
    const studios = { ...JOB_STUDIO_GAMES, 'removed-studio': REMOVED }

    // Night 1: the studio is still on the list and holds three of the four flags.
    const first = createJobHarness({ studios })
    const firstGames = await candidatesOf(first)
    await collectStudioGames(first.deps, firstGames, {
      slugs: ['gsc-game-world', 'removed-studio'],
    })
    await publishAll(first.writer, firstGames)

    // Nights 2 and 3: it has been taken off the data file.
    for (const night of [1, 2]) {
      const harness = createJobHarness({ writer: first.writer, studios, start: nightsLater(night) })
      const games = await candidatesOf(harness)

      const result = await collectStudioGames(harness.deps, games, { slugs: ['gsc-game-world'] })

      expect(result).toMatchObject({ degraded: false, previousMadeInUkraine: 1, madeInUkraine: 1 })
      expect(games.filter((game) => game.madeInUkraine).map((game) => game.id)).toEqual([110])
      await publishAll(harness.writer, games)
    }
  })

  it('fails a studio whose answer has no count but a list longer than one studio could have', async () => {
    const harness = createJobHarness()
    harness.answerNextWith(studioPage('frogwares', 1), {
      next: null,
      results: Array.from({ length: 2_001 }, (_, index) => studioGame(10_000 + index, 1)),
    })
    const games: IndexedGame[] = []

    const result = await collectStudioGames(harness.deps, games, { slugs: TWO_STUDIOS })

    expect(result.failed).toEqual(['frogwares'])
    expect(games).toEqual([])
  })

  it('keeps the flag of a published candidate whose studio could not be read', async () => {
    const writer = await publishFirstNight()
    const tonight = createJobHarness({ writer, studios: JOB_STUDIO_GAMES })
    tonight.failNext((call) => call.params.developers === 'frogwares')
    const games = await candidatesOf(tonight)

    await collectStudioGames(tonight.deps, games, {
      slugs: TWO_STUDIOS,
    })

    expect(games.find((game) => game.id === 106)?.madeInUkraine).toBe(true)
  })

  it('lets a studio taken off the list take its flags with it', async () => {
    const writer = await publishFirstNight()
    const tonight = createJobHarness({ writer, studios: JOB_STUDIO_GAMES })
    const games = await candidatesOf(tonight)

    const result = await collectStudioGames(tonight.deps, games, { slugs: ['gsc-game-world'] })

    expect(games.filter((game) => game.madeInUkraine).map((game) => game.id)).toEqual([110])
    expect(result).toMatchObject({ kept: 0, degraded: false })
  })

  it('keeps every published flag, and says so, when under half of them were found', async () => {
    const harness = createJobHarness()
    // A version published before games carried their studio slugs: nothing can be attributed.
    const version = await harness.writer.beginVersion()
    const published = (await candidatesOf(harness)).map((game) =>
      [101, 102, 103].includes(game.id) ? { ...game, madeInUkraine: true } : game,
    )
    await harness.writer.writeVersion(version, [
      ...published,
      { ...toIndexedGame(JOB_STUDIO_GAME)!, madeInUkraine: true },
    ])
    await harness.writer.publish(version, {
      version,
      updatedAt: '2026-09-20T03:00:00.000Z',
      pricesUpdatedAt: null,
      gameCount: 10,
    })
    const tonight = createJobHarness({ writer: harness.writer })
    const games = await candidatesOf(tonight)

    // RAWG answers every studio with an empty list.
    const result = await collectStudioGames(tonight.deps, games)

    expect(result).toMatchObject({ degraded: true, madeInUkraine: 4, previousMadeInUkraine: 4 })
    expect(games.filter((game) => game.madeInUkraine).map((game) => game.id)).toEqual([
      101, 102, 103, 110,
    ])
    expect(
      tonight.logs.some((line) => line.startsWith('::warning title=Studios stage degraded')),
    ).toBe(true)
  })

  it('is not degraded on a first run, with nothing published to fall back on', async () => {
    const harness = createJobHarness()

    const result = await collectStudioGames(harness.deps, await candidatesOf(harness))

    expect(result).toMatchObject({ degraded: false, madeInUkraine: 0, previousMadeInUkraine: null })
  })
})
