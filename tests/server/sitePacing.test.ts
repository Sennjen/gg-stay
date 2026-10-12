import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STEAM_DESCRIPTION_BUDGET_MS } from '../../server/graphql/resolvers/gameFields'
import { UpstreamError } from '../../server/upstream/errors'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import {
  fixtureRawg,
  publishTestIndex,
  runQuery,
  TEST_INDEX_META,
  type QueryResult,
} from './support/yoga'

/**
 * The upstreams' pacing as the site wires it (`server/utils/rawg.ts`, `steam.ts`,
 * `steamPrices.ts`): RAWG's four requests a second and Steam's request per second and a half,
 * each with the burst that only the site is given. As in `siteCaches.test.ts`, nothing here is a
 * double of ours except the edges of the process — Nitro's auto-imports and `fetch` — and the
 * clock and the limiters' timers are the test's, so "left together" is a number on the clock.
 *
 * A game page here is the real `game` query through yoga, so its requests are whatever the
 * resolvers send, in the order they send them.
 */
const START = 1_700_000_000_000

interface Answer {
  status: number
  body: unknown
}

const PAGE = /* GraphQL */ `
  query Page($slug: String!) {
    game(slug: $slug) {
      slug
      stores {
        store
      }
      screenshots {
        url
      }
      partial
    }
  }
`

/** What RAWG answers a path with: the recorded fixture, or a 404 where there is none. */
async function recorded(path: string): Promise<Answer> {
  try {
    return { status: 200, body: await fixtureRawg(path) }
  } catch (error) {
    if (error instanceof UpstreamError) return { status: 404, body: null }
    throw error
  }
}

/** Steam with nothing to say about an app, and saying so at once. */
const nothingToSay = async (appId: string): Promise<Answer> => ({
  status: 200,
  body: { [appId]: { success: true, data: {} } },
})

/**
 * A new instance of the site off Vercel, with memory for a cache, `answer` for RAWG and
 * `steamAnswer` for Steam — which has nothing to say about any app unless a case gives it
 * something. Every request is recorded with the moment it left, counted from the start of the
 * case: a RAWG request under its path, Steam's page about an app under `steam/<app id>` and its
 * price under `steam-price/<app id>`.
 */
async function site(
  answer: (path: string) => Promise<Answer>,
  steamAnswer: (appId: string) => Promise<Answer> = nothingToSay,
) {
  vi.resetModules()
  vi.stubEnv('VERCEL', undefined)
  vi.stubGlobal('useRuntimeConfig', () => ({ rawgApiKey: 'test-key', rawgFixtures: '' }))
  const mounts = new Map<string, Map<string, unknown>>()
  vi.stubGlobal('useStorage', (base: string) => {
    const items = mounts.get(base) ?? new Map<string, unknown>()
    mounts.set(base, items)
    return {
      getItem: async (key: string) => items.get(key) ?? null,
      setItem: async (key: string, value: unknown) => void items.set(key, value),
      removeItem: async (key: string) => void items.delete(key),
    }
  })
  const wentOut: [path: string, at: number][] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const asked = new URL(url)
      if (asked.hostname === 'store.steampowered.com') {
        const appId = asked.searchParams.get('appids')!
        const what = asked.searchParams.has('filters') ? 'steam-price' : 'steam'
        wentOut.push([`${what}/${appId}`, Date.now() - START])
        const { status, body } = await steamAnswer(appId)
        return new Response(JSON.stringify(body), { status })
      }
      const path = asked.pathname.replace(/^\/api\//, '')
      wentOut.push([path, Date.now() - START])
      const { status, body } = await answer(path)
      return new Response(JSON.stringify(body), { status })
    }),
  )

  const { useRawg, RAWG_BURST } = await import('../../server/utils/rawg')
  const { useSteam, STEAM_BURST } = await import('../../server/utils/steam')
  // `useSteamPrices` reaches the per-app transport through Nitro's auto-import of it.
  vi.stubGlobal('useSteam', useSteam)
  const { useSteamPrices } = await import('../../server/utils/steamPrices')
  return {
    rawg: useRawg(),
    steam: useSteam(),
    steamPrices: useSteamPrices(),
    RAWG_BURST,
    STEAM_BURST,
    wentOut,
  }
}

type Site = Awaited<ReturnType<typeof site>>

/** Resolves after `ms` on the test's clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The answer, once it is out; `null` while the page is still waiting for something. */
function watch(answer: Promise<QueryResult>): { current: QueryResult | null } {
  const seen: { current: QueryResult | null } = { current: null }
  void answer.then((result) => (seen.current = result))
  return seen
}

/** Moves the clock on by `ms` and lets everything that became ready run: a real turn included. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  // `setImmediate` stays real, for `advance`; the clock and every timer are the test's.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: START })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('RAWG’s pacing on the site', () => {
  it('has a burst of three: what one game page asks for', async () => {
    expect((await site(recorded)).RAWG_BURST).toBe(3)
  })

  it('lets a game page’s three requests leave together, the game first', async () => {
    const { rawg, wentOut } = await site(recorded)

    const page = runQuery({ rawg }, PAGE, { slug: 'the-witcher-3-wild-hunt' })
    await advance(0)
    expect(wentOut).toEqual([
      ['games/the-witcher-3-wild-hunt', 0],
      ['games/the-witcher-3-wild-hunt/stores', 0],
      ['games/the-witcher-3-wild-hunt/screenshots', 0],
    ])

    const { data, errors } = await page
    expect(errors).toBeUndefined()
    expect(data!.game).toMatchObject({ slug: 'the-witcher-3-wild-hunt', partial: false })
    expect(data!.game.stores).toHaveLength(2)
    expect(data!.game.screenshots).toHaveLength(3)
  })

  it('sends the page asked for right behind it a request per quarter of a second, as before', async () => {
    const { rawg, wentOut } = await site(recorded)

    const pages = [
      runQuery({ rawg }, PAGE, { slug: 'the-witcher-3-wild-hunt' }),
      runQuery({ rawg }, PAGE, { slug: 'stardew-valley' }),
    ]
    await advance(0)
    // The first page spent the allowance; the second has nothing to leave with yet.
    expect(wentOut).toHaveLength(3)

    await advance(750)
    expect(wentOut.slice(3)).toEqual([
      ['games/stardew-valley', 250],
      ['games/stardew-valley/stores', 500],
      ['games/stardew-valley/screenshots', 750],
    ])
    for (const { errors } of await Promise.all(pages)) expect(errors).toBeUndefined()
  })

  it('has the whole burst again once nothing was asked for three quarters of a second', async () => {
    const { rawg, wentOut } = await site(recorded)
    await runQuery({ rawg }, PAGE, { slug: 'the-witcher-3-wild-hunt' })
    await advance(750)

    const page = runQuery({ rawg }, PAGE, { slug: 'stardew-valley' })
    await advance(0)
    expect(wentOut.slice(3)).toEqual([
      ['games/stardew-valley', 750],
      ['games/stardew-valley/stores', 750],
      ['games/stardew-valley/screenshots', 750],
    ])
    await page
  })

  it('says in one line that RAWG refused a request, and does not ask again: the sign to take the burst back', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { rawg, wentOut } = await site(async () => ({ status: 429, body: null }))

    await expect(rawg('games/portal-2')).rejects.toMatchObject({
      source: 'RAWG',
      kind: 'RATE_LIMITED',
      status: 429,
    })

    expect(wentOut).toEqual([['games/portal-2', 0]])
    // The line a count of refusals on production looks for (`RAWG_BURST`).
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[upstream] RAWG games/portal-2 attempt 1: 0 ms, RATE_LIMITED (429)',
    )
  })
})

describe('Steam’s pacing on the site', () => {
  /**
   * The site's two Steam transports, by the name their requests are recorded under, each asked
   * about an app the way a game page asks it.
   */
  const TRANSPORTS: [what: string, ask: (made: Site, appId: string) => Promise<unknown>][] = [
    ['steam', ({ steam }, appId) => steam(appId)],
    ['steam-price', ({ steamPrices }, appId) => steamPrices.fetchPrice(appId)],
  ]

  /** The moments one transport's requests left at, in the order they left. */
  const leftAt = ({ wentOut }: Site, what: string) =>
    wentOut.filter(([asked]) => asked.startsWith(`${what}/`)).map(([, at]) => at)

  /** Asks each of the two transports about `count` apps in one turn, no app twice in a case. */
  function asking(made: Site) {
    let app = 1_000
    return (count: number) =>
      TRANSPORTS.flatMap(([, ask]) => Array.from({ length: count }, () => ask(made, String(app++))))
  }

  it('has a burst of three, one number for both of its transports', async () => {
    expect((await site(recorded)).STEAM_BURST).toBe(3)
  })

  it('lets three requests leave together on each of its transports, and the fourth a second and a half behind them', async () => {
    const { steam, steamPrices, wentOut } = await site(recorded)
    const APPS = ['620', '292030', '413150', '730']

    const calls = [
      ...APPS.map((appId) => steam(appId)),
      ...APPS.map((appId) => steamPrices.fetchPrice(appId)),
    ]
    await advance(1_500)
    await Promise.all(calls)

    // Each transport has a limiter of its own: what one sent took nothing from the other's three.
    for (const what of ['steam', 'steam-price']) {
      expect(wentOut.filter(([asked]) => asked.startsWith(`${what}/`))).toEqual([
        [`${what}/620`, 0],
        [`${what}/292030`, 0],
        [`${what}/413150`, 0],
        [`${what}/730`, 1_500],
      ])
    }
  })

  it.each([
    // A second and a half after a burst the allowance holds one request; after four and a half,
    // all three.
    [1_500, [1_500, 3_000, 4_500, 6_000]],
    [3_000, [3_000, 3_000, 4_500, 6_000]],
    [4_500, [4_500, 4_500, 4_500, 6_000]],
    // And never more than three, however long nothing was asked.
    [3_600_000, [3_600_000, 3_600_000, 3_600_000, 3_601_500]],
  ])(
    'has its allowance back at one request per second and a half: %i ms after a burst',
    async (pause, expected) => {
      const made = await site(recorded)
      const ask = asking(made)
      await Promise.all(ask(3))
      await advance(pause)

      const calls = ask(4)
      await advance(4_500)
      await Promise.all(calls)

      for (const [what] of TRANSPORTS) expect(leftAt(made, what)).toEqual([0, 0, 0, ...expected])
    },
  )

  it('sends no more than 202 requests in any five minutes on either transport: 200 at its pace, and the two of the burst on top', async () => {
    const FIVE_MINUTES = 5 * 60_000
    const made = await site(recorded)

    // More than either limiter lets out in five minutes, all asked for in the same moment.
    const calls = asking(made)(210)
    await advance(FIVE_MINUTES + 15_000)
    await Promise.all(calls)

    for (const [what] of TRANSPORTS) {
      const sent = leftAt(made, what)
      expect(sent).toHaveLength(210)
      const within = (from: number) =>
        sent.filter((at) => at >= from && at < from + FIVE_MINUTES).length
      // The stretch that begins with the burst is the busiest there is (`STEAM_BURST`).
      expect(within(0)).toBe(202)
      expect(Math.max(...sent.map(within))).toBe(202)
    }
  })

  it.each([
    [429, 'RATE_LIMITED'],
    // The transport calls only a 429 a rate limit; a 403 is an error like any other 4xx.
    [403, 'ERROR'],
  ])(
    'says in one line that Steam refused a request with a %i, and does not ask again: the sign to take the burst back',
    async (status, kind) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const refusing = async (): Promise<Answer> => ({ status, body: null })
      const { steam, steamPrices, wentOut } = await site(recorded, refusing)

      await expect(steam('620')).rejects.toMatchObject({ source: 'STEAM', kind, status })
      await expect(steamPrices.fetchPrice('292030')).rejects.toMatchObject({
        source: 'STEAM',
        kind,
        status,
      })

      expect(wentOut).toEqual([
        ['steam/620', 0],
        ['steam-price/292030', 0],
      ])
      // The lines a count of refusals on production looks for (`STEAM_BURST`).
      expect(info.mock.calls).toEqual([
        [`[upstream] STEAM 620 attempt 1: 0 ms, ${kind} (${status})`],
        [`[upstream] STEAM 292030 attempt 1: 0 ms, ${kind} (${status})`],
      ])
    },
  )
})

describe('game pages opened in quick succession, in Ukrainian', () => {
  const DESCRIPTION = /* GraphQL */ `
    query Description($slug: String!) {
      game(slug: $slug) {
        slug
        partial
        localizedDescription(locale: "uk") {
          text
          language
          source
        }
      }
    }
  `

  /** Four games with a Steam page each, which RAWG and the index both hold. */
  const GAMES = ['one', 'two', 'three', 'four'].map((name, number) => ({
    id: 9_001 + number,
    slug: `game-${name}`,
    appId: String(700_001 + number),
  }))

  const IN_ENGLISH = 'What RAWG says about the game.'
  const IN_UKRAINIAN = 'Опис цієї гри українською.'

  /** How long Steam takes over a request here: about what it took on production. */
  const STEAM_MS = 200

  /** RAWG's three answers about each of the games: the game, its Steam link, and no screenshots. */
  async function rawgAbout(path: string): Promise<Answer> {
    const [, slug, part] = path.split('/')
    const game = GAMES.find((candidate) => candidate.slug === slug)
    if (!game) return { status: 404, body: null }
    if (part === 'screenshots') return { status: 200, body: { results: [] } }
    if (part === 'stores') {
      const url = `https://store.steampowered.com/app/${game.appId}/`
      return { status: 200, body: { results: [{ id: 1, game_id: game.id, store_id: 1, url }] } }
    }
    const { id, slug: name } = game
    return { status: 200, body: { id, slug: name, name, description_raw: IN_ENGLISH } }
  }

  /** Steam's page about an app, in Ukrainian, `STEAM_MS` after it was asked for. */
  async function steamInUkrainian(appId: string): Promise<Answer> {
    await elapse(STEAM_MS)
    const data = { short_description: IN_UKRAINIAN }
    return { status: 200, body: { [appId]: { success: true, data } } }
  }

  /**
   * The index holding the four, each with a price three hours old by the clock of the request
   * (`TEST_NOW`): fresh, so a page has one thing to ask Steam for — the description.
   */
  const indexOfTheFour = () =>
    publishTestIndex(
      GAMES.map(({ id, slug, appId }) => ({
        ...DEV_FIXTURE_GAMES[0]!,
        id,
        slug,
        steamAppId: appId,
        priceUpdatedAt: TEST_INDEX_META.pricesUpdatedAt,
      })),
    )

  it('gives three of them Steam’s description without one waiting for another; the fourth waits its second and a half, and goes out with RAWG’s text', async () => {
    const { rawg, steam, steamPrices, wentOut } = await site(rawgAbout, steamInUkrainian)
    const context = { rawg, steam, steamPrices, index: await indexOfTheFour() }

    // What RAWG says about each game is in the instance's memory before the pages are asked for,
    // as it is for a game somebody has opened that day: what is left to wait for is Steam.
    for (const { slug } of GAMES) {
      const path = `games/${slug}`
      await Promise.all([rawg(path), rawg(`${path}/stores`), rawg(`${path}/screenshots`)])
      await advance(750)
    }
    const asked = Date.now() - START
    /** What left for Steam, each request with its moment counted from the pages being asked for. */
    const toSteam = () =>
      wentOut.filter(([what]) => what.startsWith('steam')).map(([what, at]) => [what, at - asked])

    const pages = GAMES.map(({ slug }) => watch(runQuery(context, DESCRIPTION, { slug })))
    const [first, second, third, fourth] = GAMES.map(({ appId }) => `steam/${appId}`)
    await advance(0)
    expect(toSteam()).toEqual([
      [first, 0],
      [second, 0],
      [third, 0],
    ])

    // Three pages are out as soon as Steam has answered: its own fifth of a second, none of ours.
    await advance(STEAM_MS - 1)
    expect(pages.map((page) => page.current)).toEqual([null, null, null, null])
    await advance(1)
    for (const [number, page] of pages.slice(0, 3).entries()) {
      expect(page.current?.errors).toBeUndefined()
      expect(page.current?.data?.game).toEqual({
        slug: GAMES[number]!.slug,
        partial: false,
        localizedDescription: { text: IN_UKRAINIAN, language: 'uk', source: 'STEAM' },
      })
    }

    // The fourth game's request has to wait for the allowance to hold one again, a second and a
    // half after the three left — and a second and a half is all the description is given. So
    // the page goes out then, with RAWG's text and complete, as it did before there was a burst.
    await advance(STEAM_DESCRIPTION_BUDGET_MS - STEAM_MS - 1)
    expect(pages[3]!.current).toBeNull()
    expect(toSteam()).toHaveLength(3)
    await advance(1)
    expect(pages[3]!.current?.errors).toBeUndefined()
    expect(pages[3]!.current?.data?.game).toEqual({
      slug: GAMES[3]!.slug,
      partial: false,
      localizedDescription: { text: IN_ENGLISH, language: 'en', source: 'RAWG' },
    })
    // Its request left in that same moment: the limiter's second and a half, not the budget's.
    expect(toSteam().slice(3)).toEqual([[fourth, 1_500]])

    // Steam's answer, which that page did not wait for, is there for whoever opens it next.
    await advance(STEAM_MS)
    const again = await runQuery(context, DESCRIPTION, { slug: GAMES[3]!.slug })
    expect(again.data?.game.localizedDescription).toMatchObject({ language: 'uk', source: 'STEAM' })
    // Four requests in all, each for a description: no page asked Steam for a price.
    expect(toSteam()).toHaveLength(4)
  })
})
