import { describe, expect, it } from 'vitest'
import { createFakeRedis } from './fakeRedis'

/**
 * The fake stands in for Upstash in every adapter test, so the rules the adapter leans on have to
 * be the store's real rules — the weights of an intersection, the inclusive edges of a score
 * range, a set counting as score 1, a key disappearing when its TTL passes, a MULTI applying whole
 * or not at all. A fake that is merely convenient would make the adapter's tests prove nothing.
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

  it('unions plain sets into a destination and drops an empty destination', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.sadd('one', ['1', '2'])
    batch.sadd('two', ['2', '3'])
    batch.sunionstore('dest', ['one', 'two'])
    const members = batch.smembers('dest')
    batch.sunionstore('dest', ['nothing'])
    const emptied = batch.smembers('dest')
    await batch.exec()
    expect([...members.value].sort()).toEqual(['1', '2', '3'])
    expect(emptied.value).toEqual([])
    expect(redis.keys()).not.toContain('dest')
  })

  it('reads a sorted set by rank, lowest score first, ties by member', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [
      [2, '30'],
      [1, '20'],
      [1, '10'],
    ])
    const total = batch.zcard('order')
    const page = batch.zrange('order', 0, 10)
    const second = batch.zrange('order', 1, 1)
    const past = batch.zrange('order', 99, 10)
    await batch.exec()
    expect(total.value).toBe(3)
    expect(page.value).toEqual(['10', '20', '30'])
    expect(second.value).toEqual(['20'])
    expect(past.value).toEqual([])
  })

  it('overwrites the score of a member that is added twice', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [[5, 'a']])
    batch.zadd('order', [[1, 'a']])
    const page = batch.zrange('order', 0, 10)
    const total = batch.zcard('order')
    await batch.exec()
    expect(page.value).toEqual(['a'])
    expect(total.value).toBe(1)
  })

  it('intersects with weights, a plain set counting as score 1', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ])
    batch.sadd('facet', ['b', 'c'])
    batch.zinterstore('dest', ['order', 'facet'], [1, 0])
    const page = batch.zrange('dest', 0, 10)
    batch.zinterstore('dest2', ['order', 'facet'], [1, 10])
    await batch.exec()
    expect(page.value).toEqual(['b', 'c'])
    expect(redis.scores('dest')).toEqual([
      ['b', 1],
      ['c', 2],
    ])
    // Both members gain 10 from the facet, so their order is unchanged but their scores are not.
    expect(redis.scores('dest2')).toEqual([
      ['b', 11],
      ['c', 12],
    ])
  })

  it('intersects to nothing when one of the keys does not exist', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('order', [[0, 'a']])
    batch.zinterstore('dest', ['order', 'absent'], [1, 0])
    const total = batch.zcard('dest')
    await batch.exec()
    expect(total.value).toBe(0)
    expect(redis.keys()).not.toContain('dest')
  })

  it('stores a score range with its scores, keeping both bounds', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('range', [
      [10, 'a'],
      [20, 'b'],
      [30, 'c'],
    ])
    batch.zrangestore('kept', 'range', '20', '30')
    batch.zrangestore('open', 'range', '-inf', '+inf')
    batch.zrangestore('exclusive', 'range', '(10', '(30')
    const page = batch.zrange('kept', 0, 10)
    await batch.exec()
    expect(page.value).toEqual(['b', 'c'])
    expect(redis.scores('kept')).toEqual([
      ['b', 20],
      ['c', 30],
    ])
    expect(redis.scores('open')).toHaveLength(3)
    expect(redis.scores('exclusive').map(([member]) => member)).toEqual(['b'])
    // The source is left as it was: a trim is a copy, not a destructive edit.
    expect(redis.scores('range')).toHaveLength(3)
  })

  it('writes no destination when a range matches nothing', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.zadd('range', [[10, 'a']])
    batch.zrangestore('empty', 'range', '20', '+inf')
    batch.zrangestore('absent', 'nothing', '-inf', '+inf')
    await batch.exec()
    expect(redis.keys()).not.toContain('empty')
    expect(redis.keys()).not.toContain('absent')
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

  it('applies a multi whole or not at all', async () => {
    const redis = createFakeRedis()
    const seed = redis.pipeline()
    seed.set('kept', 'before')
    await seed.exec()

    const batch = redis.multi()
    batch.set('kept', 'after')
    batch.sadd('wrong', ['x'])
    batch.incr('wrong')
    await expect(batch.exec()).rejects.toThrow()

    const read = redis.pipeline()
    const kept = read.get('kept')
    await read.exec()
    expect(kept.value).toBe('before')
    expect(redis.keys()).not.toContain('wrong')
    expect(redis.requests.at(-2)?.multi).toBe(true)
  })

  it('refuses a command against a key of the wrong type', async () => {
    const redis = createFakeRedis()
    const batch = redis.pipeline()
    batch.sadd('set', ['a'])
    batch.zcard('set')
    await expect(batch.exec()).rejects.toThrow(/WRONGTYPE/)
  })
})
