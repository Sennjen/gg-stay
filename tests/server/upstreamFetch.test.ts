import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpstreamFetch,
  isShareable,
  SHAREABLE_MIN_TTL_SECONDS,
  SLOW_ATTEMPT_MS,
  STALE_WHILE_REVALIDATE_SECONDS,
  type SharedRead,
  type UpstreamCacheEntry,
  type UpstreamConfig,
  type UpstreamRuntime,
} from '../../server/upstream/createUpstreamFetch'
import { UpstreamError } from '../../server/upstream/errors'

/**
 * The shared transport on its own, for what neither RAWG's nor Steam's share of it decides: which
 * calls are one request, what it writes down about an attempt that failed or was slow, how an
 * answer is served inside its stale window, and what it passes on of a cache that has a second
 * level. `rawgFetch.test.ts` and `steamFetch.test.ts` cover the rest through the two transports
 * built on it.
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

/** Whether `work` has settled yet, without waiting for it. */
function watch(work: Promise<unknown>) {
  const seen = { settled: false }
  const mark = () => void (seen.settled = true)
  work.then(mark, mark)
  return seen
}

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

  it('is forgotten when the call fails before anything is sent, on a cache that cannot be read', async () => {
    const { runtime, sent, store } = makeRuntime()
    let broken = true
    vi.mocked(runtime.cache.get).mockImplementation(async (key: string) => {
      if (broken) throw new Error('the storage driver is broken')
      return store.get(key) ?? null
    })
    const fetchUpstream = createUpstreamFetch(config, runtime)

    // Two callers, one call: both get its failure, and nothing reached the network.
    const calls = [fetchUpstream({ key: 'games' }), fetchUpstream({ key: 'games' })]
    for (const call of calls) await expect(call).rejects.toThrow('the storage driver is broken')
    expect(runtime.cache.get).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)

    // The entry went with the failure, so the next call starts over instead of joining it.
    broken = false
    const next = fetchUpstream({ key: 'games' })
    await settle()
    expect(sent).toHaveLength(1)
    sent[0]!.answer(200, { ok: true })
    expect(await next).toEqual({ ok: true })
  })

  it('is forgotten when the call fails before anything is sent, on a request that cannot be built', async () => {
    let buildable = false
    const fragile: UpstreamConfig<Request> = {
      ...config,
      buildUrl: (request) => {
        if (!buildable) throw new Error('no address for this request')
        return config.buildUrl(request)
      },
    }
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(fragile, runtime)

    const calls = [fetchUpstream({ key: 'games' }), fetchUpstream({ key: 'games' })]
    for (const call of calls) await expect(call).rejects.toThrow('no address for this request')
    expect(sent).toHaveLength(0)

    buildable = true
    const next = fetchUpstream({ key: 'games' })
    await settle()
    expect(sent).toHaveLength(1)
    sent[0]!.answer(200, { ok: true })
    expect(await next).toEqual({ ok: true })
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

describe('a caller that asks to be told when its answer came from the cache', () => {
  /** Answers every request that is out, so a call that reached the upstream can settle. */
  const answerAll = async (sent: SentRequest[], status = 200, body: unknown = { ok: true }) => {
    await settle()
    for (const request of sent.splice(0)) request.answer(status, body)
  }

  it('is told when a fresh entry answered, and the upstream was not asked for it', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games' })
    await answerAll(sent)
    await first

    const onCached = vi.fn()
    expect(await fetchUpstream({ key: 'games' }, onCached)).toEqual({ ok: true })
    expect(onCached).toHaveBeenCalledTimes(1)
    expect(runtime.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('has been told by the time its answer arrives', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games' })
    await answerAll(sent)
    await first

    // Whoever measures a call decides what it was in the handler its answer arrives in.
    const onCached = vi.fn()
    const told = fetchUpstream({ key: 'games' }, onCached).then(() => onCached.mock.calls.length)
    expect(await told).toBe(1)
  })

  it('is not told about an answer the upstream gave', async () => {
    const { runtime, sent } = makeRuntime()
    const onCached = vi.fn()
    const call = createUpstreamFetch(config, runtime)({ key: 'games' }, onCached)
    await answerAll(sent)
    expect(await call).toEqual({ ok: true })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('is not told when the entry had expired and the upstream was asked again', async () => {
    const { runtime, sent, advance } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games' })
    await answerAll(sent)
    await first

    advance(601_000)
    const onCached = vi.fn()
    const second = fetchUpstream({ key: 'games' }, onCached)
    await answerAll(sent, 200, { ok: 'again' })
    expect(await second).toEqual({ ok: 'again' })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('is not told when the upstream failed and a stale entry stood in for it', async () => {
    const { runtime, sent, store } = makeRuntime()
    store.set('games', { value: { stale: true }, expiresAt: 0 })
    const onCached = vi.fn()
    const call = createUpstreamFetch(config, runtime)({ key: 'games', maxAttempts: 1 }, onCached)
    await answerAll(sent, 500)

    // The answer is the cache's, but the caller waited for the upstream to fail first.
    expect(await call).toEqual({ stale: true })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('is not told when the call fails', async () => {
    const { runtime, sent } = makeRuntime()
    const onCached = vi.fn()
    const call = createUpstreamFetch(config, runtime)({ key: 'games', maxAttempts: 1 }, onCached)
    await answerAll(sent, 503)
    await expect(call).rejects.toMatchObject({ kind: 'ERROR', status: 503 })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('is told, as is every caller that shared the same read of the cache', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games' })
    await answerAll(sent)
    await first

    // Made in one turn of the event loop, so the second joins the first while it reads the cache.
    const told = [vi.fn(), vi.fn()]
    const calls = told.map((onCached) => fetchUpstream({ key: 'games' }, onCached))
    expect(await Promise.all(calls)).toEqual([{ ok: true }, { ok: true }])
    expect(told.map((onCached) => onCached.mock.calls.length)).toEqual([1, 1])
    expect(runtime.cache.get).toHaveBeenCalledTimes(2)
    expect(runtime.fetchJson).toHaveBeenCalledTimes(1)
  })

  it('is not told when it joined a request that was already on its way to the upstream', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const started = vi.fn()
    const joined = vi.fn()
    const first = fetchUpstream({ key: 'games' }, started)
    await settle()
    const second = fetchUpstream({ key: 'games' }, joined)
    await answerAll(sent)

    // One request, two callers that both waited for it: neither answer was already here.
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }])
    expect(runtime.fetchJson).toHaveBeenCalledTimes(1)
    expect(started).not.toHaveBeenCalled()
    expect(joined).not.toHaveBeenCalled()
  })

  it('is not told about a recorded fixture, which is the upstream of fixture mode', async () => {
    const { runtime } = makeRuntime({ fixtures: true, readFixture: vi.fn(async () => ({ id: 1 })) })
    const onCached = vi.fn()
    expect(await createUpstreamFetch(config, runtime)({ key: 'games' }, onCached)).toEqual({
      id: 1,
    })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('gets its answer whatever its own listener does with the news', async () => {
    const { runtime, sent } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(config, runtime)
    const first = fetchUpstream({ key: 'games' })
    await answerAll(sent)
    await first

    // The listener measures the call; it is no part of it. One that throws has failed at its own
    // work, and the call it was told about is answered as if nobody had been listening — for the
    // caller that brought the listener, and for the one that shares its read of the cache.
    const broken = vi.fn(() => {
      throw new Error('the collector failed')
    })
    const beside = vi.fn()
    const calls = [fetchUpstream({ key: 'games' }, broken), fetchUpstream({ key: 'games' }, beside)]
    expect(await Promise.all(calls)).toEqual([{ ok: true }, { ok: true }])
    expect(broken).toHaveBeenCalledTimes(1)
    expect(beside).toHaveBeenCalledTimes(1)
    expect(runtime.fetchJson).toHaveBeenCalledTimes(1)
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

describe('an answer with a stale window', () => {
  const DAY_MS = 86_400_000
  const WEEK_MS = STALE_WHILE_REVALIDATE_SECONDS * 1000

  /** A day fresh; a week's stale window for a game and what belongs to it, none for a list. */
  const windowed: UpstreamConfig<Request> = {
    ...config,
    ttlFor: () => 86_400,
    staleFor: ({ key }) => (key.startsWith('games/') ? STALE_WHILE_REVALIDATE_SECONDS : 0),
  }

  /**
   * A runtime that can keep a refresh running — which is what gives a transport its stale window —
   * and a transport over it whose cache already holds `key`, stored at the moment the case begins.
   */
  async function holding(key: string, body: unknown = { version: 1 }, using = windowed) {
    const kept: Promise<unknown>[] = []
    const keepAlive = vi.fn((work: Promise<unknown>) => void kept.push(work))
    const made = makeRuntime({ keepAlive })
    const fetchUpstream = createUpstreamFetch(using, made.runtime)
    const first = fetchUpstream({ key })
    await settle()
    made.sent[0]!.answer(200, body)
    await first
    return { ...made, fetchUpstream, kept, keepAlive, storedAt: made.runtime.now() }
  }

  it('is a week, counted from the moment the answer was stored', () => {
    expect(STALE_WHILE_REVALIDATE_SECONDS).toBe(7 * 86_400)
  })

  it('is stored with the moment the upstream was asked, and with the window it is to be kept through', async () => {
    const { runtime, store, storedAt } = await holding('games/portal-2')

    expect(store.get('games/portal-2')).toEqual({
      value: { version: 1 },
      expiresAt: storedAt + DAY_MS,
      storedAt,
    })
    expect(runtime.cache.set).toHaveBeenCalledExactlyOnceWith(
      'games/portal-2',
      store.get('games/portal-2'),
      { shareable: true, staleSeconds: STALE_WHILE_REVALIDATE_SECONDS },
    )
  })

  it('is fresh for its ttl: handed over from the cache, with nothing asked behind it', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games/portal-2')
    advance(DAY_MS - 1)
    const onCached = vi.fn()

    expect(await fetchUpstream({ key: 'games/portal-2' }, onCached)).toEqual({ version: 1 })
    await settle()

    expect(onCached).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(kept).toEqual([])
  })

  it('is handed over at once past its ttl, while the upstream is asked behind the caller’s back', async () => {
    const { fetchUpstream, sent, advance, kept, keepAlive } = await holding('games/portal-2')
    advance(DAY_MS)
    const onCached = vi.fn()

    // The answer is here although nobody has answered the request that is now out.
    expect(await fetchUpstream({ key: 'games/portal-2' }, onCached)).toEqual({ version: 1 })
    await settle()

    expect(sent).toHaveLength(2)
    expect(sent[1]!.url).toBe('https://upstream.test/games/portal-2')
    // A stale answer is the cache's: whoever measures the call is told so, as for a fresh one.
    expect(onCached).toHaveBeenCalledTimes(1)
    // The refresh was handed to the runtime to keep running, and is still out.
    expect(keepAlive).toHaveBeenCalledTimes(1)
    const refresh = watch(kept[0]!)
    await settle()
    expect(refresh.settled).toBe(false)

    sent[1]!.answer(200, { version: 2 })
    await kept[0]
  })

  it('has one refresh a key at a time, however many callers are handed the entry meanwhile', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games/portal-2')
    advance(DAY_MS)

    const answers = await Promise.all([
      fetchUpstream({ key: 'games/portal-2' }),
      fetchUpstream({ key: 'games/portal-2' }),
    ])
    await settle()
    // Later, and under other limits — which would not share a request that is waited for.
    advance(3_000)
    answers.push(await fetchUpstream({ key: 'games/portal-2', timeoutMs: 4_000, maxAttempts: 1 }))
    answers.push(await fetchUpstream({ key: 'games/portal-2' }))
    await settle()

    expect(answers).toEqual(Array(4).fill({ version: 1 }))
    expect(sent).toHaveLength(2)
    expect(kept).toHaveLength(1)

    sent[1]!.answer(200, { version: 2 })
    await kept[0]
  })

  it('refreshes each key on its own', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games/portal-2')
    const other = fetchUpstream({ key: 'games/portal-2/stores' })
    await settle()
    sent[1]!.answer(200, { results: [] })
    await other
    advance(DAY_MS + 300)

    await fetchUpstream({ key: 'games/portal-2' })
    await fetchUpstream({ key: 'games/portal-2/stores' })
    await settle()

    expect(sent.slice(2).map((request) => request.url)).toEqual([
      'https://upstream.test/games/portal-2',
      'https://upstream.test/games/portal-2/stores',
    ])
    expect(kept).toHaveLength(2)
    for (const request of sent.slice(2)) request.answer(200, {})
    await Promise.all(kept)
  })

  it('is replaced by what the refresh brings back, which is then fresh', async () => {
    const { fetchUpstream, sent, advance, kept, store, runtime } = await holding('games/portal-2')
    advance(DAY_MS + 5_000)
    const refreshedAt = runtime.now()
    await fetchUpstream({ key: 'games/portal-2' })
    await settle()
    advance(800)
    sent[1]!.answer(200, { version: 2 })
    await kept[0]

    expect(store.get('games/portal-2')).toEqual({
      value: { version: 2 },
      expiresAt: refreshedAt + DAY_MS,
      storedAt: refreshedAt,
    })
    const onCached = vi.fn()
    expect(await fetchUpstream({ key: 'games/portal-2' }, onCached)).toEqual({ version: 2 })
    await settle()
    expect(onCached).toHaveBeenCalledTimes(1)
    // Fresh again: no request, and no refresh.
    expect(sent).toHaveLength(2)
    expect(kept).toHaveLength(1)
  })

  it('keeps the entry when the refresh fails, says so like any attempt, and tries again on the next call', async () => {
    const { fetchUpstream, sent, advance, kept, store, lines } = await holding('games/portal-2')
    const before = store.get('games/portal-2')
    advance(DAY_MS)
    await fetchUpstream({ key: 'games/portal-2' })
    await settle()
    advance(40)
    sent[1]!.answer(502)
    await settle()
    advance(5_000)
    sent[2]!.fail(timeoutError())

    // What was handed to the keep-alive ends without a failure of its own.
    await expect(kept[0]).resolves.toBeUndefined()
    expect(lines()).toEqual([
      '[upstream] RAWG games/portal-2 attempt 1: 40 ms, ERROR (502)',
      '[upstream] RAWG games/portal-2 attempt 2: 5000 ms, TIMEOUT',
    ])
    expect(store.get('games/portal-2')).toBe(before)

    // The entry is still what answers, and the next caller sets off the next refresh.
    expect(await fetchUpstream({ key: 'games/portal-2' })).toEqual({ version: 1 })
    await settle()
    expect(sent).toHaveLength(4)
    expect(kept).toHaveLength(2)
    sent[3]!.answer(200, { version: 2 })
    await kept[1]
    expect(await fetchUpstream({ key: 'games/portal-2' })).toEqual({ version: 2 })
  })

  it('raises nothing when a refresh fails with nobody holding on to it', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { fetchUpstream, sent, advance } = await holding('games/portal-2')
      advance(DAY_MS)
      await fetchUpstream({ key: 'games/portal-2', maxAttempts: 1 })
      await settle()
      sent[1]!.answer(503)
      await settle()
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('keeps the entry when the refresh finds the game gone, without a line about it', async () => {
    const { fetchUpstream, sent, advance, kept, lines } = await holding('games/portal-2')
    advance(DAY_MS)
    await fetchUpstream({ key: 'games/portal-2' })
    await settle()
    sent[1]!.answer(404)
    await kept[0]

    expect(lines()).toEqual([])
    expect(await fetchUpstream({ key: 'games/portal-2' })).toEqual({ version: 1 })
    await settle()
    sent[2]!.answer(404)
    await kept[1]
  })

  it('is handed over even when the keep-alive will not take the refresh, which runs all the same', async () => {
    const { fetchUpstream, sent, advance, keepAlive, store } = await holding('games/portal-2')
    keepAlive.mockImplementation(() => {
      throw new Error('the response has already been sent')
    })
    advance(DAY_MS)

    expect(await fetchUpstream({ key: 'games/portal-2' })).toEqual({ version: 1 })
    await settle()
    expect(sent).toHaveLength(2)
    sent[1]!.answer(200, { version: 2 })
    await settle()
    expect(store.get('games/portal-2')?.value).toEqual({ version: 2 })
  })

  it('ends a week after the answer was stored: a millisecond before, it is still handed over', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games/portal-2')
    advance(WEEK_MS - 1)

    expect(await fetchUpstream({ key: 'games/portal-2' })).toEqual({ version: 1 })
    await settle()
    expect(kept).toHaveLength(1)
    sent[1]!.answer(503)
    await settle()
    sent[2]!.answer(503)
    await kept[0]
  })

  it('is a miss past the window: the upstream is asked, and waited for', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games/portal-2')
    advance(WEEK_MS)
    const onCached = vi.fn()

    const call = fetchUpstream({ key: 'games/portal-2' }, onCached)
    const seen = watch(call)
    await settle()
    expect(seen.settled).toBe(false)
    expect(sent).toHaveLength(2)

    sent[1]!.answer(200, { version: 2 })
    expect(await call).toEqual({ version: 2 })
    expect(onCached).not.toHaveBeenCalled()
    // Asked for by a caller who waited: nothing was left for the runtime to keep running.
    expect(kept).toEqual([])
  })

  it('is still the fallback past the window, for a refresh that fails', async () => {
    const { fetchUpstream, sent, advance } = await holding('games/portal-2')
    advance(WEEK_MS + DAY_MS)
    const onCached = vi.fn()

    const call = fetchUpstream({ key: 'games/portal-2', maxAttempts: 1 }, onCached)
    await settle()
    sent[1]!.answer(500)

    expect(await call).toEqual({ version: 1 })
    expect(onCached).not.toHaveBeenCalled()
  })

  it('does not exist in a runtime without a keep-alive, whatever the request is given', async () => {
    const { runtime, sent, advance, store } = makeRuntime()
    const fetchUpstream = createUpstreamFetch(windowed, runtime)
    const first = fetchUpstream({ key: 'games/portal-2' })
    await settle()
    sent[0]!.answer(200, { version: 1 })
    await first
    // Nothing is asked to be kept through a window that is not there.
    expect(runtime.cache.set).toHaveBeenCalledExactlyOnceWith(
      'games/portal-2',
      store.get('games/portal-2'),
      { shareable: true, staleSeconds: 0 },
    )
    advance(DAY_MS)

    // Past its ttl the entry is expired, as it always was: the caller waits for the upstream.
    const call = fetchUpstream({ key: 'games/portal-2' })
    const seen = watch(call)
    await settle()
    expect(seen.settled).toBe(false)
    sent[1]!.answer(200, { version: 2 })
    expect(await call).toEqual({ version: 2 })
  })

  it.each([
    ['is given none', (): number => 0],
    ['is given less than none', (): number => -60],
    ['is given no number at all', (): number => Number.NaN],
  ])('does not exist for a request that %s', async (_what, staleFor) => {
    const { fetchUpstream, runtime, sent, advance, kept, store } = await holding(
      'games/portal-2',
      { version: 1 },
      { ...windowed, staleFor },
    )
    expect(runtime.cache.set).toHaveBeenCalledWith('games/portal-2', store.get('games/portal-2'), {
      shareable: true,
      staleSeconds: 0,
    })
    advance(DAY_MS)

    const call = fetchUpstream({ key: 'games/portal-2' })
    const seen = watch(call)
    await settle()
    expect(seen.settled).toBe(false)
    sent[1]!.answer(200, { version: 2 })
    expect(await call).toEqual({ version: 2 })
    expect(kept).toEqual([])
  })

  it('does not exist for a list, beside a game that has one', async () => {
    const { fetchUpstream, sent, advance, kept } = await holding('games')
    advance(DAY_MS)

    const call = fetchUpstream({ key: 'games' })
    const seen = watch(call)
    await settle()
    expect(seen.settled).toBe(false)
    sent[1]!.answer(200, { version: 2 })
    expect(await call).toEqual({ version: 2 })
    expect(kept).toEqual([])
  })

  it('does not exist for an entry that does not say when it was stored', async () => {
    const { fetchUpstream, sent, advance, kept, store, runtime } = await holding('games/portal-2')
    // Handed to the cache by something other than this transport: fresh until a moment ago.
    store.set('games/other', { value: { version: 0 }, expiresAt: runtime.now() + 1 })
    advance(1)

    const call = fetchUpstream({ key: 'games/other' })
    const seen = watch(call)
    await settle()
    expect(seen.settled).toBe(false)
    sent[1]!.answer(200, { version: 1 })
    expect(await call).toEqual({ version: 1 })
    expect(kept).toEqual([])
  })
})

describe('which answers may be kept beyond the instance', () => {
  const DAY = 86_400

  it('are the ones fresh for a day or longer that no visitor typed', () => {
    expect(SHAREABLE_MIN_TTL_SECONDS).toBe(DAY)
    // A game's page, a taxonomy, the landing's day-long list, Steam's page about an app.
    expect(isShareable(DAY, false)).toBe(true)
    expect(isShareable(7 * DAY, false)).toBe(true)
    // A catalog list: ten minutes. A second short of a day is short of it.
    expect(isShareable(600, false)).toBe(false)
    expect(isShareable(DAY - 1, false)).toBe(false)
    // A search, however long its answer lives.
    expect(isShareable(600, true)).toBe(false)
    expect(isShareable(DAY, true)).toBe(false)
    expect(isShareable(7 * DAY, true)).toBe(false)
  })

  /** A ttl the request names, and a request that is typed when its key carries a search. */
  const ruled: UpstreamConfig<Request> = {
    ...config,
    typed: ({ key }) => key.includes('search='),
  }

  it.each([
    ['a game’s page, fresh for a day', { key: 'games/portal-2', ttl: DAY }, true],
    ['a taxonomy, fresh for a week', { key: 'genres', ttl: 7 * DAY }, true],
    ['a list kept for a day', { key: 'games?ordering=-added', ttl: DAY }, true],
    ['a ten-minute list', { key: 'games?genres=rpg' }, false],
    ['a search on a ten-minute list', { key: 'games?search=half life' }, false],
    ['a search on a list kept for a day', { key: 'games?search=half life', ttl: DAY }, false],
    ['a search on a taxonomy', { key: 'developers?search=va', ttl: 7 * DAY }, false],
  ])('says so of %s with its read and with its write', async (_what, request, shareable) => {
    const { runtime, sent } = makeRuntime()
    const call = createUpstreamFetch(ruled, runtime)(request)
    await settle()
    sent[0]!.answer(200, { ok: true })
    await call

    expect(runtime.cache.get).toHaveBeenCalledExactlyOnceWith(
      request.key,
      expect.objectContaining({ shareable }),
    )
    expect(runtime.cache.set).toHaveBeenCalledExactlyOnceWith(
      request.key,
      expect.anything(),
      expect.objectContaining({ shareable }),
    )
  })

  it('takes a request for one nobody typed when its upstream has no such requests', async () => {
    const { runtime, sent } = makeRuntime()
    const call = createUpstreamFetch(config, runtime)({ key: '292030', ttl: DAY })
    await settle()
    sent[0]!.answer(200, { ok: true })
    await call

    expect(runtime.cache.get).toHaveBeenCalledWith(
      '292030',
      expect.objectContaining({ shareable: true }),
    )
  })
})

describe('a caller that asks to be told when its read went to the shared cache', () => {
  /**
   * A cache with a second level: what it holds, and what it says of each read that went beyond
   * memory — nothing, for a key that is in `said` under no name.
   */
  function sharedCache(said: Record<string, SharedRead> = {}) {
    const made = makeRuntime()
    vi.mocked(made.runtime.cache.get).mockImplementation(async (key, options) => {
      const read = said[key]
      if (read) options?.onSharedRead?.(read)
      return made.store.get(key) ?? null
    })
    return { ...made, fetchUpstream: createUpstreamFetch(config, made.runtime) }
  }

  const fresh = (value: unknown): UpstreamCacheEntry => ({
    value,
    expiresAt: 2_000_000,
    storedAt: 999_000,
  })
  const expired = (value: unknown): UpstreamCacheEntry => ({ value, expiresAt: 0, storedAt: 0 })

  it('is told of the read that found the entry which answered, and that the cache answered', async () => {
    const { fetchUpstream, store, sent } = sharedCache({ 'games/a': { ms: 12, hit: true } })
    store.set('games/a', fresh({ id: 1 }))
    const onCached = vi.fn()
    const onSharedRead = vi.fn()

    // Whoever measures the call knows what it was in the handler its answer arrives in.
    const told = fetchUpstream({ key: 'games/a' }, onCached, onSharedRead).then((answer) => ({
      answer,
      told: onSharedRead.mock.calls.length,
    }))

    expect(await told).toEqual({ answer: { id: 1 }, told: 1 })
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 12, hit: true })
    expect(onCached).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
  })

  it('is told of a read that found nothing, when the upstream then answered', async () => {
    const { fetchUpstream, sent } = sharedCache({ 'games/a': { ms: 9, hit: false } })
    const onSharedRead = vi.fn()

    const call = fetchUpstream({ key: 'games/a' }, undefined, onSharedRead)
    await settle()
    expect(onSharedRead).not.toHaveBeenCalled()
    sent[0]!.answer(200, { id: 1 })

    expect(await call).toEqual({ id: 1 })
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 9, hit: false })
  })

  it('is told the read found nothing when what it found was too old, and the upstream answered', async () => {
    const { fetchUpstream, store, sent } = sharedCache({ games: { ms: 20, hit: true } })
    store.set('games', expired({ page: 'old' }))
    const onSharedRead = vi.fn()

    const call = fetchUpstream({ key: 'games' }, undefined, onSharedRead)
    await settle()
    sent[0]!.answer(200, { page: 'new' })

    expect(await call).toEqual({ page: 'new' })
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 20, hit: false })
  })

  it('is told the read found nothing when what it found was not a body at all', async () => {
    const { fetchUpstream, store, sent } = sharedCache({ games: { ms: 20, hit: true } })
    store.set('games', fresh(null))
    const onSharedRead = vi.fn()

    const call = fetchUpstream({ key: 'games' }, undefined, onSharedRead)
    await settle()
    sent[0]!.answer(200, { page: 'new' })

    expect(await call).toEqual({ page: 'new' })
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 20, hit: false })
  })

  it('is told the read’s entry answered when it stood in for an upstream that failed', async () => {
    const { fetchUpstream, store, sent } = sharedCache({ games: { ms: 20, hit: true } })
    store.set('games', expired({ page: 'old' }))
    const onCached = vi.fn()
    const onSharedRead = vi.fn()

    const call = fetchUpstream({ key: 'games', maxAttempts: 1 }, onCached, onSharedRead)
    await settle()
    sent[0]!.answer(500)

    // The upstream was asked, so this was a call; and what answered it came from the shared cache.
    expect(await call).toEqual({ page: 'old' })
    expect(onCached).not.toHaveBeenCalled()
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 20, hit: true })
  })

  it('is told of the read when the call fails, by the time the failure arrives', async () => {
    const { fetchUpstream, store, sent } = sharedCache({ 'games/gone': { ms: 7, hit: true } })
    store.set('games/gone', expired({ id: 1 }))
    const onSharedRead = vi.fn()

    const outcome = fetchUpstream({ key: 'games/gone' }, undefined, onSharedRead).catch(
      (error: unknown) => ({ error, told: onSharedRead.mock.calls.length }),
    )
    await settle()
    sent[0]!.answer(404)

    // A 404 is never answered from an old entry, so the entry the read found answered nothing.
    expect(await outcome).toMatchObject({ error: { kind: 'NOT_FOUND' }, told: 1 })
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 7, hit: false })
  })

  it('is told, as is every caller that shares the call', async () => {
    const { fetchUpstream, sent, runtime } = sharedCache({ 'games/a': { ms: 15, hit: false } })
    const told = [vi.fn(), vi.fn(), vi.fn()]

    const calls = told
      .slice(0, 2)
      .map((onSharedRead) => fetchUpstream({ key: 'games/a' }, undefined, onSharedRead))
    await settle()
    // A caller that joins the request while it is on the wire shares its read as well.
    calls.push(fetchUpstream({ key: 'games/a' }, undefined, told[2]))
    sent[0]!.answer(200, { id: 1 })
    await Promise.all(calls)

    expect(runtime.cache.get).toHaveBeenCalledTimes(1)
    for (const onSharedRead of told) {
      expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 15, hit: false })
    }
  })

  it('is told nothing of a read that memory answered, or of a cache that has no second level', async () => {
    const { fetchUpstream, store, sent } = sharedCache()
    store.set('games/a', fresh({ id: 1 }))
    const onSharedRead = vi.fn()

    await fetchUpstream({ key: 'games/a' }, undefined, onSharedRead)
    const missed = fetchUpstream({ key: 'games/b' }, undefined, onSharedRead)
    await settle()
    sent[0]!.answer(200, { id: 2 })
    await missed

    expect(onSharedRead).not.toHaveBeenCalled()
  })

  it('gets its answer whatever its own listener does with the news', async () => {
    const { fetchUpstream, store } = sharedCache({ 'games/a': { ms: 12, hit: true } })
    store.set('games/a', fresh({ id: 1 }))
    const broken = vi.fn(() => {
      throw new Error('the collector failed')
    })
    const beside = vi.fn()

    const calls = [
      fetchUpstream({ key: 'games/a' }, undefined, broken),
      fetchUpstream({ key: 'games/a' }, beside, beside),
    ]

    expect(await Promise.all(calls)).toEqual([{ id: 1 }, { id: 1 }])
    expect(broken).toHaveBeenCalledTimes(1)
    expect(beside).toHaveBeenCalledTimes(2)
  })

  it('is told of the read behind a stale answer, whose entry is what answered', async () => {
    const kept: Promise<unknown>[] = []
    const made = makeRuntime({ keepAlive: (work) => void kept.push(work) })
    vi.mocked(made.runtime.cache.get).mockImplementation(async (key, options) => {
      options?.onSharedRead?.({ ms: 30, hit: true })
      return made.store.get(key) ?? null
    })
    made.store.set('games/a', { value: { id: 1 }, expiresAt: 999_000, storedAt: 900_000 })
    const fetchUpstream = createUpstreamFetch({ ...config, staleFor: () => 3_600 }, made.runtime)
    const onCached = vi.fn()
    const onSharedRead = vi.fn()

    expect(await fetchUpstream({ key: 'games/a' }, onCached, onSharedRead)).toEqual({ id: 1 })
    expect(onCached).toHaveBeenCalledTimes(1)
    expect(onSharedRead).toHaveBeenCalledExactlyOnceWith({ ms: 30, hit: true })

    await settle()
    made.sent[0]!.answer(200, { id: 2 })
    await kept[0]
  })
})

describe('a request that follows a slow read of the cache', () => {
  /**
   * A cache whose read of `slowKey` goes to its second level, and takes `ms` of the clock doing
   * it.
   */
  function slowCache(slowKey: string, ms: number) {
    const made = makeRuntime()
    vi.mocked(made.runtime.cache.get).mockImplementation(async (key, options) => {
      if (key === slowKey) {
        made.advance(ms)
        options?.onSharedRead?.({ ms, hit: false })
      }
      return made.store.get(key) ?? null
    })
    return { ...made, fetchUpstream: createUpstreamFetch(config, made.runtime) }
  }

  it('takes its turn at the limiter from the clock as it stands after the read', async () => {
    const { fetchUpstream, runtime, sent, advance } = slowCache('games/slow', 140)

    // Sent 140 ms after the call was made: that is the moment the next request is spaced from.
    const slow = fetchUpstream({ key: 'games/slow' })
    await settle()
    expect(sent).toHaveLength(1)
    expect(runtime.sleep).not.toHaveBeenCalled()

    // 200 ms after the first call was made, and 60 ms after its request went out.
    advance(60)
    const next = fetchUpstream({ key: 'games/next' })
    await settle()
    // A slot counted from the call instead would let it out after 50 ms: 110 ms behind the first.
    expect(vi.mocked(runtime.sleep).mock.calls).toEqual([[190]])

    for (const request of sent) request.answer(200, {})
    await Promise.all([slow, next])
  })

  it('stores what it fetched under the moment the request went out', async () => {
    const { fetchUpstream, sent, store } = slowCache('games/slow', 140)

    const call = fetchUpstream({ key: 'games/slow' })
    await settle()
    sent[0]!.answer(200, { id: 1 })
    await call

    expect(store.get('games/slow')).toMatchObject({
      storedAt: 1_000_140,
      expiresAt: 1_000_140 + 600_000,
    })
  })

  it('keeps the moment the call was made after a read of memory alone, as it always did', async () => {
    const { fetchUpstream, runtime, sent, store } = slowCache('games/slow', 140)

    // Three calls in one turn of the event loop: each reserves its slot against the same moment.
    const calls = ['games/a', 'games/b', 'games/c'].map((key) => fetchUpstream({ key }))
    await settle()
    expect(vi.mocked(runtime.sleep).mock.calls).toEqual([[250], [500]])

    for (const request of sent) request.answer(200, {})
    await Promise.all(calls)
    expect(store.get('games/c')).toMatchObject({ storedAt: 1_000_000 })
  })
})
