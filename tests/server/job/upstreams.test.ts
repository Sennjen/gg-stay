import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobClock } from '../../../scripts/index/deps'
import { createJobRawg, createJobSteam } from '../../../scripts/index/upstreams'

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
    // A clock that stands still, so each wait is how far behind the first request a slot was.
    const waits: number[] = []
    const clock: JobClock = { now: () => 0, sleep: async (ms) => void waits.push(ms) }
    const rawg = createJobRawg(options(clock))
    const steam = createJobSteam(options(clock))

    // RAWG: a request per quarter of a second, the first three included.
    await Promise.all([1, 2, 3, 4].map((page) => rawg('games', { page })))
    expect(waits.splice(0)).toEqual([250, 500, 750])

    // Steam's prices, three chunks of them, and Steam's page about an app: each a request per
    // second and a half.
    await steam.fetchPrices(Array.from({ length: 250 }, (_, id) => String(id)))
    expect(waits.splice(0)).toEqual([1_500, 3_000])
    await Promise.all(['620', '292030', '413150'].map((appId) => steam.fetchAppLanguages(appId)))
    expect(waits.splice(0)).toEqual([1_500, 3_000])
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
