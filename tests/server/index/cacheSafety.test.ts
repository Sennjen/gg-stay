import { describe, expect, it } from 'vitest'
import type { IndexQuery } from '../../../server/index/GameIndex'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { QUERIES } from '../../../scripts/index/smoke'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import { createFakeRedis } from './fakeRedis'

/**
 * The in-process cache is an optimisation and must never be a query's working set. An entry it
 * drops while a query is running — because the budget is smaller than that query needs, or because
 * a neighbouring query evicted it — used to change the answer: an evicted order set reported an
 * empty page, an evicted facet set silently dropped the filter and returned the whole index.
 *
 * So the rule is asserted the only way worth asserting it: every query the contract cares about,
 * at every budget from nothing at all to the shipped default, must answer exactly what the memory
 * adapter answers.
 */

async function publishFixture(
  index: ReturnType<typeof createUpstashIndex> | ReturnType<typeof createMemoryGameIndex>,
): Promise<void> {
  const version = await index.beginVersion()
  await index.writeVersion(version, FIXTURE_GAMES)
  await index.publish(version, {
    version,
    updatedAt: '2026-09-20T06:30:00.000Z',
    pricesUpdatedAt: '2026-09-20T06:00:00.000Z',
    gameCount: FIXTURE_GAMES.length,
  })
}

const shape = async (
  index: { search: (query: IndexQuery) => Promise<unknown> },
  query: IndexQuery,
) => JSON.stringify(await index.search(query))

describe('the cache never decides an answer', () => {
  const budgets: [string, { cacheBytes?: number; cacheEntries?: number }][] = [
    ['nothing at all', { cacheBytes: 0 }],
    ['one entry', { cacheEntries: 1 }],
    ['four hundred bytes', { cacheBytes: 400 }],
    ['the shipped default', {}],
  ]

  for (const [name, options] of budgets) {
    it(`answers every query of the contract exactly as the memory adapter does, with ${name}`, async () => {
      const redis = createFakeRedis()
      const live = createUpstashIndex(redis, options)
      const memory = createMemoryGameIndex()
      await publishFixture(live)
      await publishFixture(memory)

      for (const query of QUERIES) {
        // Twice: the second call is where an entry the first one evicted would show.
        expect(await shape(live, query), JSON.stringify(query)).toBe(await shape(memory, query))
        expect(await shape(live, query), JSON.stringify(query)).toBe(await shape(memory, query))
      }
    })
  }

  it('reports the same page however few entries it is allowed to keep', async () => {
    const memory = createMemoryGameIndex()
    await publishFixture(memory)
    const expected = await shape(memory, { genres: ['indie'], platforms: [4] })

    for (const cacheEntries of [200, 5, 4, 3, 2, 1]) {
      const redis = createFakeRedis()
      const live = createUpstashIndex(redis, { cacheEntries })
      await publishFixture(live)
      expect(
        await shape(live, { genres: ['indie'], platforms: [4] }),
        `entries=${cacheEntries}`,
      ).toBe(expected)
    }
  })

  it('never loses a filter because the budget was too small for it', async () => {
    const memory = createMemoryGameIndex()
    await publishFixture(memory)
    const expected = await shape(memory, { genres: ['indie'] })

    for (const cacheBytes of [8_000_000, 400, 300, 0]) {
      const redis = createFakeRedis()
      const live = createUpstashIndex(redis, { cacheBytes })
      await publishFixture(live)
      const first = await shape(live, { genres: ['indie'] })
      const second = await shape(live, { genres: ['indie'] })
      expect(first, `bytes=${cacheBytes} first`).toBe(expected)
      expect(second, `bytes=${cacheBytes} second`).toBe(expected)
    }
  })

  it('still answers when it keeps nothing and the query needs many sets', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis, { cacheBytes: 0, cacheEntries: 1 })
    const memory = createMemoryGameIndex()
    await publishFixture(live)
    await publishFixture(memory)
    const query: IndexQuery = {
      genres: ['indie', 'strategy'],
      platforms: [4, 7],
      stores: ['steam', 'gog'],
      metacriticMin: 10,
      ratingMin: 1,
      yearFrom: 2000,
      yearTo: 2026,
      search: 'a',
    }
    expect(await shape(live, query)).toBe(await shape(memory, query))
  })
})

describe('what the cache does do', () => {
  it('shares one fetch between requests that arrive together on a cold instance', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis)
    await publishFixture(live)
    await live.currentVersion()

    const before = redis.roundTrips
    const [first, second, third] = await Promise.all([
      live.search({ genres: ['indie'] }),
      live.search({ genres: ['indie'] }),
      live.search({ genres: ['indie'] }),
    ])
    expect(first.ids).toEqual([2, 3, 5])
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    // One request for the sets the three of them share, then one MGET each.
    expect(redis.roundTrips - before).toBe(4)
  })

  it('reports the failure of a shared fetch to everyone waiting on it', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis)
    await publishFixture(live)
    await live.currentVersion()
    // A set written as the wrong type is how a shared read fails for everyone at once.
    const broken = redis.pipeline()
    broken.del(['idx:v1:o:POPULARITY_DESC'])
    broken.sadd('idx:v1:o:POPULARITY_DESC', ['1'])
    await broken.exec()

    const results = await Promise.allSettled([live.search({}), live.search({})])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])

    // And the failure is not remembered: the next request asks again.
    const repaired = redis.pipeline()
    repaired.del(['idx:v1:o:POPULARITY_DESC'])
    repaired.zadd('idx:v1:o:POPULARITY_DESC', [[0, '1']])
    await repaired.exec()
    expect((await live.search({})).ids).toEqual([1])
  })

  it('reads one set for a facet however the caller ordered its values', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis)
    await publishFixture(live)
    const first = await live.search({ genres: ['indie', 'strategy'] })

    const before = redis.roundTrips
    const second = await live.search({ genres: ['strategy', 'indie'] })
    expect(second.ids).toEqual(first.ids)
    // The same set, so only the documents are fetched again.
    expect(redis.roundTrips - before).toBe(1)
    expect(live.cached().entries).toBe(2)
  })
})
