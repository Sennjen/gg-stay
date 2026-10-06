import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphQLContext } from '../../server/graphql/context'
import { GAME_DETAIL_HEDGE_MS } from '../../server/graphql/resolvers/game'
import {
  createServerTiming,
  SERVER_TIMING_HEADER,
  timedContext,
  writeServerTiming,
  type ServerTiming,
} from '../../server/graphql/serverTiming'
import { createYogaApp } from '../../server/graphql/yoga'
import type { GameIndex } from '../../server/index/GameIndex'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../../server/rawg/rawgFetch'
import { createSteamFetch, type SteamFetch } from '../../server/steam/steamFetch'
import type { SteamPriceFetch } from '../../server/steam/steamPriceFetch'
import { UpstreamError } from '../../server/upstream/errors'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import {
  fixtureRawg,
  fixtureSteam,
  noCache,
  noSteamPrices,
  postQuery,
  publishTestIndex,
  TEST_NOW,
  TEST_TODAY,
  type QueryResult,
} from './support/yoga'

/**
 * The `Server-Timing` header of a GraphQL answer: what it names, what its numbers mean, and that
 * nothing about it can cost an answer. Three layers, bottom up — the collector on a clock the test
 * holds, the context whose calls it times over the real transports, and whole answers through
 * yoga on fake timers. No case waits for a real timer or reads a real clock.
 */

/**
 * A header value as the Server Timing specification writes it: metrics separated by commas, each
 * a name and any number of `name=value` parameters, a value being a token or a quoted string.
 */
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+"
const QUOTED = '"(?:[\\t \\x21\\x23-\\x5B\\x5D-\\x7E]|\\\\[\\t \\x21-\\x7E])*"'
const METRIC = `${TOKEN}(?:[ \\t]*;[ \\t]*${TOKEN}[ \\t]*=[ \\t]*(?:${TOKEN}|${QUOTED}))*`
const SERVER_TIMING = new RegExp(`^${METRIC}(?:[ \\t]*,[ \\t]*${METRIC})*$`)

/**
 * And as this endpoint writes it: its three upstreams at most, each once and in this order, with
 * a whole number of milliseconds and a count, then the total. Nothing else fits — which is what
 * keeps a slug, a search or a URL out of it.
 */
const OURS =
  /^(?:rawg;dur=\d+;desc="RAWG x[1-9]\d*", )?(?:steam;dur=\d+;desc="Steam x[1-9]\d*", )?(?:index;dur=\d+;desc="Index x[1-9]\d*", )?total;dur=\d+$/

/** A clock the test moves by hand. */
function handClock(at = 5_000) {
  let now = at
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** Lets everything that is ready to run, run: a turn of the event loop, not a wait. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the timing of one request', () => {
  it('names the total alone when no upstream was called', () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    clock.advance(7)
    expect(timing.header()).toBe('total;dur=7')
  })

  it('names an upstream once, with its slowest call and the number of calls', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const calls = [deferred(), deferred(), deferred()]
    for (const call of calls) void timing.measure('rawg', () => call.promise)

    // Side by side, as the game page sends them: 120 ms, 5 012 ms and 300 ms.
    clock.advance(120)
    calls[0]!.resolve({})
    await settle()
    clock.advance(180)
    calls[2]!.resolve({})
    await settle()
    clock.advance(4_712)
    calls[1]!.resolve({})
    await settle()

    expect(timing.header()).toBe('rawg;dur=5012;desc="RAWG x3", total;dur=5012')
  })

  it('times a call from when it was made, not from when the request began', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    clock.advance(900)
    const call = deferred()
    void timing.measure('steam', () => call.promise)
    clock.advance(200)
    call.resolve({})
    await settle()
    clock.advance(15)

    expect(timing.header()).toBe('steam;dur=200;desc="Steam x1", total;dur=1115')
  })

  it('names RAWG, Steam and the index in that order, whatever order they were called in', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    await timing.measure('index', async () => clock.advance(41))
    await timing.measure('steam', async () => clock.advance(310))
    await timing.measure('index', async () => clock.advance(12))
    await timing.measure('rawg', async () => clock.advance(95))
    await settle()

    expect(timing.header()).toBe(
      'rawg;dur=95;desc="RAWG x1", steam;dur=310;desc="Steam x1", index;dur=41;desc="Index x2", total;dur=458',
    )
  })

  it('leaves out an answer the cache gave, however many there were', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const fromCache = (onCached: () => void) => {
      onCached()
      return Promise.resolve({})
    }
    await timing.measure('rawg', fromCache)
    await timing.measure('rawg', fromCache)
    await timing.measure('steam', fromCache)
    await timing.measure('rawg', async () => clock.advance(640))
    await settle()

    // Three answers were already here; RAWG was asked once.
    expect(timing.header()).toBe('rawg;dur=640;desc="RAWG x1", total;dur=640')
  })

  it('learns that the cache answered at any moment before the answer arrives', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const read = deferred()
    let cached = () => {}
    const call = timing.measure('rawg', (onCached) => {
      cached = onCached
      return read.promise
    })
    // The transport reads its cache first, and says so only when the entry turned out fresh.
    clock.advance(2)
    cached()
    read.resolve({})
    await call

    expect(timing.header()).toBe('total;dur=2')
  })

  it('counts a call that failed, for as long as it took to fail', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const call = deferred()
    const failed = timing.measure('rawg', () => call.promise).catch((error: unknown) => error)
    clock.advance(10_012)
    call.reject(new UpstreamError('RAWG', 'TIMEOUT'))

    expect(await failed).toBeInstanceOf(UpstreamError)
    // It ended when it failed: what the answer does afterwards is not RAWG's time.
    clock.advance(500)
    expect(timing.header()).toBe('rawg;dur=10012;desc="RAWG x1", total;dur=10512')
  })

  it('counts a call that is still out for the time the answer waited for it', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const detail = deferred()
    const stores = deferred()
    void timing.measure('rawg', () => detail.promise)
    void timing.measure('rawg', () => stores.promise)
    clock.advance(100)
    stores.resolve({})
    await settle()

    // The answer goes out at its budget; the detail has cost it all of that, and is not done.
    clock.advance(2_400)
    expect(timing.header()).toBe('rawg;dur=2500;desc="RAWG x2", total;dur=2500')

    // What it takes from here on is no longer this answer's time, but it is still timed truly.
    clock.advance(4_500)
    detail.resolve({})
    await settle()
    expect(timing.header()).toBe('rawg;dur=7000;desc="RAWG x2", total;dur=7000')
  })

  it('hands back the very promise the call returned', () => {
    const timing = createServerTiming(handClock().now)
    const answer = Promise.resolve({ id: 3328 })
    expect(timing.measure('rawg', () => answer)).toBe(answer)
  })

  it('leaves a failure to whoever made the call, and raises none of its own', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const timing = createServerTiming(handClock().now)
      const failure = new UpstreamError('STEAM', 'ERROR', 502)
      await expect(timing.measure('steam', () => Promise.reject(failure))).rejects.toBe(failure)
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does not count a call that was refused before anybody was asked', () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const refusal = new Error('not expected to be called')
    expect(() =>
      timing.measure('steam', () => {
        throw refusal
      }),
    ).toThrow(refusal)
    expect(timing.header()).toBe('total;dur=0')
  })

  it('writes whole milliseconds, rounded to the nearest', async () => {
    // Quarters of a millisecond, which a float holds exactly: the rounding is what is looked at.
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    await timing.measure('rawg', async () => clock.advance(12.25))
    await timing.measure('steam', async () => clock.advance(12.5))
    await settle()
    expect(timing.header()).toBe(
      'rawg;dur=12;desc="RAWG x1", steam;dur=13;desc="Steam x1", total;dur=25',
    )

    clock.advance(0.5)
    expect(timing.header()).toContain('total;dur=25')
    clock.advance(0.25)
    expect(timing.header()).toContain('total;dur=26')
  })

  it('never writes a negative time for a clock that stepped back', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    await timing.measure('index', async () => clock.advance(-40))
    await settle()
    expect(timing.header()).toBe('index;dur=0;desc="Index x1", total;dur=0')
  })

  it('is a valid Server-Timing value with every upstream, with some and with none', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const headers = [timing.header()]
    for (const upstream of ['index', 'rawg', 'steam'] as const) {
      await timing.measure(upstream, async () => clock.advance(1_234))
      await settle()
      headers.push(timing.header())
    }

    expect(headers).toHaveLength(4)
    for (const header of headers) {
      expect(header).toMatch(SERVER_TIMING)
      expect(header).toMatch(OURS)
    }
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('no clock')
      },
    ],
    ['answers with something that is not a time', () => Number.NaN],
    ['answers with no end of it', () => Number.POSITIVE_INFINITY],
  ])('has no header, and costs no call, when the clock %s', async (_what, now) => {
    const timing = createServerTiming(now)
    const answer = { id: 3328 }
    expect(await timing.measure('rawg', async () => answer)).toBe(answer)
    await expect(
      timing.measure('index', () => Promise.reject(new Error('index down'))),
    ).rejects.toThrow('index down')
    expect(timing.header()).toBeNull()
  })

  it('has no header when the clock failed while a call was out, rather than a wrong one', async () => {
    let broken = false
    const clock = handClock()
    const timing = createServerTiming(() => {
      if (broken) throw new Error('no clock')
      return clock.now()
    })
    const call = deferred()
    void timing.measure('rawg', () => call.promise)
    broken = true
    call.resolve({})
    await settle()
    broken = false
    clock.advance(30)

    expect(timing.header()).toBeNull()
  })
})

describe('the header on an answer', () => {
  it('is written under its name', () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    clock.advance(3)
    const headers = new Headers()
    writeServerTiming(headers, timing)
    expect(SERVER_TIMING_HEADER).toBe('Server-Timing')
    expect(headers.get('server-timing')).toBe('total;dur=3')
  })

  it('is left off when there is nothing true to write', () => {
    const headers = new Headers()
    writeServerTiming(
      headers,
      createServerTiming(() => Number.NaN),
    )
    expect([...headers.keys()]).toEqual([])
  })

  it('never fails the answer: not on headers that cannot be written, not on a timing that throws', () => {
    const sealed = {
      set() {
        throw new TypeError('immutable')
      },
    }
    expect(() => writeServerTiming(sealed, createServerTiming(handClock().now))).not.toThrow()

    const broken: ServerTiming = {
      measure: (_upstream, call) => call(() => {}),
      header() {
        throw new Error('no header')
      },
    }
    const headers = new Headers()
    expect(() => writeServerTiming(headers, broken)).not.toThrow()
    expect([...headers.keys()]).toEqual([])
  })
})

/** A context made of nothing but what a case passes: the timed calls are all that is looked at. */
function contextOf(parts: Partial<GraphQLContext>): GraphQLContext {
  return {
    rawg: fixtureRawg,
    steam: fixtureSteam,
    today: TEST_TODAY,
    now: TEST_NOW,
    index: {} as GameIndex,
    steamPrices: noSteamPrices,
    cache: noCache,
    ...parts,
  }
}

interface SentRequest {
  url: string
  answer: (status: number, body?: unknown) => void
}

/** A network that answers when a case says so, and the cache and limiter the transports need. */
function network() {
  const store = new Map<string, CacheEntry>()
  const sent: SentRequest[] = []
  const fetchJson = vi.fn(
    (url: string) =>
      new Promise<{ status: number; body: unknown }>((resolve) => {
        sent.push({ url, answer: (status, body = null) => resolve({ status, body }) })
      }),
  )
  const deps = {
    apiKey: 'test-key',
    fixtures: false,
    fetchJson,
    readFixture: async () => null,
    cache: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, entry: CacheEntry) => void store.set(key, entry),
    },
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  }
  return { deps, sent, fetchJson, store }
}

describe('a context whose upstream calls are timed', () => {
  it('passes a RAWG call on as it was made, and hands back what RAWG answered', async () => {
    const answer = Promise.resolve({ results: [] })
    const rawg = vi.fn<RawgFetch>(() => answer)
    const timed = timedContext(contextOf({ rawg }), createServerTiming(handClock().now))

    expect(timed.rawg('games', { search: 'half life', page: 2 }, { ttl: 60, maxAttempts: 1 })).toBe(
      answer,
    )
    expect(rawg).toHaveBeenCalledExactlyOnceWith(
      'games',
      { search: 'half life', page: 2 },
      { ttl: 60, maxAttempts: 1, onCached: expect.any(Function) },
    )

    // A call made with nothing but a path asks to be told as well.
    void timed.rawg('genres')
    expect(rawg).toHaveBeenLastCalledWith('genres', undefined, { onCached: expect.any(Function) })
  })

  it('passes a Steam call on as it was made', async () => {
    const answer = Promise.resolve({ '292030': { success: true } })
    const steam = vi.fn<SteamFetch>(() => answer)
    const timed = timedContext(contextOf({ steam }), createServerTiming(handClock().now))

    expect(timed.steam('292030', { ttl: 86_400 })).toBe(answer)
    expect(steam).toHaveBeenCalledExactlyOnceWith('292030', {
      ttl: 86_400,
      onCached: expect.any(Function),
    })
  })

  it('counts RAWG for a request it was asked, and not for one its cache answered', async () => {
    const { deps, sent, fetchJson } = network()
    const rawg = createRawgFetch(deps)
    const clock = handClock()

    const first = createServerTiming(clock.now)
    const asked = timedContext(contextOf({ rawg }), first).rawg('games/portal-2')
    await settle()
    clock.advance(480)
    sent[0]!.answer(200, { id: 4200 })
    expect(await asked).toEqual({ id: 4200 })
    expect(first.header()).toBe('rawg;dur=480;desc="RAWG x1", total;dur=480')

    // The next request finds the answer in the transport's cache: nobody is asked, nothing is named.
    const second = createServerTiming(clock.now)
    expect(await timedContext(contextOf({ rawg }), second).rawg('games/portal-2')).toEqual({
      id: 4200,
    })
    expect(second.header()).toBe('total;dur=0')
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('counts Steam for a request it was asked, and not for one its cache answered', async () => {
    const { deps, sent, fetchJson } = network()
    const steam = createSteamFetch(deps)
    const clock = handClock()

    const first = createServerTiming(clock.now)
    const asked = timedContext(contextOf({ steam }), first).steam('292030', { ttl: 86_400 })
    await settle()
    clock.advance(310)
    sent[0]!.answer(200, { '292030': { success: true } })
    await asked
    expect(first.header()).toBe('steam;dur=310;desc="Steam x1", total;dur=310')

    const second = createServerTiming(clock.now)
    await timedContext(contextOf({ steam }), second).steam('292030', { ttl: 86_400 })
    expect(second.header()).toBe('total;dur=0')
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('times a call that joined a request already out by what it waited itself', async () => {
    const { deps, sent, fetchJson } = network()
    const rawg = createRawgFetch(deps)
    const clock = handClock()

    // One visitor's request has been waiting for RAWG for three seconds when another's arrives.
    const early = createServerTiming(clock.now)
    const first = timedContext(contextOf({ rawg }), early).rawg('games/portal-2')
    await settle()
    clock.advance(3_000)
    const late = createServerTiming(clock.now)
    const second = timedContext(contextOf({ rawg }), late).rawg('games/portal-2')
    await settle()
    clock.advance(2_000)
    sent[0]!.answer(200, { id: 4200 })
    await Promise.all([first, second])

    // One request to RAWG, and each of the two says how long it waited for it.
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(early.header()).toBe('rawg;dur=5000;desc="RAWG x1", total;dur=5000')
    expect(late.header()).toBe('rawg;dur=2000;desc="RAWG x1", total;dur=2000')
  })

  it('counts the transport’s retry in the time of the one call it belongs to', async () => {
    const { deps, sent } = network()
    const rawg = createRawgFetch(deps)
    const clock = handClock()
    const timing = createServerTiming(clock.now)

    const call = timedContext(contextOf({ rawg }), timing).rawg('games/portal-2')
    await settle()
    clock.advance(5_000)
    sent[0]!.answer(503)
    await settle()
    clock.advance(12)
    sent[1]!.answer(200, { id: 4200 })
    await call

    expect(timing.header()).toBe('rawg;dur=5012;desc="RAWG x1", total;dur=5012')
  })

  it('counts a recorded fixture as the call it stands for', async () => {
    const { deps } = network()
    const rawg = createRawgFetch({ ...deps, fixtures: true, readFixture: async () => ({ id: 1 }) })
    const timing = createServerTiming(handClock().now)

    await timedContext(contextOf({ rawg }), timing).rawg('games/portal-2')
    expect(timing.header()).toBe('rawg;dur=0;desc="RAWG x1", total;dur=0')
  })

  it('counts the game page’s live price read as a Steam call', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const prices = new Map([['292030', null]])
    const fetchPrices = vi.fn<SteamPriceFetch['fetchPrices']>(async () => {
      clock.advance(730)
      return prices
    })
    const timed = timedContext(
      contextOf({ steamPrices: { ...noSteamPrices, fetchPrices } }),
      timing,
    )

    expect(await timed.steamPrices.fetchPrices(['292030'])).toBe(prices)
    expect(fetchPrices).toHaveBeenCalledExactlyOnceWith(['292030'])
    await settle()
    expect(timing.header()).toBe('steam;dur=730;desc="Steam x1", total;dur=730')
  })

  it('times a price read the port gains, without having to be told of it', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    // A port with one read more than this suite knows by name, kept on the port's own state.
    const port = {
      ...noSteamPrices,
      asked: [] as string[],
      async fetchPrice(this: { asked: string[] }, appId: string) {
        this.asked.push(appId)
        clock.advance(410)
        return { priceUah: 404, regularPriceUah: 1349, discountPercent: 70, isFree: false }
      },
    }
    const timed = timedContext(
      contextOf({ steamPrices: port as unknown as SteamPriceFetch }),
      timing,
    ).steamPrices as unknown as typeof port

    expect(await timed.fetchPrice('292030')).toMatchObject({ priceUah: 404 })
    expect(port.asked).toEqual(['292030'])
    // What is not a read is handed on as it is.
    expect(timed.asked).toBe(port.asked)
    await settle()
    expect(timing.header()).toBe('steam;dur=410;desc="Steam x1", total;dur=410')
  })

  it('leaves a price read’s failure to the resolver that made it', async () => {
    const timing = createServerTiming(handClock().now)
    const failure = new UpstreamError('STEAM', 'TIMEOUT')
    const fetchPrices = vi.fn<SteamPriceFetch['fetchPrices']>(() => Promise.reject(failure))
    const timed = timedContext(
      contextOf({ steamPrices: { ...noSteamPrices, fetchPrices } }),
      timing,
    )

    await expect(timed.steamPrices.fetchPrices(['292030'])).rejects.toBe(failure)
    await settle()
    expect(timing.header()).toBe('steam;dur=0;desc="Steam x1", total;dur=0')
  })

  it('hands the refresh job’s language read on, unmeasured', async () => {
    const languages = { ukrainian: { text: true, audio: false }, isFree: false, price: null }
    const fetchAppLanguages = vi.fn(async () => languages)
    const timing = createServerTiming(handClock().now)
    const timed = timedContext(
      contextOf({
        steamPrices: { ...noSteamPrices, fetchAppLanguages } as unknown as SteamPriceFetch,
      }),
      timing,
    )

    expect(await timed.steamPrices.fetchAppLanguages('292030')).toBe(languages)
    expect(fetchAppLanguages).toHaveBeenCalledExactlyOnceWith('292030')
    expect(timing.header()).toBe('total;dur=0')
  })

  it('counts every read of the index, whichever it is, and keeps the index its own', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    // The in-memory adapter is a class: its methods are on the prototype, and need their `this`.
    const index = await publishTestIndex(DEV_FIXTURE_GAMES)
    const timed = timedContext(contextOf({ index }), timing)

    expect((await timed.index.meta())?.gameCount).toBe(DEV_FIXTURE_GAMES.length)
    expect(await timed.index.idBySlug('the-witcher-3-wild-hunt')).toBe(3328)
    expect((await timed.index.getOne(3328))?.slug).toBe('the-witcher-3-wild-hunt')
    expect((await timed.index.getMany([3328, 1])).size).toBe(1)
    expect((await timed.index.search({ pageSize: 2 })).games).toHaveLength(2)
    expect(await timed.index.allSlugs()).toHaveLength(DEV_FIXTURE_GAMES.length)
    await settle()

    expect(timing.header()).toBe('index;dur=0;desc="Index x6", total;dur=0')
  })

  it('times an index read that fails like one that answers', async () => {
    const clock = handClock()
    const timing = createServerTiming(clock.now)
    const down = new Error('The game index is unavailable: it did not answer within 1500ms')
    const index = {
      meta: async () => {
        clock.advance(1_500)
        throw down
      },
    } as unknown as GameIndex

    await expect(timedContext(contextOf({ index }), timing).index.meta()).rejects.toBe(down)
    await settle()
    expect(timing.header()).toBe('index;dur=1500;desc="Index x1", total;dur=1500')
  })

  it('leaves everything else on the context as it was', () => {
    const waitUntil = vi.fn()
    const context = contextOf({ waitUntil })
    const timed = timedContext(context, createServerTiming(handClock().now))

    expect(timed).not.toBe(context)
    expect(timed.today).toBe(context.today)
    expect(timed.now).toBe(context.now)
    expect(timed.cache).toBe(context.cache)
    expect(timed.waitUntil).toBe(waitUntil)
  })
})

const SLUG = 'the-witcher-3-wild-hunt'

/** The Witcher 3 as the index holds it: a price three hours old, and its Steam app id. */
const DOCUMENT = DEV_FIXTURE_GAMES[0]!

const PAGE = /* GraphQL */ `
  query Page($slug: String!) {
    game(slug: $slug) {
      name
      partial
      stores {
        store
      }
    }
  }
`

const PAGE_IN_UKRAINIAN = /* GraphQL */ `
  query Page($slug: String!, $locale: String!) {
    game(slug: $slug) {
      name
      partial
      localizedDescription(locale: $locale) {
        source
      }
    }
  }
`

/** Resolves after `ms` on the fake clock. */
const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Moves the fake clock on by `ms` and lets everything that became ready run to its end, a real
 * turn of the event loop included.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** RAWG's three answers about the page, each after its own time. */
function rawgTaking(ms: { detail: number; stores: number; screenshots: number }): RawgFetch {
  return async (path, params, options) => {
    if (path.endsWith('/stores')) await elapse(ms.stores)
    else if (path.endsWith('/screenshots')) await elapse(ms.screenshots)
    else await elapse(ms.detail)
    return fixtureRawg(path, params, options)
  }
}

/** The answer's header and body, once the clock has been moved far enough for it to go out. */
async function answerAfter(ms: number, response: Promise<Response>) {
  await advance(ms)
  const answered = await response
  return {
    status: answered.status,
    header: answered.headers.get('server-timing'),
    body: (await answered.json()) as QueryResult,
  }
}

describe('the Server-Timing header of a GraphQL answer', () => {
  beforeEach(() => {
    // The header's clock is `performance.now`, so it is faked with the timers it has to agree with.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })

  it('says what a game page waited for: RAWG, Steam, the index, and all of it together', async () => {
    const index = await publishTestIndex([DOCUMENT])
    const rawg = rawgTaking({ detail: 400, stores: 650, screenshots: 900 })
    const steam: SteamFetch = async (appId) => {
      await elapse(200)
      return fixtureSteam(appId)
    }

    const { status, header, body } = await answerAfter(
      1_100,
      postQuery({ index, rawg, steam }, PAGE_IN_UKRAINIAN, { slug: SLUG, locale: 'uk' }),
    )

    expect(status).toBe(200)
    expect(body.errors).toBeUndefined()
    expect(body.data!.game).toMatchObject({
      partial: false,
      localizedDescription: { source: 'STEAM' },
    })
    // RAWG's slowest of three, Steam's description after it, and three reads of an index in memory.
    expect(header).toBe(
      'rawg;dur=900;desc="RAWG x3", steam;dur=200;desc="Steam x1", index;dur=0;desc="Index x3", total;dur=1100',
    )
    expect(header).toMatch(SERVER_TIMING)
  })

  it('says how long a page answered from the index had waited for RAWG, which had not answered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await publishTestIndex([DOCUMENT])
    const rawg = rawgTaking({ detail: 7_000, stores: 100, screenshots: 100 })

    const { header, body } = await answerAfter(
      GAME_DETAIL_HEDGE_MS,
      postQuery({ index, rawg }, PAGE, { slug: SLUG }),
    )

    expect(body.data!.game.partial).toBe(true)
    expect(header).toBe('rawg;dur=2500;desc="RAWG x3", index;dur=0;desc="Index x3", total;dur=2500')
    await advance(7_000)
  })

  it('counts the limiter’s queue, shares a request that is still out, and leaves the cache out', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const index = await publishTestIndex([DOCUMENT])
    // The real transport: four requests a second, one cache, and a network that takes seven
    // seconds over the detail and a tenth of one over everything else.
    const store = new Map<string, CacheEntry>()
    const fetched: string[] = []
    const rawg = createRawgFetch({
      apiKey: 'test-key',
      fixtures: false,
      fetchJson: async (url) => {
        const path = new URL(url).pathname.replace(/^\/api\//, '')
        fetched.push(path)
        await elapse(path === `games/${SLUG}` ? 7_000 : 100)
        return { status: 200, body: await fixtureRawg(path) }
      },
      readFixture: async () => null,
      cache: {
        get: async (key) => store.get(key) ?? null,
        set: async (key, entry) => void store.set(key, entry),
      },
      now: () => 0,
      sleep: elapse,
      log: () => {},
    })

    // The first view goes out at its budget. The screenshots were third in the limiter's queue —
    // half a second — and a tenth on the wire, but the detail is what the answer waited for.
    const first = await answerAfter(
      GAME_DETAIL_HEDGE_MS,
      postQuery({ index, rawg }, PAGE, { slug: SLUG }),
    )
    expect(first.body.data!.game.partial).toBe(true)
    expect(first.header).toBe(
      'rawg;dur=2500;desc="RAWG x3", index;dur=0;desc="Index x3", total;dur=2500',
    )

    // Three seconds later the page asks again. The store links and the screenshots are in the
    // cache by now; the detail is the request the first view left running, a second and a half
    // from landing — and that is all this answer waits for RAWG.
    await advance(3_000)
    const second = await answerAfter(1_500, postQuery({ index, rawg }, PAGE, { slug: SLUG }))
    expect(second.body.data!.game.partial).toBe(false)
    expect(second.header).toBe(
      'rawg;dur=1500;desc="RAWG x1", index;dur=0;desc="Index x3", total;dur=1500',
    )

    // And a third view is all cache: RAWG is not named at all.
    const third = await answerAfter(0, postQuery({ index, rawg }, PAGE, { slug: SLUG }))
    expect(third.body.data!.game.partial).toBe(false)
    expect(third.header).toBe('index;dur=0;desc="Index x3", total;dur=0')
    expect(fetched).toEqual([`games/${SLUG}`, `games/${SLUG}/stores`, `games/${SLUG}/screenshots`])
  })

  it('shows the limiter’s queue in a page RAWG answers promptly', async () => {
    const index = await publishTestIndex([DOCUMENT])
    const rawg = createRawgFetch({
      apiKey: 'test-key',
      fixtures: false,
      fetchJson: async (url) => {
        await elapse(300)
        return {
          status: 200,
          body: await fixtureRawg(new URL(url).pathname.replace(/^\/api\//, '')),
        }
      },
      readFixture: async () => null,
      cache: { get: async () => null, set: async () => {} },
      now: () => 0,
      sleep: elapse,
      log: () => {},
    })

    // Sent a quarter of a second apart: the third waited half a second for its turn, then RAWG.
    const { header, body } = await answerAfter(
      800,
      postQuery({ index, rawg }, PAGE, { slug: SLUG }),
    )
    expect(body.data!.game.partial).toBe(false)
    expect(header).toBe('rawg;dur=800;desc="RAWG x3", index;dur=0;desc="Index x3", total;dur=800')
  })

  it('names the total alone on an answer that called nothing', async () => {
    const { header, body } = await answerAfter(0, postQuery({}, '{ __typename }'))
    expect(body.data).toEqual({ __typename: 'Query' })
    expect(header).toBe('total;dur=0')
  })

  it('names the total alone on an operation refused before any resolver ran', async () => {
    const rawg = vi.fn(fixtureRawg)
    const aliases = Array.from({ length: 13 }, (_, n) => `a${n}: genres { id }`).join(' ')
    const { status, header, body } = await answerAfter(0, postQuery({ rawg }, `{ ${aliases} }`))

    expect(status).toBe(200)
    expect(body.errors![0]!.extensions!.code).toBe('QUERY_TOO_COMPLEX')
    expect(rawg).not.toHaveBeenCalled()
    expect(header).toBe('total;dur=0')
  })

  it('is on an answer that is an error, with what the error waited for', async () => {
    const rawg: RawgFetch = async () => {
      await elapse(140)
      throw new UpstreamError('RAWG', 'NOT_FOUND', 404)
    }
    const { status, header, body } = await answerAfter(
      140,
      postQuery({ rawg }, PAGE, { slug: 'does-not-exist' }),
    )

    expect(status).toBe(200)
    expect(body.errors![0]!.extensions!.code).toBe('NOT_FOUND')
    // The index here was never published: one read of its metadata, and nothing to look up.
    expect(header).toBe('rawg;dur=140;desc="RAWG x3", index;dur=0;desc="Index x1", total;dur=140')
  })

  it('carries nothing of the request: no slug, no search, no address and no key', async () => {
    const SEARCH = 'half-life secret'
    const rawg: RawgFetch = async (path, params, options) => {
      await elapse(30)
      return fixtureRawg(path, params, options)
    }
    const { header, body } = await answerAfter(
      30,
      postQuery(
        { rawg },
        /* GraphQL */ `
          query Both($slug: String!, $search: String!) {
            game(slug: $slug) {
              name
            }
            games(filter: { search: $search }) {
              total
            }
          }
        `,
        { slug: SLUG, search: SEARCH },
      ),
    )

    expect(body.errors).toBeUndefined()
    // Names and numbers of this endpoint's own, and nothing else fits the shape.
    expect(header).toMatch(OURS)
    expect(header).toMatch(SERVER_TIMING)
    expect(header).toContain('rawg;')
    for (const hidden of [SLUG, 'witcher', 'half', 'secret', 'games', 'http', '/', '?', 'key']) {
      expect(header).not.toContain(hidden)
    }
  })

  it('names the total alone for a context that was not built to be timed', async () => {
    const rawg = vi.fn(fixtureRawg)
    const yoga = createYogaApp(() => contextOf({ rawg }))
    const response = await yoga.fetch('http://test/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ genres { id } }' }),
    })

    expect(rawg).toHaveBeenCalledExactlyOnceWith('genres', undefined)
    expect(response.headers.get('server-timing')).toBe('total;dur=0')
  })

  it('leaves the answer whole, without the header, when the clock cannot be read', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('no clock')
    })
    const index = await publishTestIndex([DOCUMENT])
    const rawg = rawgTaking({ detail: 100, stores: 100, screenshots: 100 })

    const { status, header, body } = await answerAfter(
      100,
      postQuery({ index, rawg }, PAGE, { slug: SLUG }),
    )

    expect(status).toBe(200)
    expect(body.errors).toBeUndefined()
    expect(body.data!.game).toMatchObject({ name: 'The Witcher 3: Wild Hunt', partial: false })
    expect(header).toBeNull()
  })
})
