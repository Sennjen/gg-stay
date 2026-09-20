import { describe, expect, it } from 'vitest'
import type { IndexedGame } from '../../../server/index/document'
import { CURRENT_VERSION_KEY, versionPrefix } from '../../../server/index/keys'
import type { SendCommands } from '../../../server/index/upstashIndex'
import { createRedisCommands, createUpstashIndex } from '../../../server/index/upstashIndex'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import { describeGameIndexContract, FIXTURE_META, publishGames } from './contract'
import type { FakeRedis } from './fakeRedis'
import { createFakeRedis } from './fakeRedis'

/**
 * The adapter against the fake store. The shared contract suite is the bulk of it — the rules an
 * adapter owes its callers are written once and run here too, a second time through a read-only
 * token — and the cases below are the ones only this adapter can fail: what a read costs, what it
 * remembers, how a large version is chunked, and what a publication does to what it replaced.
 */

function makeAdapter(options: { now?: () => number } = {}): {
  redis: FakeRedis
  index: ReturnType<typeof createUpstashIndex>
} {
  const redis = createFakeRedis()
  return { redis, index: createUpstashIndex(redis, options) }
}

const adapterFor = (index: ReturnType<typeof createUpstashIndex>, redis: FakeRedis) => ({
  index,
  writer: index,
  rival: createUpstashIndex(redis, { runId: 'another-run' }),
})

describeGameIndexContract('upstashIndex', () => {
  const redis = createFakeRedis()
  const adapter = createUpstashIndex(redis, { runId: 'the-run' })
  return {
    index: adapter,
    writer: adapter,
    rival: createUpstashIndex(redis, { runId: 'another-run' }),
    teardown: () => redis.reset(),
  }
})

/**
 * The same suite again, with the reader holding the token the site holds: a read path that issues
 * one write command fails every case here, because the fake refuses a write on this view exactly
 * as Upstash refuses one. The reader re-reads the pointer every time, since the version it must
 * see is published by a different adapter object.
 */
describeGameIndexContract('upstashIndex over a read-only token', () => {
  const redis = createFakeRedis()
  const writer = createUpstashIndex(redis, { runId: 'the-run' })
  return {
    index: createUpstashIndex(redis.readOnly(), { currentVersionTtlMs: 0 }),
    writer,
    rival: createUpstashIndex(redis, { runId: 'another-run' }),
    teardown: () => redis.reset(),
  }
})

/** Ids 1…count, the size and shape of a real card document. */
function manyGames(count: number): IndexedGame[] {
  return Array.from({ length: count }, (_unused, position) => {
    const id = position + 1
    return {
      id,
      slug: `a-reasonably-long-game-slug-number-${id}`,
      name: `A Reasonably Long Game Title Number ${id}`,
      cover: `https://media.rawg.io/media/games/${id % 97}/${id}-cover-image.jpg`,
      released: '2020-06-01',
      popularity: count - position,
      platforms: [4, 18, 7, id % 11],
      genres: ['action', 'adventure', `genre-${id % 20}`],
      stores: ['steam', 'gog', 'epic-games'],
      gameModes: ['SINGLE'],
      ageRating: 'PEGI16',
      rating: (id % 50) / 10,
      ratingsCount: id,
      metacritic: 50 + (id % 50),
      playtime: 20,
      priceUah: id % 3 === 0 ? null : id,
      regularPriceUah: id % 3 === 0 ? null : id * 2,
      discountPercent: id % 3 === 0 ? 0 : 50,
      free: false,
      localisation: { text: true, audio: id % 5 === 0, source: 'steam' },
      madeInUkraine: false,
      priceUpdatedAt: '2026-09-20T06:00:00.000Z',
    } satisfies IndexedGame
  })
}

const WRITE_COMMANDS = [
  'set',
  'setNx',
  'mset',
  'del',
  'incr',
  'expire',
  'sadd',
  'srem',
  'zadd',
  'hset',
]

const commandsSince = (redis: FakeRedis, from: number): string[] =>
  redis.requests.slice(from).flatMap((request) => request.commands)

describe('upstashIndex', () => {
  describe('what a read costs', () => {
    it('answers a page with a cold cache in two requests: the sets, then the documents', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      const before = redis.roundTrips
      const result = await index.search({ genres: ['indie', 'strategy'], metacriticMin: 10 })
      expect(result.ids.length).toBeGreaterThan(0)
      expect(result.games).toHaveLength(result.ids.length)
      expect(redis.roundTrips - before).toBe(2)
    })

    it('answers a searching page in two as well: the names travel with the sets', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      const before = redis.roundTrips
      expect((await index.search({ search: 'kite' })).ids).toEqual([35])
      expect(redis.roundTrips - before).toBe(2)
    })

    it('answers a warm page in one request, and asks for nothing when the page is empty', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      await index.search({ genres: ['indie'] })
      const before = redis.roundTrips
      expect((await index.search({ genres: ['indie'] })).ids).toEqual([2, 3, 5])
      expect(redis.roundTrips - before).toBe(1)

      await index.search({ genres: ['nothing-carries-this'] })
      const warm = redis.roundTrips
      expect((await index.search({ genres: ['nothing-carries-this'] })).total).toBe(0)
      expect(redis.roundTrips - warm).toBe(0)
    })

    it('adds one request when the pointer is due to be checked again', async () => {
      let clock = 1_000
      const { redis, index } = makeAdapter({ now: () => clock })
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      await index.search({ genres: ['indie'] })

      const warm = redis.roundTrips
      await index.search({ genres: ['indie'] })
      expect(redis.roundTrips - warm).toBe(1)

      clock += 60_001
      const due = redis.roundTrips
      await index.search({ genres: ['indie'] })
      expect(redis.roundTrips - due).toBe(2)
    })

    it('pays one request more on an instance that has never read the pointer', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      const cold = createUpstashIndex(redis)
      const before = redis.roundTrips
      await cold.search({})
      expect(redis.roundTrips - before).toBe(3)
    })

    it('reads nothing but the pointer when no version is published', async () => {
      const { redis, index } = makeAdapter()
      const before = redis.roundTrips
      expect(await index.search({})).toEqual({ ids: [], total: 0, games: [] })
      expect(redis.roundTrips - before).toBe(1)
    })

    it('issues no write command on any read, whatever the query asks for', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      const before = redis.roundTrips
      for (const query of [
        {},
        { genres: ['indie', 'strategy'] },
        { priceMaxUah: 300, onSaleMinPercent: 50, sort: 'DISCOUNT_DESC' as const },
        { search: 'ar', page: 2, pageSize: 2 },
        { ukrainianLocalisation: 'AUDIO' as const, yearFrom: 2015, yearTo: 2026 },
      ]) {
        await index.search(query)
      }
      await index.getOne(3)
      await index.getMany([1, 2, 3])
      await index.meta()

      const used = [...new Set(commandsSince(redis, before))]
      expect(used.length).toBeGreaterThan(4)
      for (const write of WRITE_COMMANDS) expect(used).not.toContain(write)
      const reads = ['get', 'hgetall', 'mget', 'smembers', 'sunion', 'zrangeAll', 'zrangebyscore']
      for (const command of used) expect(reads).toContain(command)
    })
  })

  describe('what a read remembers', () => {
    it('keeps a version’s sets until the pointer moves', async () => {
      const { redis, index } = makeAdapter()
      const adapter = adapterFor(index, redis)
      await publishGames(adapter, FIXTURE_GAMES)
      await index.search({ genres: ['indie'] })
      expect(index.cached().entries).toBeGreaterThan(0)
      expect(index.cached().version).toBe(await index.currentVersion())

      await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
      await index.search({})
      // The sets of the version that was replaced are gone, not merely unused.
      expect(index.cached().version).toBe(await index.currentVersion())
      expect(index.cached().entries).toBe(1)
    })

    it('answers from the cache without asking the store again', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      const first = await index.search({ ukrainianLocalisation: 'ANY', page: 1, pageSize: 2 })
      const before = redis.roundTrips
      const second = await index.search({ ukrainianLocalisation: 'ANY', page: 1, pageSize: 2 })
      expect(second).toEqual(first)
      // Only the documents of the page are fetched again.
      expect(redis.roundTrips - before).toBe(1)
    })

    it('keeps no more sets than it is allowed to', async () => {
      const redis = createFakeRedis()
      const index = createUpstashIndex(redis, { cacheEntries: 3 })
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      for (const genre of ['indie', 'strategy', 'racing', 'action', 'shooter']) {
        await index.search({ genres: [genre] })
      }
      expect(index.cached().entries).toBeLessThanOrEqual(3)
    })

    it('keeps no more than its byte budget', async () => {
      const redis = createFakeRedis()
      const index = createUpstashIndex(redis, { cacheBytes: 600 })
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES)
      for (const genre of ['indie', 'strategy', 'racing', 'action']) {
        await index.search({ genres: [genre] })
      }
      expect(index.cached().bytes).toBeLessThanOrEqual(600)
    })
  })

  describe('writing a version', () => {
    it('keeps every request under both the command and the byte budget', async () => {
      const games = manyGames(3_000)
      const documentBytes =
        games.reduce((total, game) => total + JSON.stringify(game).length, 0) / games.length
      // The cap is only worth testing against documents the size of the real ones.
      expect(documentBytes).toBeGreaterThan(300)

      const bodies: number[] = []
      const counts: number[] = []
      const send: SendCommands = async (_path, commands) => {
        bodies.push(JSON.stringify(commands).length)
        counts.push(commands.length)
        return commands.map((command) => {
          if (command[0] === 'INCR') return { result: 1 }
          if (command[0] === 'SMEMBERS') {
            return { result: command[1] === 'idx:versions' ? ['1'] : [] }
          }
          if (command[0] === 'GET') return { result: null }
          return { result: 'OK' }
        })
      }
      const index = createUpstashIndex(createRedisCommands(send), { runId: 'the-run' })

      const version = await index.beginVersion()
      bodies.length = 0
      counts.length = 0
      await index.writeVersion(version, games)

      expect(bodies.length).toBeGreaterThan(2)
      for (const bytes of bodies) expect(bytes).toBeLessThanOrEqual(700_000)
      for (const count of counts) expect(count).toBeLessThanOrEqual(500)
      // The documents go out in bulk, never one SET per game.
      expect(bodies.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(1_000_000)
    })

    it('cuts a request at the byte budget long before the command budget', async () => {
      const bodies: number[] = []
      const send: SendCommands = async (_path, commands) => {
        bodies.push(JSON.stringify(commands).length)
        return commands.map((command) => {
          if (command[0] === 'INCR') return { result: 1 }
          if (command[0] === 'SMEMBERS') {
            return { result: command[1] === 'idx:versions' ? ['1'] : [] }
          }
          if (command[0] === 'GET') return { result: null }
          return { result: 'OK' }
        })
      }
      const index = createUpstashIndex(createRedisCommands(send), {
        runId: 'the-run',
        maxBytesPerRequest: 20_000,
        itemsPerCommand: 20,
      })
      const version = await index.beginVersion()
      bodies.length = 0
      await index.writeVersion(version, manyGames(300))
      expect(bodies.length).toBeGreaterThan(5)
      for (const bytes of bodies) expect(bytes).toBeLessThanOrEqual(20_000)
    })

    it('scores every set with a safe integer', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), manyGames(500))
      for (const key of redis.keys()) {
        if (!key.includes(':o:') && !key.includes(':r:')) continue
        for (const [, score] of redis.scores(key)) expect(Number.isSafeInteger(score)).toBe(true)
      }
    })

    it('rewrites a version cleanly, leaving nothing of the first attempt', async () => {
      const { redis, index } = makeAdapter()
      const version = await index.beginVersion()
      await index.writeVersion(version, FIXTURE_GAMES)
      const after = redis.keys().length
      await index.writeVersion(version, FIXTURE_GAMES.slice(0, 3))
      expect(redis.keys().length).toBeLessThan(after)
      const settled = redis.keys().sort()
      await index.writeVersion(version, FIXTURE_GAMES.slice(0, 3))
      expect(redis.keys().sort()).toEqual(settled)

      await index.publish(version, { ...FIXTURE_META, version, gameCount: 3 })
      expect((await index.search({})).ids).toEqual([1, 2, 3])
      expect(await index.getOne(4)).toBeNull()
      expect(redis.keys()).not.toContain(`${versionPrefix(version)}game:4`)
    })

    it('discards a version by its registry, leaving no key behind', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES.slice(0, 3))
      const version = await index.beginVersion()
      await index.writeVersion(version, FIXTURE_GAMES)
      expect(redis.keys().some((key) => key.startsWith(versionPrefix(version)))).toBe(true)
      await index.discardVersion(version)
      expect(redis.keys().filter((key) => key.startsWith(versionPrefix(version)))).toEqual([])
    })
  })

  describe('publishing', () => {
    it('moves the pointer in a transaction that carries nothing else', async () => {
      const { redis, index } = makeAdapter()
      const adapter = adapterFor(index, redis)
      await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
      await publishGames(adapter, FIXTURE_GAMES.slice(3, 6))

      const transaction = redis.requests.filter((request) => request.multi).at(-1)!
      // The metadata, the pointer, the predecessor and the lock: no expiry rides along, so the
      // transaction does not grow with the catalog.
      expect(transaction.commands).toEqual(['hset', 'set', 'set', 'del'])
    })

    it('expires the replaced version after the pointer has moved', async () => {
      const { redis, index } = makeAdapter()
      const adapter = adapterFor(index, redis)
      const first = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
      const firstKeys = redis.keys().filter((key) => key.startsWith(versionPrefix(first)))
      expect(firstKeys.length).toBeGreaterThan(3)
      const second = await publishGames(adapter, FIXTURE_GAMES.slice(3, 6))

      for (const key of firstKeys) expect(redis.ttl(key)).toBe(48 * 60 * 60 * 1000)
      for (const key of redis.keys().filter((key) => key.startsWith(versionPrefix(second)))) {
        expect(redis.ttl(key)).toBeNull()
      }
      expect(redis.ttl(CURRENT_VERSION_KEY)).toBeNull()

      redis.advance(48 * 60 * 60 * 1000 + 1)
      expect(redis.keys().filter((key) => key.startsWith(versionPrefix(first)))).toEqual([])
      expect((await index.search({})).ids).toEqual([4, 5, 6])
    })

    it('sweeps a version an interrupted run abandoned', async () => {
      const { redis, index } = makeAdapter()
      const adapter = adapterFor(index, redis)
      await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))

      // A run that wrote a version and then died: it is neither published nor discarded.
      const abandoned = await index.beginVersion()
      await index.writeVersion(abandoned, FIXTURE_GAMES.slice(6, 9))
      const abandonedKeys = redis.keys().filter((key) => key.startsWith(versionPrefix(abandoned)))
      expect(abandonedKeys.length).toBeGreaterThan(3)
      for (const key of abandonedKeys) expect(redis.ttl(key)).toBeNull()

      await publishGames(adapter, FIXTURE_GAMES.slice(3, 6))
      for (const key of abandonedKeys) expect(redis.ttl(key)).toBe(48 * 60 * 60 * 1000)
      redis.advance(48 * 60 * 60 * 1000 + 1)
      expect(redis.keys().filter((key) => key.startsWith(versionPrefix(abandoned)))).toEqual([])
    })

    it('keeps the replaced version readable until its expiry passes', async () => {
      const { redis, index } = makeAdapter()
      const adapter = adapterFor(index, redis)
      const first = await publishGames(adapter, FIXTURE_GAMES.slice(0, 3))
      await publishGames(adapter, FIXTURE_GAMES.slice(3, 6))
      expect((await index.previousMeta())?.version).toBe(first)
      redis.advance(47 * 60 * 60 * 1000)
      expect((await index.previousMeta())?.version).toBe(first)
    })

    it('stores the run metadata as a hash and reads it back whole', async () => {
      const { index } = makeAdapter()
      const version = await index.beginVersion()
      await index.writeVersion(version, FIXTURE_GAMES.slice(0, 2))
      await index.publish(version, {
        version,
        updatedAt: '2026-09-20T06:30:00.000Z',
        pricesUpdatedAt: null,
        gameCount: 2,
        stats: { gamesIndexed: 2, failures: 1 },
      })
      expect(await index.meta()).toEqual({
        version,
        updatedAt: '2026-09-20T06:30:00.000Z',
        pricesUpdatedAt: null,
        gameCount: 2,
        stats: { gamesIndexed: 2, failures: 1 },
      })
    })
  })

  describe('the write lock', () => {
    it('frees the lock of a run that died holding it, once its life has passed', async () => {
      const redis = createFakeRedis()
      const first = createUpstashIndex(redis, { runId: 'the-run', lockTtlSeconds: 3_600 })
      const second = createUpstashIndex(redis, { runId: 'another-run' })
      await first.beginVersion()
      await expect(second.beginVersion()).rejects.toThrow(/another-run|the-run/)
      redis.advance(3_600_000 + 1)
      await expect(second.beginVersion()).resolves.toBeGreaterThan(0)
    })
  })

  describe('an isolated key namespace', () => {
    it('keeps a prefixed adapter out of the index another one published', async () => {
      const { redis, index } = makeAdapter()
      await publishGames(adapterFor(index, redis), FIXTURE_GAMES.slice(0, 3))
      const site = redis.keys().sort()

      const smoke = createUpstashIndex(redis, { keyPrefix: 'smoke:1700000000:' })
      expect(await smoke.currentVersion()).toBeNull()
      await publishGames(adapterFor(smoke, redis), FIXTURE_GAMES)
      await smoke.search({ genres: ['indie', 'strategy'], priceMaxUah: 1000 })

      expect(await smoke.currentVersion()).toBe(1)
      for (const key of redis.keys().filter((key) => !site.includes(key))) {
        expect(key.startsWith('smoke:1700000000:')).toBe(true)
      }
      expect(
        redis
          .keys()
          .filter((key) => !key.startsWith('smoke:'))
          .sort(),
      ).toEqual(site)
      expect((await index.search({})).ids).toEqual([1, 2, 3])
    })
  })
})
