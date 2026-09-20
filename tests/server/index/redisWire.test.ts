import { describe, expect, it } from 'vitest'
import type { CommandReply, SendCommands } from '../../../server/index/upstashIndex'
import { createRedisCommands } from '../../../server/index/upstashIndex'

/**
 * What a batch looks like on the wire. The fake store proves the adapter's reasoning; this proves
 * the sentences it says to a real Redis — the option order of a ZINTERSTORE, the BYSCORE of a
 * ZRANGESTORE, the rank bounds of a ZRANGE — and that each answer comes back to the command that
 * asked for it. The transport underneath is stubbed: no request leaves the process.
 */

function recorder(replies: Record<string, unknown> = {}): {
  send: SendCommands
  sent: { path: string; commands: (string | number)[][] }[]
} {
  const sent: { path: string; commands: (string | number)[][] }[] = []
  const send: SendCommands = async (path, commands) => {
    sent.push({ path, commands })
    return commands.map((command): CommandReply => ({
      result: replies[String(command[0])] ?? null,
    }))
  }
  return { send, sent }
}

describe('the Redis wire format', () => {
  it('writes each command as Redis spells it', async () => {
    const { send, sent } = recorder()
    const batch = createRedisCommands(send).pipeline()
    batch.set('key', 'value')
    batch.mset({ one: 'a', two: 'b' })
    batch.del(['one', 'two'])
    batch.expire('key', 60)
    batch.sadd('facet', ['1', '2'])
    batch.sunionstore('union', ['left', 'right'])
    batch.zadd('order', [
      [0, '1'],
      [1, '2'],
    ])
    batch.zrangestore('trimmed', 'range', '-inf', '300')
    batch.zinterstore('page', ['order', 'union'], [1, 0])
    batch.hset('names', { '1': 'alpha' })
    await batch.exec()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('pipeline')
    expect(sent[0]?.commands).toEqual([
      ['SET', 'key', 'value'],
      ['MSET', 'one', 'a', 'two', 'b'],
      ['DEL', 'one', 'two'],
      ['EXPIRE', 'key', 60],
      ['SADD', 'facet', '1', '2'],
      ['SUNIONSTORE', 'union', 'left', 'right'],
      ['ZADD', 'order', 0, '1', 1, '2'],
      ['ZRANGESTORE', 'trimmed', 'range', '-inf', '300', 'BYSCORE'],
      ['ZINTERSTORE', 'page', 2, 'order', 'union', 'WEIGHTS', 1, 0, 'AGGREGATE', 'SUM'],
      ['HSET', 'names', '1', 'alpha'],
    ])
  })

  it('asks for a page by the ranks it covers', async () => {
    const { send, sent } = recorder()
    const batch = createRedisCommands(send).pipeline()
    batch.zrange('page', 40, 20)
    batch.zrange('page', 0, 1)
    await batch.exec()
    expect(sent[0]?.commands).toEqual([
      ['ZRANGE', 'page', 40, 59],
      ['ZRANGE', 'page', 0, 0],
    ])
  })

  it('sends a transaction to the transaction endpoint', async () => {
    const { send, sent } = recorder()
    const batch = createRedisCommands(send).multi()
    batch.set('idx:current', '8')
    await batch.exec()
    expect(sent[0]?.path).toBe('multi-exec')
  })

  it('sends nothing when nothing was queued', async () => {
    const { send, sent } = recorder()
    await createRedisCommands(send).pipeline().exec()
    expect(sent).toEqual([])
  })

  it('gives each answer to the command that asked for it', async () => {
    const send: SendCommands = async (_path, commands) =>
      commands.map((command): CommandReply => {
        switch (command[0]) {
          case 'GET':
            return { result: '7' }
          case 'INCR':
            return { result: 4 }
          case 'ZCARD':
            return { result: 3 }
          case 'ZRANGE':
            return { result: ['10', '20'] }
          case 'MGET':
            return { result: ['{"id":10}', null] }
          case 'SMEMBERS':
            return { result: ['a', 'b'] }
          // The REST API answers HGETALL with a flat field/value list.
          case 'HGETALL':
            return { result: ['1', 'alpha', '2', 'beta'] }
          default:
            return { result: 'OK' }
        }
      })

    const batch = createRedisCommands(send).pipeline()
    const pointer = batch.get('idx:current')
    const sequence = batch.incr('idx:sequence')
    const total = batch.zcard('page')
    const ids = batch.zrange('page', 0, 10)
    const documents = batch.mget(['a', 'b'])
    const members = batch.smembers('registry')
    const names = batch.hgetall('names')
    await batch.exec()

    expect(pointer.value).toBe('7')
    expect(sequence.value).toBe(4)
    expect(total.value).toBe(3)
    expect(ids.value).toEqual(['10', '20'])
    expect(documents.value).toEqual(['{"id":10}', null])
    expect(members.value).toEqual(['a', 'b'])
    expect(names.value).toEqual({ '1': 'alpha', '2': 'beta' })
  })

  it('reads a missing key as null and an absent hash as no fields', async () => {
    const send: SendCommands = async (_path, commands) => commands.map(() => ({ result: null }))
    const batch = createRedisCommands(send).pipeline()
    const missing = batch.get('nothing')
    const empty = batch.hgetall('nothing')
    const none = batch.smembers('nothing')
    await batch.exec()
    expect(missing.value).toBeNull()
    expect(empty.value).toEqual({})
    expect(none.value).toEqual([])
  })

  it('throws when any command of the batch failed', async () => {
    const send: SendCommands = async () => [{ result: 'OK' }, { error: 'WRONGTYPE nope' }]
    const batch = createRedisCommands(send).pipeline()
    batch.set('a', '1')
    batch.zcard('a')
    await expect(batch.exec()).rejects.toThrow(/WRONGTYPE/)
  })

  it('refuses to execute a batch twice', async () => {
    const { send } = recorder()
    const batch = createRedisCommands(send).pipeline()
    batch.set('a', '1')
    await batch.exec()
    await expect(batch.exec()).rejects.toThrow()
  })
})
