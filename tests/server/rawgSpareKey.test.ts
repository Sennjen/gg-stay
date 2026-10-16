import { describe, expect, it, vi } from 'vitest'
import { createRawgFetch, type CacheEntry, type RawgDeps } from '../../server/rawg/rawgFetch'

/**
 * RAWG's spare key (`server/rawg/rawgKeys.ts`), through the transport both the site and the job
 * build (`createRawgFetch`): a 401 or a 403 to a request with the main key sends it again with the
 * spare one, and every request after it goes with the spare one; nothing else switches.
 */

const MAIN = 'main-secret-key'
const SPARE = 'spare-secret-key'

type Answer = number | 'timeout'

/**
 * A transport over a RAWG that answers a request with the main key by the next of `main`, and one
 * with the spare key by the next of `spare` — the last of each for good.
 */
function transport(main: Answer[], spare: Answer[] = [200], overrides: Partial<RawgDeps> = {}) {
  const store = new Map<string, CacheEntry>()
  const lines: string[] = []
  const sent: string[] = []
  const switches: number[] = []
  let clock = 1_000_000
  const next = (answers: Answer[]) => (answers.length > 1 ? answers.shift()! : answers[0]!)
  const fetchJson = vi.fn(async (url: string) => {
    sent.push(url)
    const key = new URL(url).searchParams.get('key')
    const answer = next(key === SPARE ? spare : main)
    if (answer === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    return { status: answer, body: answer === 200 ? { id: 1 } : { detail: 'refused' } }
  })
  const sleep = vi.fn(async (ms: number) => void (clock += ms))
  const rawg = createRawgFetch({
    apiKey: MAIN,
    spareApiKey: SPARE,
    fixtures: false,
    fetchJson,
    readFixture: async () => null,
    cache: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, entry) => void store.set(key, entry),
    },
    now: () => clock,
    sleep,
    log: (line) => void lines.push(line),
    onKeySwitch: (status) => void switches.push(status),
    ...overrides,
  })
  /** Which key each request went with, in order. */
  const keys = () => sent.map((url) => new URL(url).searchParams.get('key'))
  return { rawg, store, lines, sent, keys, switches, sleep }
}

describe('RAWG’s spare key', () => {
  it.each([401, 403])(
    'sends a request the main key was refused with (%i) once more with the spare key',
    async (status) => {
      const { rawg, keys, lines, switches } = transport([status])

      expect(await rawg('games/portal-2')).toEqual({ id: 1 })

      expect(keys()).toEqual([MAIN, SPARE])
      expect(lines).toEqual([
        `[upstream] RAWG main key refused (${status}), switched to the spare key`,
      ])
      expect(switches).toEqual([status])
    },
  )

  it('sends every later request with the spare key, and writes the line once', async () => {
    const { rawg, keys, lines, switches } = transport([401])

    await rawg('games/portal-2')
    await rawg('games/portal-2/stores')
    await rawg('games', { page: 2 })

    expect(keys()).toEqual([MAIN, SPARE, SPARE, SPARE])
    expect(lines).toHaveLength(1)
    expect(switches).toEqual([401])
  })

  it('sends again with the spare key the requests that left with the main one before the switch', async () => {
    // Three at once, as the site's game page asks: each leaves with the main key before RAWG has
    // refused any of them, and each is refused.
    const sent: string[] = []
    let release!: () => void
    const allOut = new Promise<void>((resolve) => (release = resolve))
    const { rawg, lines } = transport([], [], {
      burst: 3,
      fetchJson: async (url) => {
        sent.push(url)
        if (new URL(url).searchParams.get('key') === SPARE) return { status: 200, body: { id: 1 } }
        if (sent.length === 3) release()
        await allOut
        return { status: 401, body: null }
      },
    })
    const keys = () => sent.map((url) => new URL(url).searchParams.get('key'))

    const answers = await Promise.all([
      rawg('games/portal-2'),
      rawg('games/portal-2/stores'),
      rawg('games/portal-2/screenshots'),
    ])

    expect(answers).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }])
    expect(keys().filter((key) => key === MAIN)).toHaveLength(3)
    expect(keys().filter((key) => key === SPARE)).toHaveLength(3)
    expect(lines).toHaveLength(1)
  })

  it.each<[string, Answer, Answer[]]>([
    ['a 429', 429, [429]],
    ['a 500', 500, [500, 500]],
    ['a 502', 502, [502, 502]],
    ['a timeout', 'timeout', ['timeout', 'timeout']],
    ['a 404', 404, [404]],
    ['a 400', 400, [400]],
  ])('does not switch on %s, and fails as it always did', async (_what, answer, expected) => {
    const { rawg, keys, lines, switches } = transport([answer])

    await expect(rawg('games/portal-2')).rejects.toMatchObject({ source: 'RAWG' })

    // The transport's own rule, untouched: a 5xx and a timeout are retried once, the rest are not —
    // and every request went with the main key.
    expect(keys()).toEqual(expected.map(() => MAIN))
    expect(lines.some((line) => line.includes('switched'))).toBe(false)
    expect(switches).toEqual([])
  })

  it('is no retry: a 5xx after the switch still has the call’s one retry, with the spare key', async () => {
    const { rawg, keys } = transport([401], [502, 200])

    expect(await rawg('games/portal-2')).toEqual({ id: 1 })

    // Main refused, spare 502 — the attempt's answer — then the retry, with the spare key.
    expect(keys()).toEqual([MAIN, SPARE, SPARE])
  })

  it('takes its own slot at the limiter', async () => {
    const { rawg, sleep } = transport([401])

    await rawg('games/portal-2')

    // The first request had an idle limiter; the second waits out the interval like any other.
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('fails as it always did when no spare key is configured', async () => {
    const { rawg, keys, lines } = transport([401], [200], { spareApiKey: '' })

    await expect(rawg('games/portal-2')).rejects.toMatchObject({
      source: 'RAWG',
      kind: 'ERROR',
      status: 401,
    })

    expect(keys()).toEqual([MAIN])
    expect(lines).toEqual(['[upstream] RAWG games/portal-2 attempt 1: 0 ms, ERROR (401)'])
  })

  it.each([401, 403])(
    'fails with the spare key’s refusal (%i) when it is refused too',
    async (status) => {
      const { rawg, keys, lines } = transport([401], [status])

      await expect(rawg('games/portal-2')).rejects.toMatchObject({ kind: 'ERROR', status })
      // And a later request goes with the spare key, refused or not: there is no switching back.
      await expect(rawg('games/portal-2/stores')).rejects.toMatchObject({ status })

      expect(keys()).toEqual([MAIN, SPARE, SPARE])
      expect(lines).toEqual([
        '[upstream] RAWG main key refused (401), switched to the spare key',
        `[upstream] RAWG games/portal-2 attempt 1: 0 ms, ERROR (${status})`,
        `[upstream] RAWG games/portal-2/stores attempt 1: 0 ms, ERROR (${status})`,
      ])
    },
  )

  it('keeps neither key in a log line, an error, or the cache', async () => {
    const { rawg, store, lines } = transport([401], [200, 403])

    await rawg('games', { page: 2, search: 'portal' })
    const failed = await rawg('games/portal-2').catch((error: unknown) => error)

    const said = [...lines, String(failed), JSON.stringify(failed), JSON.stringify([...store])]
    for (const text of said) {
      expect(text).not.toContain(MAIN)
      expect(text).not.toContain(SPARE)
    }
    // An answer is kept under the key it would have had with the main key.
    expect([...store.keys()]).toEqual(['games?page=2&search=portal'])
  })
})
