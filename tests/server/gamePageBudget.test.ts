import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../server/index/GameIndex'
import type { IndexedGame } from '../../server/index/document'
import { unavailableGameIndex } from '../../server/index/index'
import {
  GAME_DETAIL_HEDGE_MS,
  GAME_EXTRAS_BUDGET_MS,
  LIVE_PRICE_BUDGET_MS,
} from '../../server/graphql/resolvers/game'
import { STEAM_DESCRIPTION_BUDGET_MS } from '../../server/graphql/resolvers/gameFields'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../../server/rawg/rawgFetch'
import type { SteamPrice } from '../../server/steam/price'
import type { SteamFetch } from '../../server/steam/steamFetch'
import { UpstreamError } from '../../server/upstream/errors'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import { FIXTURE_GAMES } from '../fixtures/index/games'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json' with { type: 'json' }
import {
  countCalls,
  createTestCache,
  fixtureRawg,
  fixtureSteam,
  overriding,
  publishTestIndex,
  runQuery,
  steamPricesReturning,
  TEST_NOW,
  type CountingIndex,
  type QueryResult,
  type TestContext,
} from './support/yoga'

/**
 * The game page's time budget: what the page waits for, for how long, and what it answers with
 * when the time is up. Every case goes through a real GraphQL operation against yoga, on a fake
 * clock — nothing here waits for a real timer, and nothing reads a real clock.
 *
 * Only the timers are faked, as in the catalog's own slow-RAWG cases (`indexResolvers.test.ts`):
 * yoga and the in-memory index run on promises alone. RAWG and Steam are doubles that answer after
 * a time each case chooses, so "RAWG is slow" is a number on the clock rather than a real wait,
 * and a count of the timers still scheduled says exactly what an answer left behind.
 *
 * The game is the RAWG fixture's The Witcher 3 (id 3328, Steam app 292030), and the index holds
 * its development document unless a case says otherwise.
 */

const SLUG = 'the-witcher-3-wild-hunt'
const WITCHER = { slug: SLUG }

/** How long a RAWG request takes here when a case has nothing to say about it. */
const PROMPT_MS = 100

/** The time RAWG's slow path took on production: far past every budget on this page. */
const RAWG_SLOW_MS = 7_000

/** The Witcher 3 as the index holds it: a price three hours old, and its Steam app id. */
const DOCUMENT: IndexedGame = DEV_FIXTURE_GAMES[0]!

/** The same document with a price eight hours old: old enough for the page to ask Steam. */
const DUE_A_REFRESH: IndexedGame = { ...DOCUMENT, priceUpdatedAt: '2026-09-18T01:00:00.000Z' }

/** What Steam says when it is asked, in the cases that let it answer. */
const LIVE: SteamPrice = {
  priceUah: 404,
  regularPriceUah: 1349,
  discountPercent: 70,
  isFree: false,
}

const PAGE = /* GraphQL */ `
  query Page($slug: String!) {
    game(slug: $slug) {
      id
      slug
      name
      description
      released
      rating
      ratingsCount
      metacritic
      playtime
      ageRating
      gameModes
      website
      cover {
        url
      }
      screenshots {
        url
        width
        height
      }
      platformFamilies
      platforms {
        slug
      }
      genres {
        slug
      }
      tags {
        slug
      }
      developers {
        slug
      }
      publishers {
        slug
      }
      stores {
        store
        url
        priceUah
        regularPriceUah
        discountPercent
        isFree
        updatedAt
      }
      localisation {
        text
        audio
        source
      }
      madeInUkraine
      partial
    }
  }
`

const STEAM_URL = 'https://store.steampowered.com/app/292030/'

/** The Steam offer carrying the price the index holds for the game. */
const INDEX_PRICED = {
  store: 'steam',
  url: STEAM_URL,
  priceUah: 675,
  regularPriceUah: 1349,
  discountPercent: 50,
  isFree: false,
  updatedAt: DOCUMENT.priceUpdatedAt,
}

/** The Steam offer carrying the price Steam has just given, dated by this request. */
const LIVE_PRICED = {
  store: 'steam',
  url: STEAM_URL,
  priceUah: 404,
  regularPriceUah: 1349,
  discountPercent: 70,
  isFree: false,
  updatedAt: TEST_NOW,
}

const UNPRICED = {
  priceUah: null,
  regularPriceUah: null,
  discountPercent: null,
  isFree: null,
  updatedAt: null,
}

const GOG = { store: 'gog', url: 'https://www.gog.com/game/the_witcher_3_wild_hunt', ...UNPRICED }

const SCREENSHOTS = [1, 2, 3].map((number) => ({
  url: `https://media.rawg.io/media/screenshots/20100${number}/full${number}.jpg`,
  width: 1920,
  height: 1080,
}))

/** The page as RAWG's three answers and the index entry make it: everything, as it always was. */
const WHOLE_PAGE = {
  id: '3328',
  slug: SLUG,
  name: 'The Witcher 3: Wild Hunt',
  description: detail.description_raw,
  released: '2015-05-18',
  rating: 4.65,
  ratingsCount: 6800,
  metacritic: 92,
  playtime: 43,
  ageRating: 'PEGI18',
  gameModes: ['SINGLE'],
  website: 'https://thewitcher.com/en/witcher3',
  cover: { url: 'https://media.rawg.io/media/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg' },
  screenshots: SCREENSHOTS,
  platformFamilies: ['PC', 'PLAYSTATION', 'NINTENDO'],
  platforms: [{ slug: 'pc' }, { slug: 'playstation5' }, { slug: 'nintendo-switch' }],
  genres: [{ slug: 'action' }, { slug: 'role-playing-games-rpg' }],
  tags: [{ slug: 'singleplayer' }, { slug: 'open-world' }],
  developers: [{ slug: 'cd-projekt-red' }],
  publishers: [{ slug: 'cd-projekt-red' }],
  stores: [INDEX_PRICED, GOG],
  localisation: { text: true, audio: true, source: 'steam' },
  madeInUkraine: false,
  partial: false,
}

/**
 * The page built from the index document alone, field for field as the design's section 3 lists
 * it: what the document carries, its one preview as the only screenshot, one Steam offer from its
 * app id, and nothing where only RAWG has something to say.
 */
const INDEX_PAGE = {
  id: '3328',
  slug: SLUG,
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  ratingsCount: 6800,
  metacritic: 92,
  playtime: 43,
  ageRating: 'PEGI18',
  gameModes: ['SINGLE'],
  cover: { url: 'https://media.rawg.io/media/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg' },
  platformFamilies: ['PC', 'PLAYSTATION', 'NINTENDO'],
  localisation: { text: true, audio: true, source: 'steam' },
  madeInUkraine: false,
  screenshots: [
    {
      url: 'https://media.rawg.io/media/screenshots/155001/screenshot1.jpg',
      width: null,
      height: null,
    },
  ],
  stores: [INDEX_PRICED],
  description: null,
  website: null,
  platforms: [],
  genres: [],
  tags: [],
  developers: [],
  publishers: [],
  partial: true,
}

/** Resolves after `ms` on the fake clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Moves the fake clock on by `ms` and lets everything that became ready run to its end — a real
 * turn of the event loop included, so "the page has not answered yet" is never just yoga not
 * having got round to it.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise((resolve) => setImmediate(resolve))
}

/** The answer, once it is out; `null` while the page is still waiting for something. */
function watch(answer: Promise<QueryResult>): { current: QueryResult | null } {
  const seen: { current: QueryResult | null } = { current: null }
  void answer.then((result) => (seen.current = result))
  return seen
}

/**
 * Asks for the page and moves the clock to the millisecond before `ms`, where the page must still
 * be waiting, and then onto `ms`, where it must have answered: the page goes out at `ms` exactly.
 */
async function pageAt(
  ms: number,
  context: TestContext,
  query: string = PAGE,
  variables: Record<string, unknown> = WITCHER,
): Promise<QueryResult> {
  const answer = runQuery(context, query, variables)
  const seen = watch(answer)
  await advance(ms - 1)
  expect(seen.current, `the page answered before ${ms} ms`).toBeNull()
  await advance(1)
  expect(seen.current, `the page had not answered at ${ms} ms`).not.toBeNull()
  return answer
}

/**
 * Runs `test` with a listener for unhandled rejections, and fails if there was one. A rejection is
 * reported on a later turn of the event loop than the one it happened on, so a real macrotask has
 * to pass before its absence means anything.
 */
async function expectNoUnhandledRejection(test: () => Promise<void>): Promise<void> {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    await test()
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
}

/** What one RAWG request does: answers its fixture after a time, a body of its own, or fails. */
type Reply = number | { after: number; fail: unknown } | { after: number; body: unknown }

interface RawgReplies {
  detail?: Reply
  stores?: Reply
  screenshots?: Reply
}

/** RAWG, each of the page's three requests answered as `replies` says; `paths` is what was asked. */
function rawgAnswering(replies: RawgReplies = {}): RawgFetch & { paths: string[] } {
  const paths: string[] = []
  const replyTo = (path: string): Reply => {
    if (path.endsWith('/stores')) return replies.stores ?? PROMPT_MS
    if (path.endsWith('/screenshots')) return replies.screenshots ?? PROMPT_MS
    return replies.detail ?? PROMPT_MS
  }
  const rawg = (async (path, params, options) => {
    paths.push(path)
    const reply = replyTo(path)
    await elapse(typeof reply === 'number' ? reply : reply.after)
    if (typeof reply !== 'number' && 'fail' in reply) throw reply.fail
    if (typeof reply !== 'number' && 'body' in reply) return reply.body
    return fixtureRawg(path, params, options)
  }) as RawgFetch & { paths: string[] }
  rawg.paths = paths
  return rawg
}

/** Steam's price transport, answering `price` — or failing with it — after `ms`. */
function steamPricesTaking(ms: number, price: SteamPrice | null | Error = LIVE) {
  return steamPricesReturning(async () => {
    await elapse(ms)
    if (price instanceof Error) throw price
    return price
  })
}

/** A published index holding `documents`, with every call to it recorded. */
const indexHolding = async (...documents: IndexedGame[]): Promise<CountingIndex> =>
  countCalls(await publishTestIndex(documents))

/** What the platform's `waitUntil` was handed, as a flag that turns when the work has settled. */
function settlementOf(work: Promise<unknown>): { settled: boolean } {
  const state = { settled: false }
  void work.then(() => (state.settled = true))
  return state
}

const steamOffer = (result: QueryResult) =>
  (result.data!.game.stores as { store: string }[]).find((offer) => offer.store === 'steam')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a game page RAWG answers in time', () => {
  it('is the whole page, as it always was, and leaves nothing behind', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: 400, stores: 650, screenshots: 900 })
    const waitUntil = vi.fn()

    // Out when the last of the three has answered: all of them were inside their budgets.
    const { data, errors } = await pageAt(900, { index, rawg, waitUntil })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    // Both budgets' timers went with the answer.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends the three RAWG requests first, the detail before the others, and each of them once', async () => {
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering()
    const answer = runQuery({ index, rawg }, PAGE, WITCHER)
    await advance(0)

    expect(rawg.paths).toEqual([
      `games/${SLUG}`,
      `games/${SLUG}/stores`,
      `games/${SLUG}/screenshots`,
    ])
    await advance(PROMPT_MS)
    await answer
    expect(rawg.paths).toHaveLength(3)
  })

  it('asks the index beside RAWG, not in front of it: a slow index holds nothing up', async () => {
    const published = await publishTestIndex([DOCUMENT])
    const INDEX_MS = 800
    const index = countCalls(
      overriding(published, {
        meta: async () => {
          await elapse(INDEX_MS)
          return published.meta()
        },
      }),
    )
    const rawg = rawgAnswering()
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    const answer = runQuery({ index, rawg, waitUntil }, PAGE, WITCHER)
    await advance(0)
    // RAWG has been asked for everything while the index has not yet said a word.
    expect(rawg.paths).toHaveLength(3)
    expect(index.calls.idBySlug).toEqual([])

    // The page goes out when RAWG has answered, with the document it read by RAWG's own id.
    await advance(PROMPT_MS)
    const { data, errors } = await answer
    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(index.calls.getOne).toEqual([3328])

    // The lookup by slug was still out, so it was handed over rather than dropped; when it lands
    // it finds the document already read, and reads nothing again.
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const lookup = settlementOf(waitUntil.mock.calls[0]![0])
    await advance(INDEX_MS - PROMPT_MS)
    expect(lookup.settled).toBe(true)
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes RAWG’s answer a millisecond inside the budget, however ready the index is', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: GAME_DETAIL_HEDGE_MS - 1 })

    const { data } = await pageAt(GAME_DETAIL_HEDGE_MS - 1, { index, rawg })

    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(info).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a game the index holds, when RAWG’s detail is late', () => {
  it('is answered from the index document when the budget is spent, and says so', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    const { data, errors } = await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg, waitUntil })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(INDEX_PAGE)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith('[game] RAWG slower than 2500 ms, answered from the index')

    // RAWG was asked once and was not cancelled: the detail was handed over, and settles when RAWG
    // answers — which is when its response reaches the cache for the page's next request.
    expect(rawg.paths).toHaveLength(3)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const handedOver = settlementOf(waitUntil.mock.calls[0]![0])
    // The only timer left is RAWG's own answer; none of the page's budgets is still counting.
    expect(vi.getTimerCount()).toBe(1)
    await advance(RAWG_SLOW_MS - GAME_DETAIL_HEDGE_MS - 1)
    expect(handedOver.settled).toBe(false)
    await advance(1)
    expect(handedOver.settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('offers no store when the document does not know the game’s Steam app', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { steamAppId: _appId, ...withoutAppId } = DOCUMENT
    const index = await indexHolding(withoutAppId)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const { data, errors } = await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({ ...INDEX_PAGE, stores: [] })
  })

  it('has no screenshot to show when the document kept no preview', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding({ ...DOCUMENT, preview: null })
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const { data } = await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg })

    expect(data!.game).toEqual({ ...INDEX_PAGE, screenshots: [] })
  })

  it('withholds a price the index is too stale to vouch for', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    // Eight days since the last price stage: past the seven the index is trusted for.
    const stale = await publishTestIndex([DOCUMENT], {
      updatedAt: '2026-09-18T06:30:00.000Z',
      pricesUpdatedAt: '2026-09-10T09:00:00.000Z',
    })
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const { data } = await pageAt(GAME_DETAIL_HEDGE_MS, { index: stale, rawg })

    // The offer and the language list stay; only the price goes.
    expect(data!.game).toEqual({
      ...INDEX_PAGE,
      stores: [{ store: 'steam', url: STEAM_URL, ...UNPRICED }],
    })
  })

  it('shows the price Steam has just given even when the index is stale', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const stale = await publishTestIndex([DUE_A_REFRESH], {
      updatedAt: '2026-09-18T06:30:00.000Z',
      pricesUpdatedAt: '2026-09-10T09:00:00.000Z',
    })
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })
    const steamPrices = steamPricesTaking(600)

    const { data } = await pageAt(GAME_DETAIL_HEDGE_MS, { index: stale, rawg, steamPrices })

    expect(data!.game).toEqual({ ...INDEX_PAGE, stores: [LIVE_PRICED] })
  })

  it('hands over every RAWG request that is still out, not only the detail', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS, stores: 6_000, screenshots: 5_000 })
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg, waitUntil })

    expect(waitUntil).toHaveBeenCalledTimes(3)
    const handedOver = waitUntil.mock.calls.map(([work]) => settlementOf(work))
    await advance(RAWG_SLOW_MS)
    expect(handedOver.map((work) => work.settled)).toEqual([true, true, true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps its language list, its flag and its similar games, from the one read of its document', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const others = FIXTURE_GAMES.slice(0, 5)
    const index = await indexHolding(
      { ...DOCUMENT, madeInUkraine: true, similar: others.map((game) => game.id) },
      ...others,
    )
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })
    const query = /* GraphQL */ `
      query Page($slug: String!) {
        game(slug: $slug) {
          partial
          madeInUkraine
          localisation {
            text
          }
          similar {
            id
          }
        }
      }
    `

    const { data, errors } = await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg }, query)

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({
      partial: true,
      madeInUkraine: true,
      localisation: { text: true },
      similar: others.map((game) => ({ id: String(game.id) })),
    })
    expect(index.calls.getOne).toEqual([3328])
  })

  it('takes RAWG’s answer when it lands while the index is still being read', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const published = await publishTestIndex([DOCUMENT])
    const INDEX_MS = 3_000
    const RAWG_MS = GAME_DETAIL_HEDGE_MS + 100
    const index = countCalls(
      overriding(published, {
        idBySlug: async (slug) => {
          await elapse(INDEX_MS)
          return published.idBySlug(slug)
        },
      }),
    )
    const rawg = rawgAnswering({ detail: RAWG_MS })

    // Not at the budget — the index had nothing to answer with yet — but the moment RAWG lands,
    // rather than when the index would have.
    const { data, errors } = await pageAt(RAWG_MS, { index, rawg })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(info).not.toHaveBeenCalled()
    expect(rawg.paths).toHaveLength(3)

    // The lookup finishes on its own, quietly, and finds the document already read.
    await advance(INDEX_MS)
    expect(index.calls.getOne).toEqual([3328])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is answered from the index as soon as the index says it holds the game, if that is after the budget', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const published = await publishTestIndex([DOCUMENT])
    const INDEX_MS = 3_000
    const index = overriding(published, {
      idBySlug: async (slug) => {
        await elapse(INDEX_MS)
        return published.idBySlug(slug)
      },
    })
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const { data } = await pageAt(INDEX_MS, { index, rawg })

    expect(data!.game).toEqual(INDEX_PAGE)
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[game] RAWG slower than 2500 ms, answered from the index',
    )
  })

  it('never lets a RAWG failure after the budget surface, with or without a waitUntil', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await expectNoUnhandledRejection(async () => {
      const index = await indexHolding(DOCUMENT)
      const failing = { after: RAWG_SLOW_MS, fail: new Error('RAWG went away') }
      const rawg = rawgAnswering({ detail: failing, stores: failing, screenshots: failing })
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
      const withHook = runQuery({ index, rawg, waitUntil }, PAGE, WITCHER)
      const withoutHook = runQuery({ index, rawg }, PAGE, WITCHER)
      await advance(GAME_DETAIL_HEDGE_MS)
      for (const { data, errors } of await Promise.all([withHook, withoutHook])) {
        expect(errors).toBeUndefined()
        expect(data!.game).toEqual(INDEX_PAGE)
      }

      // What the platform is handed resolves even though RAWG rejected: a platform `waitUntil`
      // that does not catch must never be given a rejection.
      expect(waitUntil).toHaveBeenCalledTimes(3)
      await advance(RAWG_SLOW_MS)
      for (const [work] of waitUntil.mock.calls) await expect(work).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

describe('a game the index cannot answer for, when RAWG’s detail is late', () => {
  /** Waits out RAWG's slow path and expects the page only then, with no word about the index. */
  async function slowPage(context: TestContext): Promise<QueryResult> {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await pageAt(RAWG_SLOW_MS, {
      rawg: rawgAnswering({ detail: RAWG_SLOW_MS }),
      // Steam has no price to add in these cases; what they are about is the wait.
      steamPrices: steamPricesReturning(() => null),
      ...context,
    })
    expect(info).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    return result
  }

  it('waits for RAWG as long as RAWG takes when the index does not hold the game', async () => {
    const index = await indexHolding(...FIXTURE_GAMES)
    const waitUntil = vi.fn()

    const { data, errors } = await slowPage({ index, waitUntil })

    expect(errors).toBeUndefined()
    // The page it always was for a game outside the index: no price, no languages, all of RAWG.
    expect(data!.game).toEqual({
      ...WHOLE_PAGE,
      stores: [{ store: 'steam', url: STEAM_URL, ...UNPRICED }, GOG],
      localisation: null,
    })
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('still asks Steam for the price of a Steam game the index has never seen', async () => {
    const index = await indexHolding(...FIXTURE_GAMES)
    const steamPrices = steamPricesReturning(() => LIVE)

    const { data } = await slowPage({ index, steamPrices })

    expect(steamPrices.calls).toEqual(['292030'])
    expect(data!.game.stores).toEqual([LIVE_PRICED, GOG])
    expect(data!.game.partial).toBe(false)
  })

  it('fails as RAWG fails when RAWG fails late', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(...FIXTURE_GAMES)
    const rawg = rawgAnswering({
      detail: { after: RAWG_SLOW_MS, fail: new UpstreamError('RAWG', 'TIMEOUT') },
    })

    const { data, errors } = await pageAt(RAWG_SLOW_MS, { index, rawg })

    expect(data!.game).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors![0]!.extensions!.code).toBe('UPSTREAM_TIMEOUT')
    expect(info).not.toHaveBeenCalled()
  })

  it('waits for RAWG when no index is configured, without asking it for the slug', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(unavailableGameIndex('nothing is configured'))

    const { data, errors } = await slowPage({ index })

    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({ name: WHOLE_PAGE.name, partial: false, localisation: null })
    // No metadata means nothing to look a slug up in.
    expect(index.calls.idBySlug).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('waits for RAWG when nothing has been published yet', async () => {
    const { data, errors } = await slowPage({})

    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({ name: WHOLE_PAGE.name, partial: false })
  })

  it('waits for RAWG when the lookup fails, warns once and asks the index nothing more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(
      overriding(await publishTestIndex([DOCUMENT]), {
        idBySlug: () => Promise.reject(new Error('ECONNRESET')),
      }),
    )

    const { data, errors } = await slowPage({ index })

    expect(errors).toBeUndefined()
    // The page RAWG gives, without what the index would have added.
    expect(data!.game).toEqual({
      ...WHOLE_PAGE,
      stores: [{ store: 'steam', url: STEAM_URL, ...UNPRICED }, GOG],
      localisation: null,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('could not look its slug up')
    // The request's index has let it down: the document is not asked for by id either.
    expect(index.calls.getOne).toEqual([])
  })

  it('waits for RAWG when the index has already failed in this request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(
      overriding(await publishTestIndex([DOCUMENT]), {
        meta: () => Promise.reject(new Error('ECONNRESET')),
      }),
    )

    const { data, errors } = await slowPage({ index })

    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({ name: WHOLE_PAGE.name, partial: false, localisation: null })
    expect(index.calls.idBySlug).toEqual([])
    expect(index.calls.getOne).toEqual([])
  })

  it('waits for RAWG while the published version has no slugs, and then reads the document by id as before', async () => {
    // The version every deployment starts on: published before the refresh job wrote the slug
    // hash, so it answers `null` for every slug while holding every document.
    const index = countCalls(
      overriding(await publishTestIndex([DOCUMENT]), { idBySlug: async () => null }),
    )

    const { data, errors } = await slowPage({ index })

    expect(errors).toBeUndefined()
    // Nothing the page showed before is lost: the price and the languages are still the index's.
    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
  })

  it('does not answer from a document that carries another slug than the one asked for', async () => {
    // A lookup and a read that straddled a publication: the id the slug stood for now belongs to
    // a document under another address.
    const moved: IndexedGame = { ...DOCUMENT, slug: 'the-witcher-3-game-of-the-year' }
    const index = countCalls(
      overriding(await publishTestIndex([moved]), { idBySlug: async () => 3328 }),
    )

    const { data, errors } = await slowPage({ index })

    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({
      slug: SLUG,
      partial: false,
      description: detail.description_raw,
    })
    expect(index.calls.getOne).toEqual([3328])
  })
})

describe('a detail request that fails', () => {
  const FAILED_502 = { after: 300, fail: new UpstreamError('RAWG', 'ERROR', 502) }
  /** The other two requests have answered by the time the detail fails. */
  const BEFORE_THE_FAILURE = { stores: 50, screenshots: 50 }

  it('is answered from the index for a game the index holds, without waiting for the budget', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: FAILED_502, ...BEFORE_THE_FAILURE })
    const waitUntil = vi.fn()

    const { data, errors } = await pageAt(300, { index, rawg, waitUntil })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(INDEX_PAGE)
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[game] RAWG failed (ERROR), answered from the index',
    )
    // Nothing is still running, and neither budget is still counting.
    expect(waitUntil).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['a rate limit', new UpstreamError('RAWG', 'RATE_LIMITED', 429), 'RATE_LIMITED'],
    ['a timeout', new UpstreamError('RAWG', 'TIMEOUT'), 'TIMEOUT'],
    ['an error that is not the transport’s', new Error('socket hang up'), 'ERROR'],
  ])('names %s in the line about it', async (_name, failure, kind) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: { after: 300, fail: failure }, ...BEFORE_THE_FAILURE })

    const { data } = await pageAt(300, { index, rawg })

    expect(data!.game).toEqual(INDEX_PAGE)
    expect(info).toHaveBeenCalledExactlyOnceWith(
      `[game] RAWG failed (${kind}), answered from the index`,
    )
  })

  it.each([
    ['an empty body', null],
    ['a list', []],
    ['a string', 'Service Unavailable'],
  ])('counts %s under a 200 as a failed detail: the index answers', async (_name, body) => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: { after: 300, body }, ...BEFORE_THE_FAILURE })

    const { data, errors } = await pageAt(300, { index, rawg })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(INDEX_PAGE)
  })

  it('is answered from the index when it fails after the budget, while the index is still being read', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const published = await publishTestIndex([DOCUMENT])
    const INDEX_MS = 3_000
    const index = overriding(published, {
      idBySlug: async (slug) => {
        await elapse(INDEX_MS)
        return published.idBySlug(slug)
      },
    })
    const rawg = rawgAnswering({
      detail: { after: 2_700, fail: new UpstreamError('RAWG', 'ERROR', 502) },
    })

    // RAWG's failure does not end the wait: it leaves the index to answer.
    const { data, errors } = await pageAt(INDEX_MS, { index, rawg })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(INDEX_PAGE)
  })

  it.each([
    ['RATE_LIMITED', 'UPSTREAM_RATE_LIMITED'],
    ['TIMEOUT', 'UPSTREAM_TIMEOUT'],
    ['ERROR', 'UPSTREAM_ERROR'],
  ] as const)(
    'fails the page with %s, as it always did, for a game the index does not hold',
    async (kind, code) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const index = await indexHolding(...FIXTURE_GAMES)
      const rawg = rawgAnswering({
        detail: { after: 300, fail: new UpstreamError('RAWG', kind) },
        ...BEFORE_THE_FAILURE,
      })

      const { data, errors } = await pageAt(300, { index, rawg })

      expect(data!.game).toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors![0]!.extensions!.code).toBe(code)
      expect(info).not.toHaveBeenCalled()
      // The error went out with both budgets' timers cleared.
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('fails the page for a game the index does not hold when RAWG sends an empty body', async () => {
    const index = await indexHolding(...FIXTURE_GAMES)
    const rawg = rawgAnswering({ detail: { after: 300, body: null }, ...BEFORE_THE_FAILURE })

    const { data, errors } = await pageAt(300, { index, rawg })

    expect(data!.game).toBeNull()
    expect(errors![0]).toMatchObject({
      message: 'The data source failed',
      extensions: { code: 'UPSTREAM_ERROR' },
    })
  })

  it('passes RAWG’s “no such game” on, whatever the index holds: that is an answer, not a failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({
      detail: { after: 300, fail: new UpstreamError('RAWG', 'NOT_FOUND', 404) },
      ...BEFORE_THE_FAILURE,
    })

    const { data, errors } = await pageAt(300, { index, rawg })

    expect(data!.game).toBeNull()
    expect(errors![0]!.extensions!.code).toBe('NOT_FOUND')
    expect(info).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a “no such game” that arrives after the budget on as well, if the index has not answered yet', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const published = await publishTestIndex([DOCUMENT])
    const index = overriding(published, {
      idBySlug: async (slug) => {
        await elapse(3_000)
        return published.idBySlug(slug)
      },
    })
    const rawg = rawgAnswering({
      detail: { after: 2_700, fail: new UpstreamError('RAWG', 'NOT_FOUND', 404) },
    })

    const { data, errors } = await pageAt(2_700, { index, rawg })

    expect(data!.game).toBeNull()
    expect(errors![0]!.extensions!.code).toBe('NOT_FOUND')
    expect(info).not.toHaveBeenCalled()
  })

  it('leaves nothing unhandled when the page fails while the other two requests are still out', async () => {
    await expectNoUnhandledRejection(async () => {
      const index = await indexHolding(...FIXTURE_GAMES)
      const late = { after: 4_000, fail: new Error('RAWG went away') }
      const rawg = rawgAnswering({ detail: FAILED_502, stores: late, screenshots: late })
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

      const { errors } = await pageAt(300, { index, rawg, waitUntil })

      expect(errors![0]!.extensions!.code).toBe('UPSTREAM_ERROR')
      // The two the page was no longer going to use are handed over all the same.
      expect(waitUntil).toHaveBeenCalledTimes(2)
      // Only RAWG's two answers are still scheduled; the page's own timers are gone.
      expect(vi.getTimerCount()).toBe(2)
      await advance(4_000)
      for (const [work] of waitUntil.mock.calls) await expect(work).resolves.toBeUndefined()
    })
  })
})

describe('the store links and the screenshots', () => {
  it('are waited for up to the last millisecond of their budget', async () => {
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({
      stores: GAME_EXTRAS_BUDGET_MS - 1,
      screenshots: GAME_EXTRAS_BUDGET_MS - 1,
    })
    const waitUntil = vi.fn()

    const { data } = await pageAt(GAME_EXTRAS_BUDGET_MS - 1, { index, rawg, waitUntil })

    expect(data!.game).toEqual(WHOLE_PAGE)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leave the page partial when the store links are late: the rest is intact, and the request goes on', async () => {
    const index = await indexHolding(DOCUMENT)
    const STORES_MS = 5_000
    const rawg = rawgAnswering({ stores: STORES_MS, screenshots: 200 })
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    // The detail was there at 100 ms; the page waited for the links until the budget, and no more.
    const { data, errors } = await pageAt(GAME_EXTRAS_BUDGET_MS, { index, rawg, waitUntil })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [], partial: true })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const handedOver = settlementOf(waitUntil.mock.calls[0]![0])
    expect(vi.getTimerCount()).toBe(1)
    await advance(STORES_MS - GAME_EXTRAS_BUDGET_MS - 1)
    expect(handedOver.settled).toBe(false)
    await advance(1)
    expect(handedOver.settled).toBe(true)
  })

  it('leave the page partial when the screenshots are late, with its stores and prices in place', async () => {
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ stores: 200, screenshots: 5_000 })
    const waitUntil = vi.fn()

    const { data, errors } = await pageAt(GAME_EXTRAS_BUDGET_MS, { index, rawg, waitUntil })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({ ...WHOLE_PAGE, screenshots: [], partial: true })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('are both handed over when both are late', async () => {
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ stores: 5_000, screenshots: 6_000 })
    const waitUntil = vi.fn()

    const { data } = await pageAt(GAME_EXTRAS_BUDGET_MS, { index, rawg, waitUntil })

    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [], screenshots: [], partial: true })
    expect(waitUntil).toHaveBeenCalledTimes(2)
  })

  it('are not waited for at all once their budget is spent: a later detail takes what has arrived', async () => {
    const index = await indexHolding(DOCUMENT)
    const DETAIL_MS = 2_000
    const rawg = rawgAnswering({ detail: DETAIL_MS, stores: 200, screenshots: 3_000 })

    // Out the moment the detail lands, a second before the screenshots would have.
    const { data } = await pageAt(DETAIL_MS, { index, rawg })

    expect(data!.game).toEqual({ ...WHOLE_PAGE, screenshots: [], partial: true })
  })

  it('count against a game outside the index too, whose detail RAWG took its time over', async () => {
    const index = await indexHolding(...FIXTURE_GAMES)
    const rawg = rawgAnswering({
      detail: RAWG_SLOW_MS,
      stores: 200,
      screenshots: RAWG_SLOW_MS + 500,
    })
    const waitUntil = vi.fn()

    const { data, errors } = await pageAt(RAWG_SLOW_MS, {
      index,
      rawg,
      waitUntil,
      steamPrices: steamPricesReturning(() => null),
    })

    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({ name: WHOLE_PAGE.name, screenshots: [], partial: true })
    expect(data!.game.stores).toHaveLength(2)
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the store links', { stores: { after: 200, fail: new UpstreamError('RAWG', 'ERROR', 500) } }],
    [
      'the screenshots',
      { screenshots: { after: 200, fail: new UpstreamError('RAWG', 'ERROR', 500) } },
    ],
  ])(
    'do not make the page partial when %s fail inside the budget: failed is not late',
    async (_name, replies) => {
      const index = await indexHolding(DOCUMENT)
      const waitUntil = vi.fn()

      const { data, errors } = await pageAt(200, {
        index,
        rawg: rawgAnswering(replies),
        waitUntil,
      })

      expect(errors).toBeUndefined()
      expect(data!.game.partial).toBe(false)
      expect(data!.game.name).toBe(WHOLE_PAGE.name)
      expect(waitUntil).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('never let a failure after the budget surface, with or without a waitUntil', async () => {
    await expectNoUnhandledRejection(async () => {
      const index = await indexHolding(DOCUMENT)
      const late = { after: 5_000, fail: new Error('RAWG went away') }
      const rawg = rawgAnswering({ stores: late, screenshots: late })
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
      const withHook = runQuery({ index, rawg, waitUntil }, PAGE, WITCHER)
      const withoutHook = runQuery({ index, rawg }, PAGE, WITCHER)
      await advance(GAME_EXTRAS_BUDGET_MS)
      for (const { data, errors } of await Promise.all([withHook, withoutHook])) {
        expect(errors).toBeUndefined()
        expect(data!.game.partial).toBe(true)
      }

      expect(waitUntil).toHaveBeenCalledTimes(2)
      await advance(5_000)
      for (const [work] of waitUntil.mock.calls) await expect(work).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

describe('the live Steam price', () => {
  it('is asked for the moment the index document names the app, while RAWG is still out', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({ detail: 1_000, stores: 1_000, screenshots: 1_000 })
    const steamPrices = steamPricesTaking(400)

    const answer = runQuery({ index, rawg, steamPrices }, PAGE, WITCHER)
    await advance(0)
    expect(steamPrices.calls).toEqual(['292030'])

    await advance(1_000)
    const { data, errors } = await answer
    expect(errors).toBeUndefined()
    // Asked once: the page took the answer of the read that was already under way.
    expect(steamPrices.calls).toEqual(['292030'])
    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [LIVE_PRICED, GOG] })
  })

  it('is asked about the app the document names, once, even when RAWG’s link names another', async () => {
    // The refresh job's own mapping is the authority on which app a game is; the page asks about
    // that one from the start and does not ask again about the link's.
    const index = await indexHolding({ ...DUE_A_REFRESH, steamAppId: '292031' })
    const steamPrices = steamPricesTaking(400)

    const { data, errors } = await pageAt(400, { index, rawg: rawgAnswering(), steamPrices })

    expect(errors).toBeUndefined()
    expect(steamPrices.calls).toEqual(['292031'])
    // The price sits on RAWG's own Steam link, which keeps its address.
    expect(steamOffer({ data })).toEqual(LIVE_PRICED)
  })

  it('takes no app id from a document that holds something else in its place', async () => {
    const index = await indexHolding({ ...DUE_A_REFRESH, steamAppId: '292030/../../login' })
    const steamPrices = steamPricesTaking(400)

    const answer = runQuery({ index, rawg: rawgAnswering(), steamPrices }, PAGE, WITCHER)
    await advance(0)
    // Nothing to ask Steam about until RAWG's link names an app.
    expect(steamPrices.calls).toEqual([])
    await advance(PROMPT_MS + 400)
    const { data } = await answer

    expect(steamPrices.calls).toEqual(['292030'])
    expect(steamOffer({ data })).toEqual(LIVE_PRICED)
  })

  it('is not asked for on behalf of an answer that has already been given', async () => {
    const published = await publishTestIndex([DUE_A_REFRESH])
    const INDEX_MS = 800
    const index = overriding(published, {
      idBySlug: async (slug) => {
        await elapse(INDEX_MS)
        return published.idBySlug(slug)
      },
    })
    const rawg = rawgAnswering({
      detail: { after: PROMPT_MS, fail: new UpstreamError('RAWG', 'NOT_FOUND', 404) },
    })
    const steamPrices = steamPricesTaking(400)

    const { errors } = await pageAt(PROMPT_MS, { index, rawg, steamPrices })
    expect(errors![0]!.extensions!.code).toBe('NOT_FOUND')

    // The document turns up after the page has said there is no such game: nobody is left to
    // show a price to, so Steam is not asked for one.
    await advance(INDEX_MS + 400)
    expect(steamPrices.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is not asked for early when the index price is fresh, nor ever', async () => {
    const index = await indexHolding(DOCUMENT)
    const steamPrices = steamPricesTaking(400)

    const { data } = await pageAt(PROMPT_MS, { index, rawg: rawgAnswering(), steamPrices })

    expect(steamPrices.calls).toEqual([])
    expect(steamOffer({ data })).toEqual(INDEX_PRICED)
  })

  it('waits for RAWG’s store links to name the app when the document does not', async () => {
    const { steamAppId: _appId, ...withoutAppId } = DUE_A_REFRESH
    const index = await indexHolding(withoutAppId)
    const steamPrices = steamPricesTaking(400)

    const answer = runQuery({ index, rawg: rawgAnswering(), steamPrices }, PAGE, WITCHER)
    const seen = watch(answer)
    await advance(PROMPT_MS - 1)
    // Nothing says which app to ask about until the links are in.
    expect(steamPrices.calls).toEqual([])
    await advance(1)
    expect(steamPrices.calls).toEqual(['292030'])
    expect(seen.current).toBeNull()

    await advance(400)
    const { data } = await answer
    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [LIVE_PRICED, GOG] })
  })

  it('is on the page when Steam answers within the budget', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const steamPrices = steamPricesTaking(LIVE_PRICE_BUDGET_MS - 1)
    const waitUntil = vi.fn()

    const { data } = await pageAt(LIVE_PRICE_BUDGET_MS - 1, {
      index,
      rawg: rawgAnswering(),
      steamPrices,
      waitUntil,
    })

    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [LIVE_PRICED, GOG] })
    expect(waitUntil).not.toHaveBeenCalled()
    // The price's own budget went with the answer, like the other two.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives way to the index price when Steam is late: dated truthfully, not partial, and still read for the next visitor', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const STEAM_MS = 3_000
    const steamPrices = steamPricesTaking(STEAM_MS)
    const cache = createTestCache()
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    const { data, errors } = await pageAt(LIVE_PRICE_BUDGET_MS, {
      index,
      rawg: rawgAnswering(),
      steamPrices,
      cache,
      waitUntil,
    })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({
      ...WHOLE_PAGE,
      // The index copy, under the timestamp the index gave it eight hours ago.
      stores: [{ ...INDEX_PRICED, updatedAt: DUE_A_REFRESH.priceUpdatedAt }, GOG],
      partial: false,
    })

    // The read was not cancelled. It was handed over, and ends in the six-hour cache entry...
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const handedOver = settlementOf(waitUntil.mock.calls[0]![0])
    expect(cache.writes).toEqual([])
    await advance(STEAM_MS - LIVE_PRICE_BUDGET_MS)
    expect(handedOver.settled).toBe(true)
    expect(cache.writes).toEqual([['steam-price:292030', 21_600]])
    expect(vi.getTimerCount()).toBe(0)

    // ...which is the price the next reader of the page is served, without a word to Steam.
    const next = await pageAt(PROMPT_MS, { index, rawg: rawgAnswering(), steamPrices, cache })
    expect(steamOffer(next)).toEqual(LIVE_PRICED)
    expect(steamPrices.calls).toEqual(['292030'])
  })

  it('leaves an old index price standing on a page RAWG answered, even from an index too stale to price a card', async () => {
    // Nine days since the last price stage. The page shows a price's age beside the price, so an
    // old one is an honest one here; a page built from the same stale index withholds it (above).
    const NINE_DAYS_AGO = '2026-09-09T06:00:00.000Z'
    const stale = await publishTestIndex([{ ...DOCUMENT, priceUpdatedAt: NINE_DAYS_AGO }], {
      updatedAt: '2026-09-18T06:30:00.000Z',
      pricesUpdatedAt: NINE_DAYS_AGO,
    })

    // Steam is asked, being long overdue, and does not answer inside its budget.
    const steamPrices = steamPricesTaking(3_000)
    const { data, errors } = await pageAt(LIVE_PRICE_BUDGET_MS, {
      index: stale,
      rawg: rawgAnswering(),
      steamPrices,
    })

    expect(errors).toBeUndefined()
    expect(steamPrices.calls).toEqual(['292030'])
    expect(data!.game).toEqual({
      ...WHOLE_PAGE,
      stores: [{ ...INDEX_PRICED, updatedAt: NINE_DAYS_AGO }, GOG],
    })
  })

  it('counts its budget from when it was asked for, not from when the page came to need it', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({ detail: 900 })

    // Asked at the start, needed at 900 ms: the page waits another 100 ms, not another second.
    const { data } = await pageAt(LIVE_PRICE_BUDGET_MS, {
      index,
      rawg,
      steamPrices: steamPricesTaking(3_000),
    })

    expect(steamOffer({ data })).toMatchObject({ priceUah: 675 })
    expect(data!.game.partial).toBe(false)
  })

  it('costs the page nothing when its budget ran out while RAWG was still answering', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({ detail: 2_000 })

    const { data } = await pageAt(2_000, { index, rawg, steamPrices: steamPricesTaking(3_000) })

    expect(steamOffer({ data })).toMatchObject({
      priceUah: 675,
      updatedAt: DUE_A_REFRESH.priceUpdatedAt,
    })
  })

  it('has its full budget when it could only start once the store links were in', async () => {
    const { steamAppId: _appId, ...withoutAppId } = DUE_A_REFRESH
    const index = await indexHolding(withoutAppId)
    const waitUntil = vi.fn()

    const { data } = await pageAt(PROMPT_MS + LIVE_PRICE_BUDGET_MS, {
      index,
      rawg: rawgAnswering(),
      steamPrices: steamPricesTaking(3_000),
      waitUntil,
    })

    expect(steamOffer({ data })).toMatchObject({ priceUah: 675 })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('sits on the index-built page too when Steam answered in time', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const { data } = await pageAt(GAME_DETAIL_HEDGE_MS, {
      index,
      rawg,
      steamPrices: steamPricesTaking(400),
    })

    expect(data!.game).toEqual({ ...INDEX_PAGE, stores: [LIVE_PRICED] })
  })

  it('is waited for on an index-built page that could not wait for RAWG, inside its own budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({
      detail: { after: 300, fail: new UpstreamError('RAWG', 'ERROR', 502) },
      stores: 50,
      screenshots: 50,
    })

    // The detail failed at 300 ms; the price that was already being read arrived at 700.
    const inTime = await pageAt(700, { index, rawg, steamPrices: steamPricesTaking(700) })
    expect(inTime.data!.game).toEqual({ ...INDEX_PAGE, stores: [LIVE_PRICED] })
  })

  it('is not waited for when RAWG lists no Steam store to show it on', async () => {
    const index = await indexHolding(DUE_A_REFRESH)
    const rawg = rawgAnswering({ stores: { after: PROMPT_MS, body: { count: 0, results: [] } } })
    const waitUntil = vi.fn()

    // The read began with the document, but the page has nowhere to put its answer.
    const { data, errors } = await pageAt(PROMPT_MS, {
      index,
      rawg,
      steamPrices: steamPricesTaking(600),
      waitUntil,
    })

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual({ ...WHOLE_PAGE, stores: [] })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('never lets a read that fails after its budget surface, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expectNoUnhandledRejection(async () => {
      const index = await indexHolding(DUE_A_REFRESH)
      const steamPrices = steamPricesTaking(3_000, new Error('502 Bad Gateway'))

      const { data, errors } = await pageAt(LIVE_PRICE_BUDGET_MS, {
        index,
        rawg: rawgAnswering(),
        steamPrices,
      })

      expect(errors).toBeUndefined()
      expect(steamOffer({ data })).toMatchObject({ priceUah: 675 })
      await advance(3_000)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

describe('one request for a game', () => {
  it('reads the game’s index document once, however many times it asks for the game', async () => {
    const others = FIXTURE_GAMES.slice(0, 5)
    const index = await indexHolding(
      { ...DOCUMENT, similar: others.map((game) => game.id) },
      ...others,
    )
    const query = /* GraphQL */ `
      query Twice($slug: String!) {
        first: game(slug: $slug) {
          id
          localisation {
            text
          }
          similar {
            id
          }
        }
        second: game(slug: $slug) {
          id
          madeInUkraine
          similar {
            id
          }
        }
      }
    `

    const { data, errors } = await pageAt(PROMPT_MS, { index, rawg: rawgAnswering() }, query)

    expect(errors).toBeUndefined()
    expect(data!.first.similar).toHaveLength(5)
    expect(data!.second.similar).toEqual(data!.first.similar)
    // One lookup, one document read and one metadata read, for both fields and both rows.
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
    expect(index.calls.meta).toBe(1)
  })

  it('reads the document once when the page is built from the index as well', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg })

    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
  })
})

describe('the page asked for again, a few seconds after a partial answer', () => {
  /**
   * The real RAWG transport over a network that takes its time with the detail, so that the
   * request the first answer left running is the very one the second page view finds. Nothing
   * here depends on the transport's own clock — no entry expires within a test — so it stands
   * still, and the limiter's waits run on the fake timers like everything else.
   */
  function rawgOverASlowNetwork(): { rawg: RawgFetch; fetched: string[] } {
    const fetched: string[] = []
    const store = new Map<string, CacheEntry>()
    const rawg = createRawgFetch({
      apiKey: 'test-key',
      fixtures: false,
      fetchJson: async (url) => {
        const path = new URL(url).pathname.replace(/^\/api\//, '')
        fetched.push(path)
        await elapse(path === `games/${SLUG}` ? RAWG_SLOW_MS : PROMPT_MS)
        return { status: 200, body: await fixtureRawg(path) }
      },
      readFixture: async () => null,
      cache: {
        get: async (key) => store.get(key) ?? null,
        set: async (key, entry) => void store.set(key, entry),
      },
      now: () => 0,
      sleep: elapse,
      log: () => {},
    })
    return { rawg, fetched }
  }

  it('collects the answer its first request stopped waiting for, and asks RAWG for nothing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const { rawg, fetched } = rawgOverASlowNetwork()
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    // The first page view is answered from the index at the budget, and leaves the detail running.
    const first = await pageAt(GAME_DETAIL_HEDGE_MS, { index, rawg, waitUntil })
    expect(first.data!.game).toEqual(INDEX_PAGE)
    expect(waitUntil).toHaveBeenCalledTimes(1)

    // Three seconds later the page asks again, as it does for a partial answer. RAWG's detail is
    // still a second and a half away — on the request that has been out since the first view.
    await advance(3_000)
    const second = runQuery({ index, rawg }, PAGE, WITCHER)
    const seen = watch(second)
    await advance(RAWG_SLOW_MS - GAME_DETAIL_HEDGE_MS - 3_000 - 1)
    expect(seen.current).toBeNull()
    await advance(1)
    const { data, errors } = await second

    expect(errors).toBeUndefined()
    expect(data!.game).toEqual(WHOLE_PAGE)
    // One request each, ever: the second page view cost RAWG nothing.
    expect(fetched).toEqual([`games/${SLUG}`, `games/${SLUG}/stores`, `games/${SLUG}/screenshots`])
    expect(vi.getTimerCount()).toBe(0)

    // And from then on the whole page is a matter of milliseconds.
    const third = await runQuery({ index, rawg }, PAGE, WITCHER)
    expect(third.data!.game).toEqual(WHOLE_PAGE)
    expect(fetched).toHaveLength(3)
  })
})

describe('the Ukrainian description', () => {
  const DESCRIPTION = /* GraphQL */ `
    query Description($slug: String!, $locale: String!) {
      game(slug: $slug) {
        slug
        partial
        localizedDescription(locale: $locale) {
          text
          language
          source
        }
      }
    }
  `
  const IN_UKRAINIAN = { ...WITCHER, locale: 'uk' }

  const RAWG_TEXT = { text: detail.description_raw, language: 'en', source: 'RAWG' }

  /** RAWG answering at once, so the clock in these cases is the description's alone. */
  const rawgAtOnce = (): RawgFetch => fixtureRawg

  /** Steam's recorded answers, each after `ms`; `calls` is every app it was asked about. */
  function steamTaking(ms: number): SteamFetch & { calls: string[] } {
    const calls: string[] = []
    const steam = (async (appId, options) => {
      calls.push(appId)
      await elapse(ms)
      return fixtureSteam(appId, options)
    }) as SteamFetch & { calls: string[] }
    steam.calls = calls
    return steam
  }

  it('is Steam’s when Steam answers within the budget', async () => {
    const steam = steamTaking(STEAM_DESCRIPTION_BUDGET_MS - 1)
    const waitUntil = vi.fn()

    const { data, errors } = await pageAt(
      STEAM_DESCRIPTION_BUDGET_MS - 1,
      { rawg: rawgAtOnce(), steam, waitUntil },
      DESCRIPTION,
      IN_UKRAINIAN,
    )

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toMatchObject({ language: 'uk', source: 'STEAM' })
    expect(data!.game.localizedDescription.text).toContain('Ґеральт із Рівії')
    expect(steam.calls).toEqual(['292030'])
    expect(waitUntil).not.toHaveBeenCalled()
    // The budget's timer went with Steam's answer.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back to the RAWG text once the budget is spent, leaves Steam running and the page complete', async () => {
    const STEAM_MS = 4_000
    const steam = steamTaking(STEAM_MS)
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()

    const { data, errors } = await pageAt(
      STEAM_DESCRIPTION_BUDGET_MS,
      { rawg: rawgAtOnce(), steam, waitUntil },
      DESCRIPTION,
      IN_UKRAINIAN,
    )

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)
    // A description in English is a description: nothing RAWG has is missing from this answer.
    expect(data!.game.partial).toBe(false)

    // Steam was asked once and was not cancelled: the request was handed over, and settles when
    // Steam answers — which is when its response reaches the cache for the next reader.
    expect(steam.calls).toEqual(['292030'])
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const handedOver = settlementOf(waitUntil.mock.calls[0]![0])
    await advance(STEAM_MS - STEAM_DESCRIPTION_BUDGET_MS - 1)
    expect(handedOver.settled).toBe(false)
    await advance(1)
    expect(handedOver.settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back at once when Steam fails inside the budget, with nothing left running', async () => {
    const steam: SteamFetch = async () => {
      await elapse(100)
      throw new UpstreamError('STEAM', 'RATE_LIMITED', 429)
    }
    const waitUntil = vi.fn()

    const { data, errors } = await pageAt(
      100,
      { rawg: rawgAtOnce(), steam, waitUntil },
      DESCRIPTION,
      IN_UKRAINIAN,
    )

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never lets a Steam failure after the budget surface, with or without a waitUntil', async () => {
    await expectNoUnhandledRejection(async () => {
      const steam: SteamFetch = async () => {
        await elapse(4_000)
        throw new Error('Steam went away')
      }
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
      const withHook = runQuery({ steam, waitUntil }, DESCRIPTION, IN_UKRAINIAN)
      const withoutHook = runQuery({ steam }, DESCRIPTION, IN_UKRAINIAN)
      await advance(STEAM_DESCRIPTION_BUDGET_MS)
      for (const { data, errors } of await Promise.all([withHook, withoutHook])) {
        expect(errors).toBeUndefined()
        expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)
      }

      // What the platform was handed resolves even though Steam rejected.
      expect(waitUntil).toHaveBeenCalledTimes(1)
      await advance(4_000)
      await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
    })
  })

  it('costs the English page nothing: no Steam request and no timer', async () => {
    const steam = steamTaking(4_000)
    const { data, errors } = await runQuery({ steam }, DESCRIPTION, { ...WITCHER, locale: 'en' })

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)
    expect(steam.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is Steam’s on a page built from the index, which has no RAWG text to fall back to', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    // The page is decided at the detail's budget; the description's own clock starts there.
    const inTime = await pageAt(
      GAME_DETAIL_HEDGE_MS + 400,
      { index, rawg, steam: steamTaking(400) },
      DESCRIPTION,
      IN_UKRAINIAN,
    )
    expect(inTime.data!.game).toMatchObject({
      partial: true,
      localizedDescription: { language: 'uk', source: 'STEAM' },
    })
  })

  it('is absent from a page built from the index when Steam is late too', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await indexHolding(DOCUMENT)
    const rawg = rawgAnswering({ detail: RAWG_SLOW_MS })

    const late = await pageAt(
      GAME_DETAIL_HEDGE_MS + STEAM_DESCRIPTION_BUDGET_MS,
      { index, rawg, steam: steamTaking(4_000) },
      DESCRIPTION,
      IN_UKRAINIAN,
    )

    expect(late.errors).toBeUndefined()
    expect(late.data!.game).toEqual({ slug: SLUG, partial: true, localizedDescription: null })
  })
})

describe('the index, asked the way the site asks it', () => {
  /**
   * The lookup by slug and the read by id are two calls. This pins the order the page makes them
   * in, on an index that records it: the metadata first, then the slug, then the document.
   */
  it('is asked for the metadata, then the slug, then the document — each once', async () => {
    const published = await publishTestIndex([DOCUMENT])
    const order: string[] = []
    const index: GameIndex = overriding(published, {
      meta: () => {
        order.push('meta')
        return published.meta()
      },
      idBySlug: (slug) => {
        order.push(`idBySlug ${slug}`)
        return published.idBySlug(slug)
      },
      getOne: (id) => {
        order.push(`getOne ${id}`)
        return published.getOne(id)
      },
    })

    await pageAt(PROMPT_MS, { index, rawg: rawgAnswering() })

    expect(order).toEqual(['meta', `idBySlug ${SLUG}`, 'getOne 3328'])
  })
})
