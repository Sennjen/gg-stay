import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpstreamFetch,
  SLOW_ATTEMPT_MS,
  type UpstreamCacheEntry,
  type UpstreamConfig,
  type UpstreamRuntime,
} from '../../server/upstream/createUpstreamFetch'
import { UpstreamError } from '../../server/upstream/errors'

/**
 * The shared transport on its own, for what neither RAWG's nor Steam's share of it decides: which
 * calls are one request, and what it writes down about an attempt that failed or was slow.
 * `rawgFetch.test.ts` and `steamFetch.test.ts` cover the rest through the two transports built on
 * it.
 *
 * The network here answers when a test says so. A request stays on the wire until its entry in
 * `sent` is answered or failed, which is what lets a test make a second call while the first is
 * still running — and move the clock while a request is out — without a timer and without a wait.
 */

interface Request {
  key: string
  timeoutMs?: number
  maxAttempts?: number
  ttl?: number
}

const config: UpstreamConfig<Request> = {
  source: 'RAWG',
  minIntervalMs: 250,
  timeoutMs: 5_000,
  maxAttempts: 2,
  buildUrl: ({ key }) => `https://upstream.test/${key}`,
  cacheKey: ({ key }) => key,
  fixtureName: ({ key }) => key,
  ttlFor: ({ ttl }) => ttl ?? 600,
  limitsFor: ({ timeoutMs, maxAttempts }) =>
    timeoutMs === undefined && maxAttempts === undefined ? undefined : { timeoutMs, maxAttempts },
}

interface SentRequest {
  url: string
  answer: (status: number, body?: unknown) => void
  fail: (error: Error) => void
}

function makeRuntime(overrides: Partial<UpstreamRuntime> = {}) {
  const store = new Map<string, UpstreamCacheEntry>()
  const sent: SentRequest[] = []
  const log = vi.fn<(line: string) => void>()
  let clock = 1_000_000
  const runtime = {
    fixtures: false,
    fetchJson: vi.fn(
      (url: string) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          sent.push({
            url,
            answer: (status, body = null) => resolve({ status, body }),
            fail: reject,
          })
        }),
    ),
    readFixture: vi.fn(async () => null),
    cache: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, entry: UpstreamCacheEntry) => void store.set(key, entry)),
    },
    now: () => clock,
    sleep: vi.fn(async (ms: number) => void (clock += ms)),
    log,
    ...overrides,
  } satisfies UpstreamRuntime
  return {
    runtime,
    store,
    sent,
    advance: (ms: number) => void (clock += ms),
    /** Every line the transport has written so far, in order. */
    lines: () => log.mock.calls.map(([line]) => line),
  }
}

/**
 * Lets everything that is ready to run, run: the cache read and the limiter in front of a request,
 * or the retry behind a failed one. A turn of the event loop, not a wait.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a request that is already in flight', () => {
  it('is shared by every call for the same key made while it is running', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const first = fetchUpstream({ key: 'games/portal-2' })
    const second = fetchUpstream({ key: 'games/portal-2' })
    await settle()
    expect(sent).toHaveLength(1)

    // A caller that arrives while the request is on the wire joins it as well.
    const third = fetchUpstream({ key: 'games/portal-2' })
    await settle()
    expect(sent).toHaveLength(1)

    sent[0]!.answer(200, { id: 4200 })
    const answers = await Promise.all([first, second, third])
    expect(answers).toEqual([{ id: 4200 }, { id: 4200 }, { id: 4200 }])
    expect(runtime.fetchJson).toHaveBeenCalledTimes(1)
    // One request means one cache write and one limiter slot, not one per caller.
    expect(runtime.cache.set).toHaveBeenCalledTimes(1)
    expect(runtime.sleep).not.toHaveBeenCalled()
  })

  it('costs the limiter one slot, so a different request behind it waits one interval', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const calls = [
      fetchUpstream({ key: 'games/portal-2' }),
      fetchUpstream({ key: 'games/portal-2' }),
      fetchUpstream({ key: 'games/portal-2/stores' }),
    ]
    await settle()
    expect(sent.map((request) => request.url)).toEqual([
      'https://upstream.test/games/portal-2',
      'https://upstream.test/games/portal-2/stores',
    ])
    expect(vi.mocked(runtime.sleep).mock.calls).toEqual([[250]])

    for (const request of sent) request.answer(200, {})
    await Promise.all(calls)
  })

  it('is not shared with a call for another key', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const detail = fetchUpstream({ key: 'games/portal-2' })
    const stores = fetchUpstream({ key: 'games/portal-2/stores' })
    await settle()
    expect(sent).toHaveLength(2)

    sent[0]!.answer(200, { id: 4200 })
    sent[1]!.answer(200, { results: [] })
    expect(await detail).toEqual({ id: 4200 })
    expect(await stores).toEqual({ results: [] })
  })

  it('is not shared with a call under different limits', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const patient = fetchUpstream({ key: 'games' })
    const hurried = fetchUpstream({ key: 'games', timeoutMs: 4_000, maxAttempts: 1 })
    await settle()
    expect(sent).toHaveLength(2)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([5_000, 4_000])

    // The hurried caller's single attempt ends without dragging the patient caller along, and
    // without being given the patient caller's retry.
    sent[1]!.fail(timeoutError())
    await expect(hurried).rejects.toMatchObject({ kind: 'TIMEOUT' })
    expect(sent).toHaveLength(2)

    sent[0]!.answer(200, { ok: true })
    expect(await patient).toEqual({ ok: true })
  })

  it('is not shared when only one of the two limits differs', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const calls = [
      fetchUpstream({ key: 'games' }),
      fetchUpstream({ key: 'games', timeoutMs: 4_000 }),
      fetchUpstream({ key: 'games', maxAttempts: 1 }),
    ]
    await settle()
    expect(sent).toHaveLength(3)

    for (const request of sent) request.answer(200, {})
    await Promise.all(calls)
  })

  it('is shared with a call that asks for the defaults by name', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const plain = fetchUpstream({ key: 'games' })
    const spelledOut = fetchUpstream({ key: 'games', timeoutMs: 5_000, maxAttempts: 2 })
    await settle()
    expect(sent).toHaveLength(1)

    sent[0]!.answer(200, { ok: true })
    expect(await Promise.all([plain, spelledOut])).toEqual([{ ok: true }, { ok: true }])
  })

  it('is over once it has answered: the next call sends a request of its own', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    // A ttl of zero keeps the cache out of it, so only the in-flight entry could answer twice.
    const first = fetchUpstream({ key: 'games', ttl: 0 })
    await settle()
    sent[0]!.answer(200, { round: 1 })
    expect(await first).toEqual({ round: 1 })

    const second = fetchUpstream({ key: 'games', ttl: 0 })
    await settle()
    expect(sent).toHaveLength(2)
    sent[1]!.answer(200, { round: 2 })
    expect(await second).toEqual({ round: 2 })
  })
})

describe('a request in flight that fails', () => {
  it('fails every caller that was waiting for it, after one request and its one retry', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const outcomes = [fetchUpstream({ key: 'games' }), fetchUpstream({ key: 'games' })].map(
      (call) =>
        call.then(
          () => null,
          (error: unknown) => error,
        ),
    )
    await settle()
    sent[0]!.answer(502)
    await settle()
    sent[1]!.answer(502)

    const [first, second] = await Promise.all(outcomes)
    expect(first).toBeInstanceOf(UpstreamError)
    expect(first).toMatchObject({ kind: 'ERROR', status: 502 })
    expect(second).toBe(first)
    expect(runtime.fetchJson).toHaveBeenCalledTimes(2)
  })

  it('is not shared with a later caller, who asks the upstream again', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const failed = fetchUpstream({ key: 'games', maxAttempts: 1 })
    await settle()
    sent[0]!.answer(503)
    await expect(failed).rejects.toMatchObject({ kind: 'ERROR', status: 503 })

    const later = fetchUpstream({ key: 'games', maxAttempts: 1 })
    await settle()
    expect(sent).toHaveLength(2)
    sent[1]!.answer(200, { ok: true })
    expect(await later).toEqual({ ok: true })
  })

  it('is already forgotten when its failure reaches the first caller', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)

    // The caller asks again from the very handler its failure arrives in — the earliest moment
    // anyone can know the request failed.
    const retried = fetchUpstream({ key: 'games', maxAttempts: 1 }).catch(() =>
      fetchUpstream({ key: 'games', maxAttempts: 1 }),
    )
    await settle()
    sent[0]!.answer(503)
    await settle()
    expect(sent).toHaveLength(2)

    sent[1]!.answer(200, { ok: true })
    expect(await retried).toEqual({ ok: true })
  })

  it('gives every waiting caller the stale entry the first one fell back to', async () => {
    const { runtime, sent, store } = makeRuntime()
    store.set('games', { value: { stale: true }, expiresAt: 0 })
    const fetchUpstream = createUpstreamFetch(config, runtime)

    const calls = [fetchUpstream({ key: 'games' }), fetchUpstream({ key: 'games' })]
    await settle()
    sent[0]!.answer(500)
    await settle()
    sent[1]!.answer(500)

    expect(await Promise.all(calls)).toEqual([{ stale: true }, { stale: true }])
    expect(runtime.fetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('the line about an attempt', () => {
  /** One call under `request`, whose attempts end as `steps` say, each after `takes` on the clock. */
  async function run(
    request: Request,
    steps: { takes: number; status?: number; body?: unknown; error?: Error }[],
  ) {
    const made = makeRuntime()
    const outcome = createUpstreamFetch(
      config,
      made.runtime,
    )(request).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    for (const [position, step] of steps.entries()) {
      await settle()
      made.advance(step.takes)
      if (step.error) made.sent[position]!.fail(step.error)
      else made.sent[position]!.answer(step.status ?? 200, step.body ?? {})
    }
    return { ...made, outcome: await outcome }
  }

  it('is written for an attempt that timed out, and again for the retry that did', async () => {
    const { lines, outcome } = await run({ key: 'games/portal-2' }, [
      { takes: 5_000, error: timeoutError() },
      { takes: 5_001, error: timeoutError() },
    ])
    expect(outcome).toMatchObject({ error: { kind: 'TIMEOUT' } })
    expect(lines()).toEqual([
      '[upstream] RAWG games/portal-2 attempt 1: 5000 ms, TIMEOUT',
      '[upstream] RAWG games/portal-2 attempt 2: 5001 ms, TIMEOUT',
    ])
  })

  it.each([
    ['a 5xx', { takes: 40, status: 502 }, 'ERROR (502)'],
    ['a rate limit', { takes: 12, status: 429 }, 'RATE_LIMITED (429)'],
    ['a 4xx that is not a 404', { takes: 3, status: 403 }, 'ERROR (403)'],
    ['a request that never got an answer', { takes: 7, error: new Error('ECONNRESET') }, 'ERROR'],
  ])('is written for %s, however quickly it failed', async (_name, step, ending) => {
    const { lines, outcome } = await run({ key: 'games', maxAttempts: 1 }, [step])
    expect(outcome).toHaveProperty('error')
    expect(lines()).toEqual([`[upstream] RAWG games attempt 1: ${step.takes} ms, ${ending}`])
  })

  it('is written for an answer that took two seconds, and not for one a millisecond faster', async () => {
    const slow = await run({ key: 'games' }, [{ takes: SLOW_ATTEMPT_MS, body: { ok: true } }])
    expect(slow.outcome).toEqual({ value: { ok: true } })
    expect(slow.lines()).toEqual(['[upstream] RAWG games attempt 1: 2000 ms, OK'])

    const brisk = await run({ key: 'games' }, [{ takes: SLOW_ATTEMPT_MS - 1, body: { ok: true } }])
    expect(brisk.outcome).toEqual({ value: { ok: true } })
    expect(brisk.lines()).toEqual([])
  })

  it('numbers the attempts of one call, so a slow retry reads as the second', async () => {
    const { lines, outcome } = await run({ key: 'games/portal-2/stores' }, [
      { takes: 30, status: 503 },
      { takes: 2_400, body: { results: [] } },
    ])
    expect(outcome).toEqual({ value: { results: [] } })
    expect(lines()).toEqual([
      '[upstream] RAWG games/portal-2/stores attempt 1: 30 ms, ERROR (503)',
      '[upstream] RAWG games/portal-2/stores attempt 2: 2400 ms, OK',
    ])
  })

  it('is not written for a 404, which is an answer, unless the 404 itself was slow', async () => {
    const quick = await run({ key: 'games/nope' }, [{ takes: 80, status: 404 }])
    expect(quick.outcome).toMatchObject({ error: { kind: 'NOT_FOUND' } })
    expect(quick.lines()).toEqual([])

    const slow = await run({ key: 'games/nope' }, [{ takes: 2_300, status: 404 }])
    expect(slow.lines()).toEqual(['[upstream] RAWG games/nope attempt 1: 2300 ms, NOT_FOUND (404)'])
  })

  it('times the upstream, not the wait for a slot in the limiter', async () => {
    const { runtime, sent, advance, lines } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games/a' })
    await settle()
    sent[0]!.answer(200, {})
    await first

    // Asked for straight away, so the limiter holds this one back an interval before sending it.
    const second = fetchUpstream({ key: 'games/b', maxAttempts: 1 }).catch(() => null)
    await settle()
    expect(vi.mocked(runtime.sleep).mock.calls).toEqual([[250]])
    advance(10)
    sent[1]!.answer(500)
    await second
    expect(lines()).toEqual(['[upstream] RAWG games/b attempt 1: 10 ms, ERROR (500)'])
  })

  it('names the path of the cache key and leaves the rest of the request out', async () => {
    const secretive: UpstreamConfig<Request> = {
      ...config,
      buildUrl: ({ key }) => `https://upstream.test/${key}&key=an-api-key`,
    }
    const { runtime, sent, lines } = makeRuntime()
    const call = createUpstreamFetch(
      secretive,
      runtime,
    )({
      key: 'games?page=2&search=half%20life',
      maxAttempts: 1,
    }).catch(() => null)
    await settle()
    expect(sent[0]!.url).toBe(
      'https://upstream.test/games?page=2&search=half%20life&key=an-api-key',
    )
    sent[0]!.answer(500)
    await call

    expect(lines()).toEqual(['[upstream] RAWG games attempt 1: 0 ms, ERROR (500)'])
    for (const hidden of [
      'an-api-key',
      'key=',
      'https://',
      'upstream.test',
      'search',
      'half',
      '?',
    ]) {
      expect(lines()[0]).not.toContain(hidden)
    }
  })

  it('cuts a path of any length to a fixed one', async () => {
    const { lines } = await run({ key: `games/${'x'.repeat(5_000)}?page=1`, maxAttempts: 1 }, [
      { takes: 1, status: 500 },
    ])
    expect(lines()).toEqual([
      `[upstream] RAWG games/${'x'.repeat(114)}… attempt 1: 1 ms, ERROR (500)`,
    ])
  })

  it('is written once for a request several callers shared, and never for a cached answer', async () => {
    const { runtime, sent, advance, lines } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const calls = [fetchUpstream({ key: 'games' }), fetchUpstream({ key: 'games' })]
    await settle()
    advance(3_000)
    sent[0]!.answer(200, { ok: true })
    await Promise.all(calls)
    expect(lines()).toEqual(['[upstream] RAWG games attempt 1: 3000 ms, OK'])

    // Still fresh in the cache: no request, so nothing to say, however long ago that was.
    advance(60_000)
    expect(await fetchUpstream({ key: 'games' })).toEqual({ ok: true })
    expect(lines()).toHaveLength(1)
  })

  it('says which upstream it was', async () => {
    const { runtime, sent, lines } = makeRuntime()
    const steam = createUpstreamFetch({ ...config, source: 'STEAM' }, runtime)
    const call = steam({ key: '292030', maxAttempts: 1 }).catch(() => null)
    await settle()
    sent[0]!.answer(502)
    await call
    expect(lines()).toEqual(['[upstream] STEAM 292030 attempt 1: 0 ms, ERROR (502)'])
  })

  it('goes to console.info when nothing else was asked for', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { runtime, sent } = makeRuntime({ log: undefined })
    const call = createUpstreamFetch(
      config,
      runtime,
    )({ key: 'games', maxAttempts: 1 }).catch(() => null)
    await settle()
    sent[0]!.answer(500)
    await call
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[upstream] RAWG games attempt 1: 0 ms, ERROR (500)',
    )
  })
})
