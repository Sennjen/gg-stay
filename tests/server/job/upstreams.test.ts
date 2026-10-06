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
