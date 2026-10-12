import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobClock } from '../../../scripts/index/deps'
import { parseUsdRate } from '../../../scripts/index/bank'
import { walkGogCatalog } from '../../../scripts/index/gog'
import { parseMicrosoftProducts } from '../../../scripts/index/microsoft'
import {
  createJobBank,
  createJobGog,
  createJobMicrosoft,
  createJobRawg,
  createJobSteam,
  STORE_USER_AGENT,
} from '../../../scripts/index/upstreams'

/**
 * The transports the refresh job builds for itself. They are the site's transports with a plain
 * `fetch` under them, and the one thing the job decides differently is what they write: nothing.
 * A stage reports every upstream failure itself, through the job's log; the transports' own line
 * about an attempt is for the site.
 */

/** A network that answers every request with `status` and `body`. */
function stubNetwork(status: number, body: unknown) {
  const network = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', network)
  return network
}

/** A clock on which every attempt appears to take `perRead` milliseconds per look at it. */
function clockAdvancingBy(perRead: number): JobClock {
  let now = 0
  return { now: () => (now += perRead), sleep: async () => {} }
}

const options = (clock: JobClock) => ({ apiKey: 'test-key', fixtures: false, clock })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the refresh job’s transports', () => {
  it('write no line of their own about a failed attempt, on any of the three paths', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = stubNetwork(502, null)
    const clock = clockAdvancingBy(0)
    const rawg = createJobRawg(options(clock))
    const steam = createJobSteam(options(clock))

    // Each fails after its one retry, and each failure is the stage's to report.
    await expect(rawg('games', { page: 1 })).rejects.toMatchObject({
      source: 'RAWG',
      kind: 'ERROR',
      status: 502,
    })
    await expect(steam.fetchPrices(['292030'])).rejects.toMatchObject({ source: 'STEAM' })
    await expect(steam.fetchAppLanguages('292030')).rejects.toMatchObject({ source: 'STEAM' })

    expect(network).toHaveBeenCalledTimes(6)
    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('keep the pacing they always had, with no burst: that is the site’s alone', async () => {
    stubNetwork(200, { results: [] })
    // A clock that stands still until the case moves it, so each wait is how far behind the first
    // request of its round a slot was.
    let now = 0
    const waits: number[] = []
    const clock: JobClock = { now: () => now, sleep: async (ms) => void waits.push(ms) }
    const rawg = createJobRawg(options(clock))
    const steam = createJobSteam(options(clock))

    // RAWG: a request per quarter of a second, the first three included.
    await Promise.all([1, 2, 3, 4].map((page) => rawg('games', { page })))
    expect(waits.splice(0)).toEqual([250, 500, 750])

    // Steam's prices, four chunks of them, and Steam's page about four apps: each a request per
    // second and a half, the first three included. On the site three would leave together and
    // the fourth a second and a half behind them (`STEAM_BURST`).
    const prices = () => steam.fetchPrices(Array.from({ length: 350 }, (_, id) => String(id)))
    const pagesAbout = (apps: string[]) =>
      Promise.all(apps.map((appId) => steam.fetchAppLanguages(appId)))
    await prices()
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
    await pagesAbout(['620', '292030', '413150', '730'])
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])

    // And an hour of rest earns them nothing: a burst is an allowance an idle limiter holds, and
    // the job's hold none.
    now += 3_600_000
    await prices()
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
    await pagesAbout(['400', '570', '220', '440'])
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
  })

  it('write no line about a slow attempt either: how long an upstream took is the site’s question', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    stubNetwork(200, { results: [] })
    // Every look at the clock is three seconds on, so each attempt reads as a slow one.
    const clock = clockAdvancingBy(3_000)

    expect(await createJobRawg(options(clock))('games', { page: 1 })).toEqual({ results: [] })
    expect((await createJobSteam(options(clock)).fetchPrices(['292030'])).get('292030')).toBeNull()

    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})

/**
 * The three transports only the job has: GOG's catalog, the Microsoft Store's display catalog and
 * the National Bank's rate. None of the three documents its endpoint for third parties, so how
 * the job behaves towards them is a rule of its own: it says who it is, it never hurries, and it
 * can be run in full without touching any of them.
 */
describe('the refresh job’s transports to GOG, the Microsoft Store and the National Bank', () => {
  const storeOptions = (clock: JobClock, fixtures = false) => ({ fixtures, clock })
  const still: JobClock = { now: () => 0, sleep: async () => {} }

  it('name the project and its repository on every request', async () => {
    const network = stubNetwork(200, { Products: [] })

    await createJobGog(storeOptions(still))(1)
    await createJobMicrosoft(storeOptions(still))(['BTQMHK78ZPF9'])
    await createJobBank(storeOptions(still))('2026-10-12')

    expect(STORE_USER_AGENT).toMatch(/^gg-stay-index-refresh\//)
    expect(STORE_USER_AGENT).toContain('https://github.com/Sennjen/gg-stay')
    const requests = network.mock.calls as unknown as [string, RequestInit][]
    expect(requests.map(([url]) => new URL(url).host)).toEqual([
      'catalog.gog.com',
      'displaycatalog.mp.microsoft.com',
      'bank.gov.ua',
    ])
    for (const [, init] of requests) {
      expect(init.headers).toMatchObject({ 'User-Agent': STORE_USER_AGENT })
      // Nothing that identifies anybody else: no key, no cookie, no token.
      expect(Object.keys(init.headers as object).sort()).toEqual(['Accept', 'User-Agent'])
    }
  })

  it('send a request a second to each of them, and never two together', async () => {
    stubNetwork(200, { Products: [] })
    let now = 0
    const waits: number[] = []
    const clock: JobClock = { now: () => now, sleep: async (ms) => void waits.push(ms) }
    const gog = createJobGog(storeOptions(clock))
    const microsoft = createJobMicrosoft(storeOptions(clock))
    const bank = createJobBank(storeOptions(clock))

    await Promise.all([1, 2, 3].map((page) => gog(page)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
    await Promise.all(['BTQMHK78ZPF9', '9NP1P1WFS0LB', '9PP5G1F0C2B6'].map((id) => microsoft([id])))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
    await Promise.all(['2026-10-10', '2026-10-11', '2026-10-12'].map((day) => bank(day)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])

    // An hour of rest earns no burst here either.
    now += 3_600_000
    await Promise.all([4, 5, 6].map((page) => gog(page)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
  })

  it('write no line of their own about a failed or a slow attempt', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = stubNetwork(503, null)
    // Every look at the clock is three seconds on, so each attempt reads as a slow one too.
    const clock = clockAdvancingBy(3_000)

    await expect(createJobGog(storeOptions(clock))(1)).rejects.toMatchObject({
      source: 'GOG',
      kind: 'ERROR',
      status: 503,
    })
    await expect(createJobMicrosoft(storeOptions(clock))(['BTQMHK78ZPF9'])).rejects.toMatchObject({
      source: 'MICROSOFT',
    })
    await expect(createJobBank(storeOptions(clock))('2026-10-12')).rejects.toMatchObject({
      source: 'NBU',
    })

    // One retry each, and the stage that asked is the one to say what it cost.
    expect(network).toHaveBeenCalledTimes(6)
    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('serve the recorded answers in fixture mode, and ask the network nothing', async () => {
    const network = stubNetwork(200, null)
    const recordedAt = Date.parse('2026-10-12T14:04:00.000Z')
    const options = storeOptions(still, true)

    const walk = await walkGogCatalog(createJobGog(options))
    const products = await createJobMicrosoft(options)(['BTQMHK78ZPF9'])

    expect([...walk.products.keys()]).toEqual([
      'the_witcher_3_redkit',
      'the_witcher_3_wild_hunt_game_of_the_year_edition',
      'the_witcher_3_wild_hunt_songs_of_the_past',
    ])
    expect(
      parseMicrosoftProducts(products, ['BTQMHK78ZPF9'], recordedAt).get('BTQMHK78ZPF9'),
    ).toEqual({
      price: { amount: 25_000, regularAmount: 25_000, discountPercent: 0 },
      title: 'LIMBO',
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('serve the recorded rate under whatever day is asked for, so a dry run always has one', async () => {
    const network = stubNetwork(200, null)
    const bank = createJobBank(storeOptions(still, true))

    // The recording is dated 13.10.2026; served as it is, only that one day would ever read it.
    expect(parseUsdRate(await bank('2026-10-12'), '2026-10-12')).toBe(44.9567)
    expect(parseUsdRate(await bank('2027-03-01'), '2027-03-01')).toBe(44.9567)
    expect(await bank('2027-03-01')).toMatchObject([
      { cc: 'USD', r030: 840, exchangedate: '01.03.2027' },
    ])
    expect(network).not.toHaveBeenCalled()
  })

  it('leave RAWG and Steam as they were asked before: no header of the job’s', async () => {
    const network = stubNetwork(200, { results: [] })

    await createJobRawg(options(still))('games', { page: 1 })

    expect((network.mock.calls as unknown as [string, RequestInit][])[0]![1]).toEqual({
      signal: expect.any(AbortSignal),
    })
  })
})
