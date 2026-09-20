import { describe, expect, it } from 'vitest'
import { createFakeRedis } from './fakeRedis'

/**
 * The fake stands in for Upstash in every adapter test, so the rules the adapter leans on have to
 * be the store's real rules — the inclusive edges of a score range, a union that is returned and
 * not stored, a key disappearing when its TTL passes, a batch that runs every command and undoes
 * none of them, and a read-only token that refuses a write. A fake that is merely convenient would
 * make the adapter's tests prove nothing.
 */

describe('fakeRedis', () => {
  it('answers a queued read only once its batch has been executed', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.set('a', '1')
    const value = batch.get('a')
    expect(() => value.value).toThrow()
    await batch.exec()
    expect(value.value).toBe('1')
  })

  it('counts one round trip per executed batch', async () => {
    const redis = createFakeRedis()
    const first = redis.pipeline()
    first.set('a', '1')
    first.set('b', '2')
    await first.exec()
    const second = redis.pipeline()
    second.get('a')
    await second.exec()
    expect(redis.roundTrips).toBe(2)
    expect(redis.requests[0]?.commands).toHaveLength(2)
  })

  it('refuses to execute a batch twice', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.set('a', '1')
    await batch.exec()
    await expect(batch.exec()).rejects.toThrow()
  })

  it('reads and writes strings in bulk, reporting a missing key as null', async () => {
    const redis = createFakeRedis()
    const write = redis.pipeline()
    write.mset({ a: '1', b: '2' })
    await write.exec()
    const read = redis.pipeline()
    const values = read.mget(['a', 'missing', 'b'])
    await read.exec()
    expect(values.value).toEqual(['1', null, '2'])
  })

  it('deletes keys and increments a counter', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.set('a', '1')
    batch.del(['a'])
    const first = batch.incr('seq')
    const second = batch.incr('seq')
    const gone = batch.get('a')
    await batch.exec()
    expect([first.value, second.value]).toEqual([1, 2])
    expect(gone.value).toBeNull()
  })

  it('takes a key only when nobody holds it, and lets it go when its life passes', async () => {
    const redis = createFakeRedis()
    const first = redis.pipeline()
    const mine = first.setNx('lock', 'me', 60)
    const theirs = first.setNx('lock', 'you', 60)
    const holder = first.get('lock')
    await first.exec()
    expect([mine.value, theirs.value, holder.value]).toEqual([true, false, 'me'])

    redis.advance(60_001)
    const later = redis.pipeline()
    const taken = later.setNx('lock', 'you', 60)
    await later.exec()
    expect(taken.value).toBe(true)
  })

  it('adds to a set, reads it back and removes from it', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.sadd('one', ['1', '2', '3'])
    batch.srem('one', ['2'])
    const members = batch.smembers('one')
    batch.srem('one', ['1', '3'])
    const emptied = batch.smembers('one')
    await batch.exec()
    expect([...members.value].sort()).toEqual(['1', '3'])
    expect(emptied.value).toEqual([])
    expect(redis.keys()).not.toContain('one')
  })

  it('unions sets without storing anything', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.sadd('one', ['1', '2'])
    batch.sadd('two', ['2', '3'])
    const union = batch.sunion(['one', 'two', 'nothing'])
    await batch.exec()
    expect([...union.value].sort()).toEqual(['1', '2', '3'])
    expect(redis.keys().sort()).toEqual(['one', 'two'])
  })

  it('reads a sorted set by rank, lowest score first, ties by member', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [
      [2, '30'],
      [1, '20'],
      [1, '10'],
    ])
    const page = batch.zrangeAll('order')
    const absent = batch.zrangeAll('nothing')
    await batch.exec()
    expect(page.value).toEqual(['10', '20', '30'])
    expect(absent.value).toEqual([])
  })

  it('overwrites the score of a member that is added twice', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [[5, 'a']])
    batch.zadd('order', [[1, 'a']])
    const page = batch.zrangeAll('order')
    await batch.exec()
    expect(page.value).toEqual(['a'])
    expect(redis.scores('order')).toEqual([['a', 1]])
  })

  it('reads a score range, keeping both bounds and reading the infinities', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('range', [
      [10, 'a'],
      [20, 'b'],
      [30, 'c'],
    ])
    const inclusive = batch.zrangebyscore('range', '20', '30')
    const open = batch.zrangebyscore('range', '-inf', '+inf')
    const exclusive = batch.zrangebyscore('range', '(10', '(30')
    const none = batch.zrangebyscore('range', '40', '+inf')
    await batch.exec()
    expect(inclusive.value).toEqual(['b', 'c'])
    expect(open.value).toEqual(['a', 'b', 'c'])
    expect(exclusive.value).toEqual(['b'])
    expect(none.value).toEqual([])
    // A range is read, never trimmed: the source is untouched.
    expect(redis.scores('range')).toHaveLength(3)
  })

  it('forgets a key once its expiry passes on the fake clock', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.set('temp', '1')
    batch.expire('temp', 60)
    await batch.exec()
    redis.advance(59_000)
    expect(redis.keys()).toContain('temp')
    redis.advance(1_001)
    expect(redis.keys()).not.toContain('temp')
    const read = redis.pipeline()
    const gone = read.get('temp')
    await read.exec()
    expect(gone.value).toBeNull()
  })

  it('ignores an expiry on a key that does not exist', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.expire('nothing', 60)
    await batch.exec()
    expect(redis.ttl('nothing')).toBeNull()
  })

  it('reads and writes hash fields', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.hset('names', { '1': 'alpha' })
    batch.hset('names', { '2': 'beta' })
    const fields = batch.hgetall('names')
    const absent = batch.hgetall('nothing')
    await batch.exec()
    expect(fields.value).toEqual({ '1': 'alpha', '2': 'beta' })
    expect(absent.value).toEqual({})
  })

  it('runs every command of a batch and undoes none of them, as Redis does', async () => {
    const redis = createFakeRedis()
    const seed = redis.pipeline()
    seed.set('before', '1')
    seed.sadd('a-set', ['x'])
    await seed.exec()

    const batch = redis.pipeline()
    batch.set('written-before', 'yes')
    batch.incr('a-set') // WRONGTYPE: a set is not a counter
    batch.set('written-after', 'yes')
    await expect(batch.exec()).rejects.toThrow(/WRONGTYPE/)

    // Redis has no rollback: what ran, ran — before and after the command that failed.
    expect(redis.keys().sort()).toEqual(['a-set', 'before', 'written-after', 'written-before'])
    expect(redis.requests.at(-1)?.failed).toEqual([1])
  })

  it('does not roll a transaction back either, and says which command failed', async () => {
    const redis = createFakeRedis()
    const seed = redis.pipeline()
    seed.sadd('a-set', ['x'])
    await seed.exec()

    const batch = redis.multi()
    batch.set('kept', 'yes')
    batch.incr('a-set')
    await expect(batch.exec()).rejects.toThrow(/Command 2 \[ incr \]/)
    expect(redis.keys()).toContain('kept')
    expect(redis.requests.at(-1)?.multi).toBe(true)
  })

  it('refuses a command against a key of the wrong type', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.sadd('set', ['a'])
    batch.zrangeAll('set')
    await expect(batch.exec()).rejects.toThrow(/WRONGTYPE/)
  })

  describe('through a read-only token', () => {
    it('refuses every write command the way Upstash refuses it', async () => {
      const redis = createFakeRedis()
      const readOnly = redis.readOnly()
      const writes: [string, (batch: ReturnType<typeof readOnly.pipeline>) => void][] = [
        ['set', (batch) => batch.set('a', '1')],
        ['setNx', (batch) => void batch.setNx('a', '1', 60)],
        ['mset', (batch) => batch.mset({ a: '1' })],
        ['del', (batch) => batch.del(['a'])],
        ['incr', (batch) => void batch.incr('a')],
        ['expire', (batch) => batch.expire('a', 60)],
        ['sadd', (batch) => batch.sadd('a', ['1'])],
        ['srem', (batch) => batch.srem('a', ['1'])],
        ['zadd', (batch) => batch.zadd('a', [[1, 'x']])],
        ['hset', (batch) => batch.hset('a', { one: '1' })],
      ]
      for (const [name, queue] of writes) {
        const batch = readOnly.pipeline()
        queue(batch)
        await expect(batch.exec(), name).rejects.toThrow(/NOPERM/)
      }
      expect(redis.keys()).toEqual([])
    })

    it('answers every read command exactly as the full token does', async () => {
      const redis = createFakeRedis()
      const seed = redis.pipeline()
      seed.mset({ doc: '{"id":1}' })
      seed.sadd('facet', ['1', '2'])
      seed.sadd('other', ['3'])
      seed.zadd('order', [[0, '1']])
      seed.hset('names', { '1': 'alpha' })
      await seed.exec()

      const batch = redis.readOnly().pipeline()
      const document = batch.get('doc')
      const many = batch.mget(['doc'])
      const members = batch.smembers('facet')
      const union = batch.sunion(['facet', 'other'])
      const order = batch.zrangeAll('order')
      const range = batch.zrangebyscore('order', '-inf', '+inf')
      const names = batch.hgetall('names')
      await batch.exec()

      expect(document.value).toBe('{"id":1}')
      expect(many.value).toEqual(['{"id":1}'])
      expect([...members.value].sort()).toEqual(['1', '2'])
      expect([...union.value].sort()).toEqual(['1', '2', '3'])
      expect(order.value).toEqual(['1'])
      expect(range.value).toEqual(['1'])
      expect(names.value).toEqual({ '1': 'alpha' })
    })
  })
})
