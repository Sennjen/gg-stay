import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_PAGE_SIZE,
  carryPublishedForward,
  collectCandidates,
  indexTags,
  isStoreTag,
  moodTagsFrom,
  MAX_INDEXED_TAGS,
  MIN_TAG_GAMES_COUNT,
  previewOf,
  toIndexedGame,
} from '../../../scripts/index/candidates'
import type { IndexedGame } from '../../../server/index/document'
import { JOB_GAMES, JOB_PAGE_COUNT, jobGamesPage } from '../../fixtures/index/jobCatalog'
import { createJobHarness, createTransportRawg } from './harness'

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
      // `singleplayer` is already the game mode and `steam-achievements` describes the store;
      // `atmospheric` carries no language, as the hand-written fixture has it, and is kept.
      tags: ['atmospheric', 'story-rich'],
      // Both are mood tags as well, kept for the ask facets whatever the cut above keeps.
      moodTags: ['atmospheric', 'story-rich'],
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

  it('asks again for a page RAWG answered without a result list, and carries on', async () => {
    const harness = createJobHarness()
    const secondPage = (call: { path: string; params: Record<string, string> }) =>
      call.path === 'games' && call.params.page === '2'
    harness.answerNextWith(secondPage, null)

    const result = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })

    expect(harness.pageCalls().filter(secondPage)).toHaveLength(2)
    expect(result.games.map((game) => game.id)).toEqual(JOB_GAMES.map((game) => game.id))
  })

  it('reaches RAWG again through the real transport when a page came back empty', async () => {
    const harness = createJobHarness()
    const transport = createTransportRawg([null, jobGamesPage(1)])

    const result = await collectCandidates({ ...harness.deps, rawg: transport.rawg }, { pages: 1 })

    expect(transport.urls).toHaveLength(2)
    expect(result.games.map((game) => game.id)).toEqual([101, 102, 103])
  })

  it('fails the stage, naming the page, when RAWG answers it without a result list twice', async () => {
    const harness = createJobHarness()
    const secondPage = (call: { path: string; params: Record<string, string> }) =>
      call.path === 'games' && call.params.page === '2'
    harness.answerNextWith(secondPage, null)
    harness.answerNextWith(secondPage, { count: 0, next: null })

    await expect(collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })).rejects.toThrow(
      /page 2/,
    )
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

  it('leaves the made-in-Ukraine flag to the studios stage, whatever was published', async () => {
    const harness = createJobHarness()
    const version = await harness.writer.beginVersion()
    await harness.writer.writeVersion(version, [
      { ...published, madeInUkraine: true },
      { ...published, id: 102, slug: 'neon-district', madeInUkraine: false },
    ])
    await harness.writer.publish(version, {
      version,
      updatedAt: '2026-09-19T21:00:00.000Z',
      pricesUpdatedAt: '2026-09-19T21:00:00.000Z',
      gameCount: 2,
    })
    const { games } = await collectCandidates(harness.deps, { pages: 1 })
    // The studios stage has already marked 102 in this run (an appended game is carried forward
    // after it is flagged); 101's studio is no longer on the list.
    games.find((game) => game.id === 102)!.madeInUkraine = true

    await carryPublishedForward(harness.deps, games)

    expect(games.find((game) => game.id === 101)?.madeInUkraine).toBe(false)
    expect(games.find((game) => game.id === 102)?.madeInUkraine).toBe(true)
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

describe('indexTags', () => {
  const eng = (slug: string, gamesCount?: number) => ({
    id: slug.length,
    slug,
    name: slug,
    language: 'eng',
    ...(gamesCount === undefined ? {} : { games_count: gamesCount }),
  })

  it('drops a tag in another language and keeps the English ones', () => {
    expect(
      indexTags([
        eng('post-apocalyptic'),
        { id: 1, slug: 'postapokalipsis', name: 'Постапокалипсис', language: 'rus' },
        eng('survival-horror'),
      ]),
    ).toEqual(['post-apocalyptic', 'survival-horror'])
  })

  it('keeps a tag that names no language at all, as the recorded fixtures carry them', () => {
    // Nothing here proves every live tag carries `language`; a tag without one is taken as English
    // rather than silently emptying every document. Only an explicit other language is dropped.
    expect(
      indexTags([
        { id: 1, slug: 'post-apocalyptic', name: 'Post-apocalyptic' },
        { id: 2, slug: 'steam-cloud', name: 'Steam Cloud' },
        { id: 3, slug: 'singleplayer', name: 'Singleplayer' },
        { id: 4, slug: 'postapokalipsis', name: 'Постапокалипсис', language: 'rus' },
        { id: 5, slug: 'survival-horror', name: 'Survival Horror', language: 'eng' },
      ]),
    ).toEqual(['post-apocalyptic', 'survival-horror'])
  })

  it('drops the tags that describe the store rather than the game', () => {
    const store = [
      'steam-achievements',
      'full-controller-support',
      'steam-cloud',
      'steam-trading-cards',
      'partial-controller-support',
      'steam-leaderboards',
      'controller-support',
      'in-app-purchases',
      'steam-workshop',
      'includes-level-editor',
      'remote-play-together',
      'remote-play-on-tv',
      'family-sharing',
      'cloud-saves',
      'valve-anti-cheat-enabled',
      'steam-turn-notifications',
      'steamvr-collectibles',
      'tracked-controller-support',
      'captions-available',
      'commentary-available',
      'stats',
      'exclusive',
      'true-exclusive',
      'early-access',
    ]
    for (const slug of store) expect(isStoreTag(slug), slug).toBe(true)
    expect(indexTags([...store.map((slug) => eng(slug)), eng('steampunk')])).toEqual(['steampunk'])
  })

  it('leaves the game modes to the game-mode field', () => {
    expect(
      indexTags(
        ['singleplayer', 'multiplayer', 'online-co-op', 'local-co-op', 'co-op'].map((slug) =>
          eng(slug),
        ),
      ),
    ).toEqual(['co-op'])
  })

  it(`drops the long tail, then keeps the ${MAX_INDEXED_TAGS} rarest, in RAWG's order`, () => {
    // RAWG lists a game's tags most common first, so "atmospheric" leads and "post-apocalyptic"
    // trails; the defining tags are the rarer ones. Below the floor, a tag is noise too rare to
    // recur among the indexed games.
    const tags = [
      ...Array.from({ length: 16 }, (_, n) => eng(`tag-${n}`, 20_000 - n * 1_000)),
      eng('long-tail-a', MIN_TAG_GAMES_COUNT - 1),
      eng('long-tail-b', 5),
      eng('just-above-the-floor', MIN_TAG_GAMES_COUNT),
    ]
    const kept = indexTags(tags)
    expect(kept).toEqual([...tags.slice(5, 16).map((tag) => tag.slug), 'just-above-the-floor'])
    expect(kept).toHaveLength(MAX_INDEXED_TAGS)
    expect(MIN_TAG_GAMES_COUNT).toBe(100)
  })

  it('keeps the defining tags of a well-tagged game over the generic ones', () => {
    const metro = [
      eng('atmospheric', 34_000),
      eng('horror', 45_000),
      eng('first-person', 30_000),
      eng('story-rich', 20_000),
      eng('exploration', 20_000),
      eng('sci-fi', 18_000),
      eng('dark', 15_000),
      eng('fps', 13_000),
      eng('survival-horror', 8_500),
      eng('survival', 8_000),
      eng('open-world', 7_500),
      eng('stealth', 5_000),
      eng('great-soundtrack', 4_600),
      eng('post-apocalyptic', 4_200),
      eng('volga-river', 12),
    ]
    const kept = indexTags(metro)
    expect(kept).toContain('post-apocalyptic')
    expect(kept).toContain('survival-horror')
    expect(kept).not.toContain('horror')
    expect(kept).not.toContain('volga-river')
  })

  it('keeps every mood tag apart from the cut, the broad ones included', () => {
    const metro = [
      eng('atmospheric', 34_000),
      eng('horror', 45_000),
      eng('first-person', 30_000),
      { id: 9, slug: 'uzhasy', name: 'Ужасы', language: 'rus' },
      eng('survival-horror', 8_500),
      eng('horror', 45_000),
      eng('chernobyl', 700),
    ]
    expect(moodTagsFrom(metro)).toEqual(['atmospheric', 'horror', 'survival-horror'])
    expect(moodTagsFrom(null)).toEqual([])
  })

  it('drops the long tail even when the game has few tags', () => {
    expect(
      indexTags([eng('fps', 13_000), eng('volga-river', 12), eng('ray-tracing', 350)]),
    ).toEqual(['fps', 'ray-tracing'])
  })

  it("keeps RAWG's order when it gave no counts, and survives no tags at all", () => {
    const tags = Array.from({ length: 20 }, (_, n) => eng(`tag-${n}`))
    expect(indexTags(tags)).toEqual(tags.slice(0, MAX_INDEXED_TAGS).map((tag) => tag.slug))
    expect(indexTags(null)).toEqual([])
    expect(indexTags(undefined)).toEqual([])
    expect(indexTags([eng(''), eng('fps'), eng('fps')])).toEqual(['fps'])
  })

  it('reaches the index document through the one mapper', () => {
    expect(
      toIndexedGame({
        id: 1,
        slug: 'a',
        tags: [eng('singleplayer'), eng('steam-cloud'), eng('post-apocalyptic')],
      }),
    ).toMatchObject({ tags: ['post-apocalyptic'], gameModes: ['SINGLE'] })
  })
})
