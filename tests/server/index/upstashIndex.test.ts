import { describe, expect, it } from 'vitest'
import type { IndexedGame } from '../../../server/index/document'
import { CURRENT_VERSION_KEY, versionPrefix } from '../../../server/index/keys'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import { describeGameIndexContract, FIXTURE_META, publishGames } from './contract'
import type { FakeRedis } from './fakeRedis'
import { createFakeRedis } from './fakeRedis'

/**
 * The adapter against the fake store. The shared contract suite is the bulk of it — the rules an
 * adapter owes its callers are written once and run here too — and the cases below are the ones
 * only this adapter can fail: what a read costs, what it leaves behind, how a large version is
 * chunked, and what a publication does to the version it replaces.
 */

function makeAdapter(): {
  redis: FakeRedis
  index: ReturnType<typeof createUpstashIndex>
} {
  const redis = createFakeRedis()
  return { redis, index: createUpstashIndex(redis) }
}

describeGameIndexContract('upstashIndex', () => {
  const redis = createFakeRedis()
  const adapter = createUpstashIndex(redis)
  return { index: adapter, writer: adapter, teardown: () => redis.reset() }
})

/** Ids 1…count, enough of a game to be indexed, with values that differ between them. */
function manyGames(count: number): IndexedGame[] {
  return Array.from({ length: count }, (_unused, position) => {
    const id = position + 1
    return {
      id,
      slug: `game-${id}`,
      name: `Game ${id}`,
      cover: null,
      released: '2020-06-01',
      popularity: count - position,
      platforms: [4, id % 7],
      genres: [`genre-${id % 20}`],
      stores: ['steam'],
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
      localisation: null,
      madeInUkraine: false,
      priceUpdatedAt: '2026-09-20T06:00:00.000Z',
    } satisfies IndexedGame
  })
}

const tempKeysOf = (redis: FakeRedis): string[] =>
  redis.keys().filter((key) => key.startsWith('idx:tmp:'))

describe('upstashIndex', () => {
  describe('what a read costs', () => {
    it('answers a page in two round trips: the query, then the documents', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      const before = redis.roundTrips
      const result = await index.search({ genres: ['indie'], sort: 'RATING_DESC' })
      expect(result.games).toHaveLength(result.ids.length)
      expect(redis.roundTrips - before).toBe(2)
    })

    it('answers a searching page in three: the names, the query, then the documents', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      const before = redis.roundTrips
      expect((await index.search({ search: 'kite' })).ids).toEqual([35])
      expect(redis.roundTrips - before).toBe(3)
    })

    it('spends no round trip on the documents when a page is empty', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      const before = redis.roundTrips
      expect((await index.search({ genres: ['nothing-carries-this'] })).total).toBe(0)
      expect(redis.roundTrips - before).toBe(1)
    })

    it('resolves the published version once and then trusts it for sixty seconds', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      const cold = createUpstashIndex(redis)
      const before = redis.roundTrips
      await cold.search({})
      // A pointer it has never read costs one extra round trip.
      expect(redis.roundTrips - before).toBe(3)
      const warm = redis.roundTrips
      await cold.search({})
      expect(redis.roundTrips - warm).toBe(2)
    })

    it('reads nothing but the pointer when no version is published', async () => {
      const { redis, index } = makeAdapter()
      const before = redis.roundTrips
      expect(await index.search({})).toEqual({ ids: [], total: 0, games: [] })
      expect(redis.roundTrips - before).toBe(1)
    })
  })

  describe('the keys a read borrows', () => {
    it('gives every temporary key a sixty second life', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      await index.search({ genres: ['indie', 'strategy'], priceMaxUah: 1000, metacriticMin: 10 })
      const temporary = tempKeysOf(redis)
      expect(temporary.length).toBeGreaterThan(2)
      for (const key of temporary) expect(redis.ttl(key)).toBe(60_000)
      redis.advance(60_001)
      expect(tempKeysOf(redis)).toEqual([])
    })

    it('never lets two reads share a temporary key', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      await index.search({ genres: ['indie', 'strategy'] })
      const first = tempKeysOf(redis)
      await index.search({ genres: ['indie', 'strategy'] })
      const second = tempKeysOf(redis).filter((key) => !first.includes(key))
      expect(first.length).toBeGreaterThan(0)
      expect(second).toHaveLength(first.length)
      const other = createUpstashIndex(redis)
      await other.search({ genres: ['indie', 'strategy'] })
      const third = tempKeysOf(redis).filter((key) => !first.includes(key) && !second.includes(key))
      expect(third).toHaveLength(first.length)
    })

    it('touches no key of another version while it reads', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES)
      await index.search({ free: true })
      for (const key of tempKeysOf(redis)) expect(key).not.toContain(versionPrefix(1))
    })
  })

  describe('writing a version', () => {
    it('chunks three thousand games into requests of at most five hundred commands', async () => {
      const { redis, index } = makeAdapter()
      const version = await index.beginVersion()
      const before = redis.roundTrips
      await index.writeVersion(version, manyGames(3_000))
      expect(redis.roundTrips - before).toBeGreaterThan(1)
      for (const request of redis.requests.slice(before)) {
        expect(request.commands.length).toBeLessThanOrEqual(500)
      }
      // The documents go out in bulk, never one SET per game.
      const written = redis.requests.slice(before).flatMap((request) => request.commands)
      expect(written).toContain('mset')
      expect(written).not.toContain('set')
      await index.publish(version, { ...FIXTURE_META, version, gameCount: 3_000 })
      const page = await index.search({ sort: 'PRICE_ASC', pageSize: 3 })
      expect(page.total).toBe(2_000)
      expect(page.ids).toEqual([1, 2, 4])
    })

    it('scores every set with a safe integer', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, manyGames(500))
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
      // Writing the same games again must leave the same store behind.
      const settled = redis.keys().sort()
      await index.writeVersion(version, FIXTURE_GAMES.slice(0, 3))
      expect(redis.keys().sort()).toEqual(settled)

      await index.publish(version, { ...FIXTURE_META, version, gameCount: 3 })
      expect((await index.search({})).ids).toEqual([1, 2, 3])
      expect(await index.getOne(4)).toBeNull()
      expect(redis.keys()).not.toContain(`${versionPrefix(version)}game:4`)
    })

    it('discards a version by its registry, leaving no key behind and scanning nothing', async () => {
      const { redis, index } = makeAdapter()
      await publishGames({ index, writer: index }, FIXTURE_GAMES.slice(0, 3))
      const version = await index.beginVersion()
      await index.writeVersion(version, FIXTURE_GAMES)
      expect(redis.keys().some((key) => key.startsWith(versionPrefix(version)))).toBe(true)
      await index.discardVersion(version)
      expect(redis.keys().filter((key) => key.startsWith(versionPrefix(version)))).toEqual([])
      expect(redis.requests.flatMap((request) => request.commands)).not.toContain('scan')
    })
  })

  describe('publishing', () => {
    it('moves the pointer and expires the replaced version in one transaction', async () => {
      const { redis, index } = makeAdapter()
      const first = await publishGames({ index, writer: index }, FIXTURE_GAMES.slice(0, 3))
      const firstKeys = redis.keys().filter((key) => key.startsWith(versionPrefix(first)))
      const second = await publishGames({ index, writer: index }, FIXTURE_GAMES.slice(3, 6))

      const transaction = redis.requests.at(-1)!
      expect(transaction.multi).toBe(true)
      expect(transaction.commands).toContain('set')
      expect(transaction.commands).toContain('expire')

      for (const key of firstKeys) expect(redis.ttl(key)).toBe(48 * 60 * 60 * 1000)
      for (const key of redis.keys().filter((key) => key.startsWith(versionPrefix(second)))) {
        expect(redis.ttl(key)).toBeNull()
      }
      expect(redis.ttl(CURRENT_VERSION_KEY)).toBeNull()

      redis.advance(48 * 60 * 60 * 1000 + 1)
      expect(redis.keys().filter((key) => key.startsWith(versionPrefix(first)))).toEqual([])
      expect((await index.search({})).ids).toEqual([4, 5, 6])
    })

    it('keeps the replaced version readable until its expiry passes', async () => {
      const { redis, index } = makeAdapter()
      const first = await publishGames({ index, writer: index }, FIXTURE_GAMES.slice(0, 3))
      await publishGames({ index, writer: index }, FIXTURE_GAMES.slice(3, 6))
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
})
