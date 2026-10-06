import { describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../../server/index/GameIndex'
import type { PublishedFixture } from '../../../server/index/index'
import {
  createGameIndex,
  DEFAULT_BULK_TIMEOUT_MS,
  DEFAULT_INDEX_TIMEOUT_MS,
  degradeOnFailure,
  IndexUnavailableError,
  STALE_SEED_AGE_MS,
  staleSeedAt,
  unavailableGameIndex,
  withCircuit,
  withDeadline,
} from '../../../server/index/index'
import type { RedisBatch, RedisCommands } from '../../../server/index/redisCommands'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { INDEX_STALE_AFTER_MS } from '../../../server/graphql/indexPath'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import published from '../../fixtures/index/published.json' with { type: 'json' }
import { FIXTURE_META } from './contract'
import { createFakeRedis } from './fakeRedis'

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
    expect(await index.idBySlug('the-witcher-3-wild-hunt')).toBeNull()
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

  it('finds a seeded game by its slug through every layer the site adds', async () => {
    const index = await createGameIndex(sources())
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect((await index.getOne(4200))?.slug).toBe('portal-2')
    // Not in the index is an answer, not a failure: nothing is reported and nothing is skipped.
    const onError = vi.fn()
    const quiet = await createGameIndex(sources({ onError }))
    expect(await quiet.idBySlug('no-such-game')).toBeNull()
    expect(await quiet.idBySlug('Portal-2')).toBeNull()
    expect(await quiet.idBySlug('portal-2')).toBe(4200)
    expect(onError).not.toHaveBeenCalled()
  })

  it('fails a slug lookup exactly as it fails a document read', async () => {
    // Every deadline fires at once, which is what a store that has gone quiet looks like.
    const immediate = {
      setTimeout: (handler: () => void) => (handler(), 0),
      clearTimeout: () => {},
    }
    const failing = async (call: (index: GameIndex) => Promise<unknown>) => {
      const reported: string[] = []
      const index = await createGameIndex(
        sources({
          setTimer: immediate,
          now: () => 1_000,
          onError: (error) => reported.push(error instanceof Error ? error.message : String(error)),
        }),
      )
      const first = await call(index).catch((error: unknown) => error)
      const second = await call(index).catch((error: unknown) => error)
      return { first, second, reported }
    }

    const bySlug = await failing((index) => index.idBySlug('portal-2'))
    const byId = await failing((index) => index.getOne(4200))

    // The deadline, under the one name every caller catches; then the circuit, without a call.
    expect(bySlug.first).toBeInstanceOf(IndexUnavailableError)
    expect((bySlug.first as Error).message).toMatch(/did not answer within 1500ms/)
    expect(bySlug.second).toBeInstanceOf(IndexUnavailableError)
    expect((bySlug.second as Error).message).toMatch(/skipped/)
    // And nothing about it differs from `getOne`: the same errors, the same reports.
    expect((bySlug.first as Error).message).toBe((byId.first as Error).message)
    expect((bySlug.second as Error).message).toBe((byId.second as Error).message)
    expect(bySlug.reported).toEqual(byId.reported)
    expect(bySlug.reported.some((line) => /skipping it for a while/.test(line))).toBe(true)
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
    expect(await index.idBySlug('portal-2')).toBeNull()
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
    // Quietly, like `getOne`: nothing failed, the index simply holds no such game.
    expect(await index.idBySlug('portal-2')).toBeNull()
    expect(await index.allSlugs()).toEqual([])
  })
})

describe('withDeadline', () => {
  const hung: GameIndex = {
    search: () => new Promise(() => {}),
    getMany: () => new Promise(() => {}),
    getOne: () => new Promise(() => {}),
    idBySlug: () => new Promise(() => {}),
    meta: () => new Promise(() => {}),
    allSlugs: () => new Promise(() => {}),
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
    await expect(index.idBySlug('portal-2')).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.allSlugs()).rejects.toBeInstanceOf(IndexUnavailableError)
  })

  it('gives a slug lookup the page budget, like the document read it leads to', async () => {
    const budgets: number[] = []
    const index = withDeadline(hung, {
      timeoutMs: 1500,
      bulkTimeoutMs: 10_000,
      setTimer: {
        setTimeout: (handler, ms) => {
          budgets.push(ms)
          handler()
          return 0
        },
        clearTimeout: () => undefined,
      },
    })
    await expect(index.idBySlug('portal-2')).rejects.toThrow(/within 1500ms/)
    await expect(index.getOne(4200)).rejects.toThrow(/within 1500ms/)
    expect(budgets).toEqual([1500, 1500])
  })

  it('gives the sitemap read a budget of its own, far longer than a page read', async () => {
    // Every slug of the index is thousands of documents: it would never fit the page budget,
    // and a sitemap is fetched by a crawler, not waited for by a visitor.
    const budgets: number[] = []
    const index = withDeadline(hung, {
      timeoutMs: 1500,
      bulkTimeoutMs: 10_000,
      setTimer: {
        setTimeout: (handler, ms) => {
          budgets.push(ms)
          handler()
          return 0
        },
        clearTimeout: () => undefined,
      },
    })
    await expect(index.allSlugs()).rejects.toThrow(/within 10000ms/)
    await expect(index.meta()).rejects.toThrow(/within 1500ms/)
    expect(budgets).toEqual([10_000, 1500])
    expect(DEFAULT_BULK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_INDEX_TIMEOUT_MS)
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
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect(cleared).toEqual(['handle', 'handle'])
  })

  it('passes on how many requests the index has sent, for the circuit around it to read', () => {
    // The circuit wraps the deadline, so what an adapter says about its store has to come
    // through here; an index with no store to count says nothing, and neither does this.
    expect(withDeadline({ ...hung, storeRequests: () => 7 }).storeRequests?.()).toBe(7)
    expect(withDeadline(hung).storeRequests).toBeUndefined()
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
    idBySlug: () => Promise.reject(new Error('ECONNRESET')),
    meta: () => Promise.reject(new Error('ECONNRESET')),
    allSlugs: () => Promise.reject(new Error('ECONNRESET')),
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

  it('lets a slug lookup open the circuit, and skips it while the circuit is open', async () => {
    let now = 1_000
    const calls = vi.fn()
    const counted: GameIndex = {
      ...broken,
      idBySlug: (slug) => (calls(slug), broken.idBySlug(slug)),
    }
    const index = withCircuit(counted, { openMs: 30_000, now: () => now })

    await expect(index.idBySlug('portal-2')).rejects.toThrow('ECONNRESET')
    expect(calls).toHaveBeenCalledOnce()

    // Open: neither the lookup nor the document read it would lead to leaves the process.
    await expect(index.idBySlug('portal-2')).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.idBySlug('portal-2')).rejects.toThrow(/skipped/)
    await expect(index.getOne(4200)).rejects.toThrow(/skipped/)
    expect(calls).toHaveBeenCalledOnce()

    now += 30_000
    await expect(index.idBySlug('portal-2')).rejects.toThrow('ECONNRESET')
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
      idBySlug: () => tick(null),
      meta: () => tick(null),
      allSlugs: () => tick([]),
    }
    const index = withCircuit(slow, { slowMs: 700, strikes: 4, now: () => now })
    await index.meta()
    await index.getOne(1)
    await index.getMany([1])
    // The fourth slow answer is still served, as every answer that arrived is, and closes the
    // index behind it.
    expect(await index.idBySlug('portal-2')).toBeNull()
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.idBySlug('portal-2')).rejects.toBeInstanceOf(IndexUnavailableError)
  })

  /**
   * A game page asks for its slug between its metadata and its document, and a slug the adapter
   * remembers — or refuses to look up — is answered without a request. Such an answer says
   * nothing about the store. Counted as a fast one it would wipe the strikes out twice a page,
   * and a store that crawled would never be skipped again.
   */
  it('takes no notice of an answer the store was not asked for', async () => {
    let now = 1_000
    let sent = 0
    const fromStore = <T>(value: T, takes: number) => {
      sent += 1
      now += takes
      return Promise.resolve(value)
    }
    const index = withCircuit(
      {
        ...broken,
        meta: () => fromStore(null, 1_400),
        getOne: () => fromStore(null, 1_400),
        // From memory: no request, and no time to speak of.
        idBySlug: async () => 4200,
        storeRequests: () => sent,
      },
      { slowMs: 700, strikes: 3, now: () => now },
    )

    // Neither a strike nor a clean slate: the two slow answers around each one still add up.
    expect(await index.meta()).toBeNull()
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect(await index.getOne(4200)).toBeNull()
    expect(await index.idBySlug('portal-2')).toBe(4200)
    // The third slow answer from the store, with two answers from memory in between.
    expect(await index.meta()).toBeNull()
    await expect(index.getOne(4200)).rejects.toThrow(/skipped/)
    await expect(index.idBySlug('portal-2')).rejects.toThrow(/skipped/)
  })

  it('does not call such an answer slow either, however long it took', async () => {
    let now = 1_000
    const index = withCircuit(
      {
        ...broken,
        // Late, but not because of the store: nothing was sent.
        idBySlug: async () => {
          now += 5_000
          return 4200
        },
        storeRequests: () => 0,
      },
      { slowMs: 700, strikes: 1, now: () => now },
    )
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect(await index.idBySlug('portal-2')).toBe(4200)
  })

  it('still lets a fast answer from the store put the count back', async () => {
    let now = 1_000
    let sent = 0
    let takes = 1_400
    const index = withCircuit(
      {
        ...broken,
        meta: async () => {
          sent += 1
          now += takes
          return null
        },
        storeRequests: () => sent,
      },
      { slowMs: 700, strikes: 3, now: () => now },
    )
    await index.meta()
    await index.meta()
    takes = 100
    await index.meta()
    takes = 1_400
    await index.meta()
    await index.meta()
    // Two slow, one fast, two slow: the index is still being asked.
    expect(await index.meta()).toBeNull()
    await expect(index.meta()).rejects.toThrow(/skipped/)
  })

  it('still finds a slow store slow once the adapter remembers the slug', async () => {
    // The whole arrangement, on the real adapter: a store that takes 1.4 s a request, behind the
    // deadline and the circuit, and a page that asks for its metadata, its slug and its document.
    let now = 1_000
    const redis = createFakeRedis()
    const slowly = (batch: RedisBatch): RedisBatch =>
      new Proxy(batch, {
        get(target, property, receiver) {
          if (property !== 'exec') return Reflect.get(target, property, receiver) as unknown
          return async () => {
            if (target.size > 0) now += 1_400
            return target.exec()
          }
        },
      })
    const slowStore: RedisCommands = {
      pipeline: () => slowly(redis.pipeline()),
      multi: () => slowly(redis.multi()),
    }
    const writer = createUpstashIndex(redis, { runId: 'the-run' })
    const version = await writer.beginVersion()
    await writer.writeVersion(version, FIXTURE_GAMES)
    await writer.publish(version, { ...FIXTURE_META, version, gameCount: FIXTURE_GAMES.length })

    const adapter = createUpstashIndex(slowStore, {
      now: () => now,
      currentVersionTtlMs: 60 * 60_000,
    })
    const index = withCircuit(
      withDeadline(adapter, { setTimer: { setTimeout: () => 0, clearTimeout: () => {} } }),
      { slowMs: 700, strikes: 3, openMs: 30_000, now: () => now },
    )
    const view = async () => {
      await index.meta()
      const id = await index.idBySlug('kite-keep')
      return index.getOne(id!)
    }

    // The first view pays for all three, slowly, and the third closes the index behind it.
    expect((await view())?.slug).toBe('kite-keep')
    await expect(index.meta()).rejects.toThrow(/skipped/)

    // Half a minute later the slug is remembered. Its answer costs nothing and says nothing: the
    // two reads around it are the first and second strike, and the next page's first read is
    // the third — where a count that took the remembered slug for a fast answer would start
    // again from nothing on every page and never get there.
    now += 30_000
    const sent = adapter.stats().requests
    expect((await view())?.slug).toBe('kite-keep')
    expect(adapter.stats().requests - sent).toBe(2)
    // A slug that is refused before it is sent is no more of an answer from the store.
    expect(await index.idBySlug('x'.repeat(10_000))).toBeNull()
    expect(await index.meta()).not.toBeNull()
    await expect(index.getOne(35)).rejects.toThrow(/skipped/)
  })

  it('keeps the sitemap read out of an open circuit, without letting it open or feed one', async () => {
    let now = 1_000
    const reasons: string[] = []
    const slowSlugs: GameIndex = {
      ...broken,
      meta: async () => null,
      allSlugs: async () => {
        now += 5_000
        return [{ slug: 'a', updatedAt: '2026-09-20T06:30:00.000Z' }]
      },
    }
    const index = withCircuit(slowSlugs, {
      slowMs: 700,
      strikes: 1,
      now: () => now,
      onOpen: (reason) => reasons.push(reason),
    })
    // A read of the whole index is slow by nature; it must not close the index for the pages.
    expect(await index.allSlugs()).toHaveLength(1)
    expect(await index.meta()).toBeNull()
    expect(reasons).toEqual([])

    const failing = withCircuit(broken, { now: () => now, onOpen: (r) => reasons.push(r) })
    await expect(failing.allSlugs()).rejects.toThrow('ECONNRESET')
    expect(reasons).toEqual([])

    // But while a page has closed the index, the sitemap does not knock on it either.
    await expect(failing.meta()).rejects.toThrow('ECONNRESET')
    await expect(failing.allSlugs()).rejects.toBeInstanceOf(IndexUnavailableError)
  })

  it('leaves a healthy index alone', async () => {
    const index = withCircuit(await createGameIndex(sources()))
    expect((await index.getOne(4200))?.name).toBe('Portal 2')
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
  })
})

describe('degradeOnFailure', () => {
  const broken: GameIndex = {
    search: () => Promise.reject(new Error('ECONNRESET')),
    getMany: () => Promise.reject(new Error('ECONNRESET')),
    getOne: () => Promise.reject(new Error('ECONNRESET')),
    idBySlug: () => Promise.reject(new Error('ECONNRESET')),
    meta: () => Promise.reject(new Error('ECONNRESET')),
    allSlugs: () => Promise.reject(new Error('ECONNRESET')),
  }

  it('turns a store that stopped answering into the unavailable shape, on every method', async () => {
    const onError = vi.fn()
    const index = degradeOnFailure(broken, onError)
    // Every method rejects, so a caller can tell "it failed" from "it holds nothing" and stop
    // asking. `unavailableGameIndex` is the quiet one; a failure is not.
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getMany([1])).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.getOne(1)).rejects.toBeInstanceOf(IndexUnavailableError)
    // A slug lookup could answer `null`, and `null` would read as "not in the index" — the one
    // answer that must not be given for a store that failed.
    await expect(index.idBySlug('portal-2')).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.idBySlug('portal-2')).rejects.toThrow(/the store did not answer/)
    await expect(index.meta()).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.allSlugs()).rejects.toBeInstanceOf(IndexUnavailableError)
    expect(onError).toHaveBeenCalledTimes(7)
  })

  it('keeps a deadline as the deadline it was, rather than renaming it', async () => {
    const hung: GameIndex = {
      search: () => new Promise(() => {}),
      getMany: () => new Promise(() => {}),
      getOne: () => new Promise(() => {}),
      idBySlug: () => new Promise(() => {}),
      meta: () => new Promise(() => {}),
      allSlugs: () => new Promise(() => {}),
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
    expect(await index.idBySlug('portal-2')).toBe(4200)
    expect(await index.idBySlug('no-such-game')).toBeNull()
  })
})
