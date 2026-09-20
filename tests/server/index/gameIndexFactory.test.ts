import { describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../../server/index/GameIndex'
import type { PublishedFixture } from '../../../server/index/index'
import {
  createGameIndex,
  degradeOnFailure,
  IndexUnavailableError,
  STALE_SEED_AGE_MS,
  staleSeedAt,
  unavailableGameIndex,
  withCircuit,
  withDeadline,
} from '../../../server/index/index'
import { INDEX_STALE_AFTER_MS } from '../../../server/graphql/indexPath'
import published from '../../fixtures/index/published.json' with { type: 'json' }

/**
 * The factory the site reads the index through. Its whole job is that a page never fails because
 * of it: an unreachable store, a missing fixture or a broken one all come out as the same
 * unavailable index, and the resolver that falls back to RAWG has one error type to catch.
 */

const fixture = published as unknown as PublishedFixture

const sources = (overrides: Partial<Parameters<typeof createGameIndex>[0]> = {}) => ({
  upstashRedisRestUrl: '',
  upstashRedisRestToken: '',
  fixtures: true,
  readFixture: async () => fixture,
  seededAt: () => '2026-09-20T07:00:00.000Z',
  onError: () => undefined,
  ...overrides,
})

/**
 * The seeded fixture describes real, named games with plausible commercial prices, so it may only
 * ever answer in fixture mode. Every other configuration without credentials is "not configured",
 * which the design says behaves exactly like "unreachable": RAWG, no prices, one warning.
 */
describe('which index answers, by configuration', () => {
  const credentials = { upstashRedisRestUrl: 'https://x.upstash.io', upstashRedisRestToken: 't' }

  it('uses the fixture in fixture mode without credentials', async () => {
    const index = await createGameIndex(sources({ fixtures: true }))
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
  })

  it('refuses to answer outside fixture mode without credentials, and says so once', async () => {
    const onError = vi.fn()
    const readFixture = vi.fn(async () => fixture)
    const index = await createGameIndex(sources({ fixtures: false, onError, readFixture }))
    expect(await index.meta()).toBeNull()
    expect(await index.getMany([3328])).toEqual(new Map())
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    // The seed asset is not even read outside fixture mode.
    expect(readFixture).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(String(onError.mock.calls[0]![0])).toContain('no credentials are set')
  })

  it('refuses to answer outside fixture mode when only one credential is set', async () => {
    const onError = vi.fn()
    const index = await createGameIndex(
      sources({ fixtures: false, onError, upstashRedisRestUrl: 'https://x.upstash.io' }),
    )
    expect(await index.meta()).toBeNull()
    expect(String(onError.mock.calls[0]![0])).toContain('only one credential is configured')
  })

  it('prefers the credentials over the fixture whenever both are present', async () => {
    const readFixture = vi.fn(async () => fixture)
    const index = await createGameIndex(sources({ fixtures: true, readFixture, ...credentials }))
    // The seed is never read, so nothing it holds can be served. Nothing is called on the index
    // itself: building the adapter sends no request, and this suite never touches the network.
    expect(readFixture).not.toHaveBeenCalled()
    expect(index).not.toBe(null)
  })
})

/**
 * `INDEX_FIXTURE_STALE=1` exists so the stale banner and the controls it takes away can be looked
 * at in a browser without waiting a week. It is production code, so the invariant its safety rests
 * on gets a test of its own rather than an eyeballed `&&`: **outside fixture mode it does nothing
 * at all**, whatever it is set to. A deployment with real credentials never sets `RAWG_FIXTURES`,
 * so it can never reach the seed path — this pins that the flag cannot change the seeding of an
 * index that is not the fixture one either.
 */
describe('INDEX_FIXTURE_STALE', () => {
  const NOW = Date.parse('2026-09-20T12:00:00.000Z')
  const at = (fixtures: boolean, flag: unknown) => staleSeedAt(fixtures, flag, () => NOW)

  it('is ignored with fixtures off, whatever it is set to', () => {
    for (const flag of ['1', 1, 'true', 'yes', '0', '', undefined, null]) {
      expect(at(false, flag)).toBeUndefined()
    }
  })

  it('is ignored in fixture mode unless it is exactly "1"', () => {
    for (const flag of ['0', '', 'true', 'yes', 'stale', undefined, null]) {
      expect(at(true, flag)).toBeUndefined()
    }
  })

  it('backdates the seed only when fixture mode and the flag are both on', () => {
    // destr parses an env override, so `1` can arrive as a number as well as a string.
    for (const flag of ['1', 1]) {
      const seededAt = at(true, flag)
      expect(seededAt).toBeTypeOf('function')
      expect(seededAt!()).toBe(new Date(NOW - STALE_SEED_AGE_MS).toISOString())
    }
  })

  it('backdates it past the seven days the catalog calls stale, not onto the boundary', () => {
    expect(STALE_SEED_AGE_MS).toBeGreaterThan(INDEX_STALE_AFTER_MS)
  })

  it('actually publishes a stale seed, and the default publishes a fresh one', async () => {
    const stale = await createGameIndex(
      sources({ seededAt: staleSeedAt(true, '1', () => NOW), fixtures: true }),
    )
    const age = NOW - Date.parse((await stale.meta())!.pricesUpdatedAt!)
    expect(age).toBeGreaterThan(INDEX_STALE_AFTER_MS)

    // With fixture mode off the helper hands back nothing, and `seedFromFixture` falls back to
    // "published just now" — which is what every development server has always had.
    const fresh = await createGameIndex(sources({ seededAt: staleSeedAt(false, '1', () => NOW) }))
    const freshAge = Date.now() - Date.parse((await fresh.meta())!.pricesUpdatedAt!)
    expect(freshAge).toBeLessThan(INDEX_STALE_AFTER_MS)
  })
})

describe('createGameIndex', () => {
  it('seeds the in-memory index from the fixture when there are no credentials', async () => {
    const index = await createGameIndex(sources())
    expect((await index.search({ ukrainianLocalisation: 'AUDIO' })).ids).toEqual([3328])
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
    // Published as if it had just been built, so a development server is never stale.
    expect((await index.meta())?.updatedAt).toBe('2026-09-20T07:00:00.000Z')
  })

  it('moves every price timestamp forward by the same amount as the run itself', async () => {
    // The fixture records a price fetched three hours before its run finished. Seeding shifts the
    // whole recorded timeline to the seeding moment, so a development game page shows a plausible
    // "updated N hours ago" and does not ask Steam to refresh a price on every request.
    const index = await createGameIndex(sources())
    expect((await index.getOne(3328))?.priceUpdatedAt).toBe('2026-09-20T04:00:00.000Z')
    expect((await index.getOne(4200))?.priceUpdatedAt).toBe('2026-09-20T07:00:00.000Z')
  })

  it('answers an empty index rather than failing when there is no fixture', async () => {
    const index = await createGameIndex(sources({ readFixture: async () => null }))
    expect(await index.search({})).toEqual({ ids: [], total: 0, games: [] })
    expect(await index.meta()).toBeNull()
  })

  it('reports an unavailable index instead of throwing when it cannot be built', async () => {
    const onError = vi.fn()
    const index = await createGameIndex(
      sources({
        readFixture: () => Promise.reject(new Error('the asset store is broken')),
        onError,
      }),
    )
    expect(onError).toHaveBeenCalledOnce()
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    expect(await index.meta()).toBeNull()
    expect(await index.getMany([1, 2])).toEqual(new Map())
    expect(await index.getOne(1)).toBeNull()
  })
})

describe('an unavailable index', () => {
  it('says so in one shape', async () => {
    const index = unavailableGameIndex('nothing is configured')
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.search({})).rejects.toThrow(/nothing is configured/)
    expect(await index.meta()).toBeNull()
    expect(await index.getMany([1])).toEqual(new Map())
    expect(await index.getOne(1)).toBeNull()
  })
})

describe('withDeadline', () => {
  const hung: GameIndex = {
    search: () => new Promise(() => {}),
    getMany: () => new Promise(() => {}),
    getOne: () => new Promise(() => {}),
    meta: () => new Promise(() => {}),
  }

  /** Fires every pending deadline immediately, so no test waits for a real timer. */
  function immediateTimers() {
    return {
      setTimeout: (handler: () => void) => {
        handler()
        return 0
      },
      clearTimeout: () => undefined,
    }
  }

  it('turns a call that never settles into an unavailable index', async () => {
    const index = withDeadline(hung, { timeoutMs: 1500, setTimer: immediateTimers() })
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.search({})).rejects.toThrow(/within 1500ms/)
    await expect(index.meta()).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getOne(1)).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getMany([1])).rejects.toBeInstanceOf(IndexUnavailableError)
  })

  it('lets an answer that arrives in time through, and cancels its timer', async () => {
    const cleared: unknown[] = []
    const index = withDeadline(await createGameIndex(sources()), {
      setTimer: {
        setTimeout: () => 'handle',
        clearTimeout: (handle) => cleared.push(handle),
      },
    })
    expect((await index.getOne(4200))?.name).toBe('Portal 2')
    expect(cleared).toEqual(['handle'])
  })

  it('keeps the original failure rather than replacing it with a deadline', async () => {
    const failing: GameIndex = {
      ...hung,
      meta: () => Promise.reject(new Error('ECONNRESET')),
    }
    const index = withDeadline(failing, {
      setTimer: { setTimeout: () => 0, clearTimeout: () => {} },
    })
    await expect(index.meta()).rejects.toThrow('ECONNRESET')
  })
})

describe('withCircuit', () => {
  const broken: GameIndex = {
    search: () => Promise.reject(new Error('ECONNRESET')),
    getMany: () => Promise.reject(new Error('ECONNRESET')),
    getOne: () => Promise.reject(new Error('ECONNRESET')),
    meta: () => Promise.reject(new Error('ECONNRESET')),
  }

  it('skips the index for a while after one failure, then tries again', async () => {
    let now = 1_000
    const calls = vi.fn()
    const counted: GameIndex = { ...broken, meta: () => (calls(), broken.meta()) }
    const index = withCircuit(counted, { openMs: 30_000, now: () => now })

    await expect(index.meta()).rejects.toThrow('ECONNRESET')
    expect(calls).toHaveBeenCalledOnce()

    // Inside the window nothing leaves the process at all.
    await expect(index.meta()).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.search({})).rejects.toThrow(/skipped/)
    expect(calls).toHaveBeenCalledOnce()

    now += 30_000
    await expect(index.meta()).rejects.toThrow('ECONNRESET')
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('opens on three slow answers in a row, and a fast one puts the count back', async () => {
    // A store that answers every time, 1 400 ms late, never rejects and never reaches its
    // deadline: a failure count alone would never notice it, and every page would keep paying.
    let now = 1_000
    let takes = 1_400
    const slow: GameIndex = {
      ...broken,
      meta: async () => {
        now += takes
        return null
      },
    }
    const index = withCircuit(slow, { slowMs: 700, strikes: 3, openMs: 30_000, now: () => now })

    expect(await index.meta()).toBeNull()
    expect(await index.meta()).toBeNull()

    // A fast answer between them clears the strikes, so ordinary jitter cannot close the index.
    takes = 100
    expect(await index.meta()).toBeNull()
    takes = 1_400
    expect(await index.meta()).toBeNull()
    expect(await index.meta()).toBeNull()
    // The third consecutive slow answer is still served — it is already here — and closes the
    // index behind it.
    expect(await index.meta()).toBeNull()

    await expect(index.meta()).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.meta()).rejects.toThrow(/skipped/)

    now += 30_000
    expect(await index.meta()).toBeNull()
  })

  it('says why it closed the index, so a log can tell slow from broken', async () => {
    let now = 1_000
    const reasons: string[] = []
    const slow: GameIndex = {
      ...broken,
      meta: async () => {
        now += 1_400
        return null
      },
    }
    const index = withCircuit(slow, {
      slowMs: 700,
      strikes: 2,
      now: () => now,
      onOpen: (reason) => reasons.push(reason),
    })
    await index.meta()
    await index.meta()
    expect(reasons).toEqual(['slow'])

    const failing = withCircuit(broken, { now: () => now, onOpen: (r) => reasons.push(r) })
    await expect(failing.meta()).rejects.toThrow('ECONNRESET')
    expect(reasons).toEqual(['slow', 'failed'])
  })

  it('counts every method towards the same strike count', async () => {
    let now = 1_000
    const tick = <T>(value: T) => {
      now += 1_400
      return Promise.resolve(value)
    }
    const slow: GameIndex = {
      search: () => tick({ ids: [], total: 0, games: [] }),
      getMany: () => tick(new Map()),
      getOne: () => tick(null),
      meta: () => tick(null),
    }
    const index = withCircuit(slow, { slowMs: 700, strikes: 3, now: () => now })
    await index.meta()
    await index.getOne(1)
    await index.getMany([1])
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
  })

  it('leaves a healthy index alone', async () => {
    const index = withCircuit(await createGameIndex(sources()))
    expect((await index.getOne(4200))?.name).toBe('Portal 2')
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
  })
})

describe('degradeOnFailure', () => {
  const broken: GameIndex = {
    search: () => Promise.reject(new Error('ECONNRESET')),
    getMany: () => Promise.reject(new Error('ECONNRESET')),
    getOne: () => Promise.reject(new Error('ECONNRESET')),
    meta: () => Promise.reject(new Error('ECONNRESET')),
  }

  it('turns a store that stopped answering into the unavailable shape, on every method', async () => {
    const onError = vi.fn()
    const index = degradeOnFailure(broken, onError)
    // Every method rejects, so a caller can tell "it failed" from "it holds nothing" and stop
    // asking. `unavailableGameIndex` is the quiet one; a failure is not.
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getMany([1])).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getOne(1)).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.meta()).rejects.toBeInstanceOf(IndexUnavailableError)
    expect(onError).toHaveBeenCalledTimes(4)
  })

  it('keeps a deadline as the deadline it was, rather than renaming it', async () => {
    const hung: GameIndex = {
      search: () => new Promise(() => {}),
      getMany: () => new Promise(() => {}),
      getOne: () => new Promise(() => {}),
      meta: () => new Promise(() => {}),
    }
    const index = degradeOnFailure(
      withDeadline(hung, {
        timeoutMs: 1500,
        setTimer: { setTimeout: (handler) => (handler(), 0), clearTimeout: () => {} },
      }),
    )
    await expect(index.meta()).rejects.toThrow(/within 1500ms/)
  })

  it('passes a working index through untouched', async () => {
    const index = degradeOnFailure(await createGameIndex(sources()))
    expect((await index.search({ genres: ['indie'] })).ids).toEqual([654])
    expect((await index.getOne(4200))?.name).toBe('Portal 2')
  })
})
