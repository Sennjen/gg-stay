import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STEAM_DESCRIPTION_BUDGET_MS } from '../../server/graphql/resolvers/gameFields'
import type { SteamFetch } from '../../server/steam/steamFetch'
import { UpstreamError } from '../../server/upstream/errors'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json' with { type: 'json' }
import { fixtureSteam, runQuery, type QueryResult } from './support/yoga'

/**
 * The game page's time budget: what the page waits for, for how long, and what it answers with
 * when the time is up. Every case goes through a real GraphQL operation against yoga, on a fake
 * clock — nothing here waits for a real timer, and nothing reads a real clock.
 *
 * Only the timers are faked, as in the catalog's own slow-RAWG cases (`indexResolvers.test.ts`):
 * yoga and the in-memory index run on promises alone.
 */

const WITCHER = { slug: 'the-witcher-3-wild-hunt' }

/** Resolves after `ms` on the fake clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The answer, once it is out; `null` while the page is still waiting for something. */
function watch(answer: Promise<QueryResult>): { current: QueryResult | null } {
  const seen: { current: QueryResult | null } = { current: null }
  void answer.then((result) => (seen.current = result))
  return seen
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the Ukrainian description', () => {
  const DESCRIPTION = /* GraphQL */ `
    query Description($slug: String!, $locale: String!) {
      game(slug: $slug) {
        slug
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
    const answer = runQuery({ steam, waitUntil }, DESCRIPTION, IN_UKRAINIAN)
    const seen = watch(answer)

    await vi.advanceTimersByTimeAsync(STEAM_DESCRIPTION_BUDGET_MS - 2)
    expect(seen.current).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    const { data, errors } = await answer

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toMatchObject({ language: 'uk', source: 'STEAM' })
    expect(data!.game.localizedDescription.text).toContain('Ґеральт із Рівії')
    expect(steam.calls).toEqual(['292030'])
    expect(waitUntil).not.toHaveBeenCalled()
    // The budget's timer went with Steam's answer.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back to the RAWG text once the budget is spent, and leaves Steam running', async () => {
    const STEAM_MS = 4_000
    const steam = steamTaking(STEAM_MS)
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
    const answer = runQuery({ steam, waitUntil }, DESCRIPTION, IN_UKRAINIAN)
    const seen = watch(answer)

    await vi.advanceTimersByTimeAsync(STEAM_DESCRIPTION_BUDGET_MS - 1)
    expect(seen.current).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    const { data, errors } = await answer

    expect(errors).toBeUndefined()
    expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)

    // Steam was asked once and was not cancelled: the request was handed over, and settles when
    // Steam answers — which is when its response reaches the cache for the next reader.
    expect(steam.calls).toEqual(['292030'])
    expect(waitUntil).toHaveBeenCalledTimes(1)
    let settled = false
    void waitUntil.mock.calls[0]![0].then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(STEAM_MS - STEAM_DESCRIPTION_BUDGET_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back at once when Steam fails inside the budget, with nothing left running', async () => {
    const steam: SteamFetch = async () => {
      await elapse(100)
      throw new UpstreamError('STEAM', 'RATE_LIMITED', 429)
    }
    const waitUntil = vi.fn()
    const answer = runQuery({ steam, waitUntil }, DESCRIPTION, IN_UKRAINIAN)
    await vi.advanceTimersByTimeAsync(100)
    const { data, errors } = await answer

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
      await vi.advanceTimersByTimeAsync(STEAM_DESCRIPTION_BUDGET_MS)
      for (const { data, errors } of await Promise.all([withHook, withoutHook])) {
        expect(errors).toBeUndefined()
        expect(data!.game.localizedDescription).toEqual(RAWG_TEXT)
      }

      // What the platform was handed resolves even though Steam rejected.
      expect(waitUntil).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4_000)
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
})
