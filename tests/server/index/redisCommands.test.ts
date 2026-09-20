import { describe, expect, it } from 'vitest'
import { withKeyPrefix } from '../../../server/index/redisCommands'
import { createFakeRedis } from './fakeRedis'

/**
 * The prefix is what lets the live smoke test run the whole adapter against the real database
 * without coming near the index the site reads, so every command that names a key has to be
 * covered — one missed argument and the test would read or, worse, write outside its namespace.
 */

describe('withKeyPrefix', () => {
  it('returns the store itself when there is no prefix', () => {
    const redis = createFakeRedis()
    expect(withKeyPrefix(redis, '')).toBe(redis)
  })

  it('moves the key of every command that names one', async () => {
    const redis = createFakeRedis()
    const moved = withKeyPrefix(redis, 'smoke:')
    const batch = moved.pipeline()
    batch.set('string', 'a')
    batch.mset({ left: 'b', right: 'c' })
    batch.sadd('facet', ['1', '2'])
    batch.sadd('other', ['2', '3'])
    batch.sunionstore('union', ['facet', 'other'])
    batch.zadd('order', [
      [0, '1'],
      [1, '2'],
      [2, '3'],
    ])
    batch.zrangestore('trimmed', 'order', '1', '+inf')
    batch.zinterstore('page', ['trimmed', 'union'], [1, 0])
    batch.hset('names', { '1': 'alpha' })
    batch.expire('page', 60)
    batch.incr('counter')
    await batch.exec()

    expect(redis.keys().every((key) => key.startsWith('smoke:'))).toBe(true)
    expect(redis.keys().sort()).toEqual(
      [
        'smoke:string',
        'smoke:left',
        'smoke:right',
        'smoke:facet',
        'smoke:other',
        'smoke:union',
        'smoke:order',
        'smoke:trimmed',
        'smoke:page',
        'smoke:names',
        'smoke:counter',
      ].sort(),
    )
    expect(redis.ttl('smoke:page')).toBe(60_000)
    expect(redis.scores('smoke:page')).toEqual([
      ['2', 1],
      ['3', 2],
    ])
  })

  it('reads through the prefix and leaves the values alone', async () => {
    const redis = createFakeRedis()
    const moved = withKeyPrefix(redis, 'smoke:')
    const write = moved.pipeline()
    write.mset({ one: '1', two: '2' })
    write.hset('fields', { name: 'alpha' })
    write.sadd('members', ['x'])
    write.zadd('scores', [[7, 'x']])
    await write.exec()

    const read = moved.pipeline()
    const values = read.mget(['one', 'missing', 'two'])
    const single = read.get('one')
    const fields = read.hgetall('fields')
    const members = read.smembers('members')
    const total = read.zcard('scores')
    const page = read.zrange('scores', 0, 10)
    await read.exec()

    expect(values.value).toEqual(['1', null, '2'])
    expect(single.value).toBe('1')
    expect(fields.value).toEqual({ name: 'alpha' })
    expect(members.value).toEqual(['x'])
    expect(total.value).toBe(1)
    expect(page.value).toEqual(['x'])
  })

  it('deletes through the prefix and keeps the transaction a transaction', async () => {
    const redis = createFakeRedis()
    const moved = withKeyPrefix(redis, 'smoke:')
    const write = moved.multi()
    write.set('gone', 'a')
    write.set('kept', 'b')
    await write.exec()
    expect(redis.requests.at(-1)?.multi).toBe(true)

    const remove = moved.pipeline()
    remove.del(['gone'])
    await remove.exec()
    expect(redis.keys()).toEqual(['smoke:kept'])
  })
})
