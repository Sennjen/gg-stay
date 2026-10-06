import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpstreamFetch,
  type UpstreamCacheEntry,
  type UpstreamConfig,
  type UpstreamRuntime,
} from '../../server/upstream/createUpstreamFetch'
import { UpstreamError } from '../../server/upstream/errors'

/**
 * The shared transport on its own, for what neither RAWG's nor Steam's share of it decides: which
 * calls are one request. `rawgFetch.test.ts` and `steamFetch.test.ts` cover the rest through the
 * two transports built on it.
 *
 * The network here answers when a test says so. A request stays on the wire until its entry in
 * `sent` is answered or failed, which is what lets a test make a second call while the first is
 * still running, without a timer and without a wait.
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
    ...overrides,
  } satisfies UpstreamRuntime
  return { runtime, store, sent, advance: (ms: number) => void (clock += ms) }
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
