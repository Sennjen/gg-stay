import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPacer,
  MIN_GAP_MS,
  parseArgs,
  reportStem,
  REQUEST_TIMEOUT_MS,
  runCases,
  selectCases,
  systemClock,
  type RunDeps,
} from '../../../scripts/eval/ask'
import type { AskCase } from '../../../scripts/eval/askScore'
import recorded from '../../fixtures/eval/ask-answers.json' with { type: 'json' }

/**
 * The live runner's pacing and request handling, on fake timers and a fake `fetch` — nothing here
 * reaches the network. The endpoint allows 10 requests a minute per address, so requests must
 * start at least seven seconds apart however long each takes and however many run at once.
 */

const CASE = (id: string, q = `запит ${id}`): AskCase => ({
  id,
  q,
  locale: 'uk',
  topic: 'test',
  expect: { mode: 'structured', must: { platforms: [7] } },
})

const CASES = [CASE('a'), CASE('b'), CASE('c')]

interface Call {
  at: number
  url: string
  init: RequestInit
}

function fakeFetch(
  respond: (
    call: Call,
    index: number,
  ) =>
    | { afterMs: number; status?: number; body?: unknown; headers?: Record<string, string> }
    | 'hang'
    | 'throw',
) {
  const calls: Call[] = []
  const fetch = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
    const call = { at: Date.now(), url: String(url), init }
    calls.push(call)
    const plan = respond(call, calls.length - 1)
    return new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      )
      if (plan === 'hang') return
      if (plan === 'throw') return reject(new TypeError('fetch failed'))
      setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify(plan.body ?? recorded.coopSwitch), {
              status: plan.status ?? 200,
              headers: { 'content-type': 'application/json', ...plan.headers },
            }),
          ),
        plan.afterMs,
      )
    })
  })
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

function deps(fetch: typeof globalThis.fetch): RunDeps {
  return { fetch, clock: systemClock, log: () => {} }
}

const starts = (calls: Call[]) => calls.map((call) => call.at)

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPacer', () => {
  it('lets the first request through at once and spaces the rest by the gap', async () => {
    const pace = createPacer(MIN_GAP_MS, systemClock)
    const released: number[] = []
    for (let i = 0; i < 3; i++) void pace().then(() => released.push(Date.now()))
    await vi.runAllTimersAsync()
    expect(released).toEqual([0, 7000, 14000])
  })

  it('does not wait when the gap has already passed', async () => {
    const pace = createPacer(MIN_GAP_MS, systemClock)
    await pace()
    await vi.advanceTimersByTimeAsync(10_000)
    const before = Date.now()
    await pace()
    expect(Date.now()).toBe(before)
  })

  it('refuses a gap shorter than the endpoint allows', () => {
    expect(() => createPacer(6_999, systemClock)).toThrow()
  })
})

describe('runCases — pacing', () => {
  it('starts fast requests seven seconds apart', async () => {
    const { calls, fetch } = fakeFetch(() => ({ afterMs: 2000 }))
    const run = runCases(CASES, { baseUrl: 'https://example.test', concurrency: 1 }, deps(fetch))
    await vi.runAllTimersAsync()
    const results = await run
    expect(starts(calls)).toEqual([0, 7000, 14000])
    expect(results.map((result) => result.wallMs)).toEqual([2000, 2000, 2000])
  })

  it('runs one at a time: a slow answer delays the next request', async () => {
    const { calls, fetch } = fakeFetch(() => ({ afterMs: 9000 }))
    const run = runCases(CASES, { baseUrl: 'https://example.test', concurrency: 1 }, deps(fetch))
    await vi.runAllTimersAsync()
    await run
    expect(starts(calls)).toEqual([0, 9000, 18000])
  })

  it('keeps the gap between starts when several run at once', async () => {
    const { calls, fetch } = fakeFetch(() => ({ afterMs: 20_000 }))
    const run = runCases(
      [...CASES, CASE('d')],
      { baseUrl: 'https://example.test', concurrency: 3 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const results = await run
    expect(starts(calls)).toEqual([0, 7000, 14000, 21000])
    expect(results.map((result) => result.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('waits out a 429 for its Retry-After, then asks once more', async () => {
    const { calls, fetch } = fakeFetch((_call, index) =>
      index === 0
        ? {
            afterMs: 100,
            status: 429,
            body: { error: 'RATE_LIMITED' },
            headers: { 'retry-after': '20' },
          }
        : { afterMs: 1000 },
    )
    const run = runCases(
      [CASE('a')],
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const [result] = await run
    expect(starts(calls)).toEqual([0, 20_100])
    expect(result).toMatchObject({ attempts: 2, httpStatus: 200, error: null })
  })

  it('records a second 429 instead of retrying for ever', async () => {
    const { calls, fetch } = fakeFetch(() => ({
      afterMs: 100,
      status: 429,
      body: { error: 'RATE_LIMITED' },
      headers: { 'retry-after': '6' },
    }))
    const run = runCases(
      [CASE('a')],
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const [result] = await run
    expect(calls).toHaveLength(2)
    expect(starts(calls)[1]).toBeGreaterThanOrEqual(MIN_GAP_MS)
    expect(result).toMatchObject({ attempts: 2, httpStatus: 429, error: 'HTTP 429', score: null })
  })
})

describe('runCases — requests and results', () => {
  it('posts the query unchanged with its locale as JSON to /api/ask', async () => {
    const { calls, fetch } = fakeFetch(() => ({ afterMs: 10 }))
    const testCase = CASE('a', '  кооп на свич, 500 грн?  ')
    const run = runCases(
      [testCase],
      { baseUrl: 'https://example.test/', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    await run
    expect(calls[0]?.url).toBe('https://example.test/api/ask')
    expect(calls[0]?.init.method).toBe('POST')
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      q: '  кооп на свич, 500 грн?  ',
      locale: 'uk',
    })
  })

  it('scores each answer and keeps the raw body', async () => {
    const { fetch } = fakeFetch(() => ({ afterMs: 10 }))
    const run = runCases(
      [CASE('a')],
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const [result] = await run
    expect(result?.answer).toEqual(recorded.coopSwitch)
    expect(result?.score?.fields[0]).toMatchObject({ field: 'platforms', pass: true })
    expect(result?.startedAt).toBe(new Date(0).toISOString())
  })

  it('records a body that is not an answer, and carries on', async () => {
    const { fetch } = fakeFetch((_call, index) =>
      index === 0 ? { afterMs: 10, body: { hello: 'world' } } : { afterMs: 10 },
    )
    const run = runCases(
      CASES.slice(0, 2),
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const results = await run
    expect(results[0]).toMatchObject({
      httpStatus: 200,
      error: 'unexpected answer shape',
      score: null,
    })
    expect(results[1]?.score).not.toBeNull()
  })

  it('records a network failure and carries on', async () => {
    const { fetch } = fakeFetch((_call, index) => (index === 0 ? 'throw' : { afterMs: 10 }))
    const run = runCases(
      CASES.slice(0, 2),
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.runAllTimersAsync()
    const results = await run
    expect(results[0]).toMatchObject({ httpStatus: null, error: 'fetch failed' })
    expect(results[1]?.error).toBeNull()
  })

  it(`gives up on a request after ${REQUEST_TIMEOUT_MS / 1000} s`, async () => {
    const { fetch } = fakeFetch(() => 'hang')
    const run = runCases(
      [CASE('a')],
      { baseUrl: 'https://example.test', concurrency: 1 },
      deps(fetch),
    )
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1)
    let settled = false
    void run.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const [result] = await run
    expect(result).toMatchObject({ error: 'timeout', httpStatus: null, wallMs: REQUEST_TIMEOUT_MS })
  })
})

describe('parseArgs', () => {
  it('reads the base URL, a case list and the concurrency', () => {
    expect(
      parseArgs([
        '--base-url',
        'https://gg-stay.vercel.app',
        '--only',
        'a,b',
        '--concurrency',
        '2',
      ]),
    ).toEqual({ baseUrl: 'https://gg-stay.vercel.app', only: ['a', 'b'], concurrency: 2 })
    expect(parseArgs(['--base-url=http://localhost:3000'])).toEqual({
      baseUrl: 'http://localhost:3000',
      only: null,
      concurrency: 1,
    })
  })

  it('skips the separator pnpm may pass through', () => {
    expect(parseArgs(['--', '--base-url', 'https://example.test']).baseUrl).toBe(
      'https://example.test',
    )
  })

  it.each([
    ['no base URL', []],
    ['a base URL that is not http', ['--base-url', 'ftp://example.test']],
    ['a zero concurrency', ['--base-url', 'https://example.test', '--concurrency', '0']],
    ['an unknown flag', ['--base-url', 'https://example.test', '--provider', 'openrouter']],
    ['an empty case list', ['--base-url', 'https://example.test', '--only', ',']],
  ])('refuses %s', (_what, argv) => {
    expect(() => parseArgs(argv)).toThrow()
  })
})

describe('selectCases', () => {
  it('keeps the file order and only the named cases', () => {
    expect(selectCases(CASES, ['c', 'a']).map((testCase) => testCase.id)).toEqual(['a', 'c'])
    expect(selectCases(CASES, null)).toHaveLength(3)
  })

  it('refuses an id the file does not have', () => {
    expect(() => selectCases(CASES, ['a', 'zzz'])).toThrow(/zzz/)
  })
})

describe('reportStem', () => {
  it('names a run by its date and never overwrites an earlier one', async () => {
    expect(await reportStem('2026-10-03', () => false)).toBe('eval-2026-10-03')
    const taken = new Set(['eval-2026-10-03', 'eval-2026-10-03-2'])
    expect(await reportStem('2026-10-03', (stem) => taken.has(stem))).toBe('eval-2026-10-03-3')
  })
})
