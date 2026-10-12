import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpstreamError } from '../../server/upstream/errors'
import { fixtureRawg, runQuery } from './support/yoga'

/**
 * The upstreams' pacing as the site wires it (`server/utils/rawg.ts`, `steam.ts`,
 * `steamPrices.ts`): RAWG's four requests a second with the burst that only the site is given, and
 * Steam's request per second and a half with none. As in `siteCaches.test.ts`, nothing here is a
 * double of ours except the edges of the process — Nitro's auto-imports and `fetch` — and the
 * clock and the limiters' timers are the test's, so "left together" is a number on the clock.
 *
 * A game page here is the real `game` query through yoga, so its three requests are whatever the
 * resolver sends, in the order it sends them.
 */
const START = 1_700_000_000_000

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
async function recorded(path: string): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await fixtureRawg(path) }
  } catch (error) {
    if (error instanceof UpstreamError) return { status: 404, body: null }
    throw error
  }
}

/**
 * A new instance of the site off Vercel, with memory for a cache, `answer` for RAWG, and a Steam
 * that has nothing to say about any app. Every request is recorded with the moment it left,
 * counted from the start of the case: a RAWG request under its path, Steam's page about an app
 * under `steam/<app id>` and its price under `steam-price/<app id>`.
 */
async function site(answer: (path: string) => Promise<{ status: number; body: unknown }>) {
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
        return new Response(JSON.stringify({ [appId]: { success: true, data: {} } }))
      }
      const path = asked.pathname.replace(/^\/api\//, '')
      wentOut.push([path, Date.now() - START])
      const { status, body } = await answer(path)
      return new Response(JSON.stringify(body), { status })
    }),
  )

  const { useRawg, RAWG_BURST } = await import('../../server/utils/rawg')
  const { useSteam } = await import('../../server/utils/steam')
  // `useSteamPrices` reaches the per-app transport through Nitro's auto-import of it.
  vi.stubGlobal('useSteam', useSteam)
  const { useSteamPrices } = await import('../../server/utils/steamPrices')
  return {
    rawg: useRawg(),
    steam: useSteam(),
    steamPrices: useSteamPrices(),
    RAWG_BURST,
    wentOut,
  }
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
  it('is what it was, on both of its transports: a request per second and a half, and no burst', async () => {
    const { steam, steamPrices, wentOut } = await site(recorded)
    const APPS = ['620', '292030', '413150']

    const calls = [
      ...APPS.map((appId) => steam(appId)),
      ...APPS.map((appId) => steamPrices.fetchPrice(appId)),
    ]
    await advance(3_000)
    await Promise.all(calls)

    // Each transport has a limiter of its own, and neither lets two requests out together.
    for (const what of ['steam', 'steam-price']) {
      expect(wentOut.filter(([asked]) => asked.startsWith(`${what}/`))).toEqual([
        [`${what}/620`, 0],
        [`${what}/292030`, 1_500],
        [`${what}/413150`, 3_000],
      ])
    }
  })
})
