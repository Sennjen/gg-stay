import { describe, expect, it } from 'vitest'
import type { CommandReply, SendCommands } from '../../../server/index/upstashIndex'
import { createRedisCommands, RedisBatchError } from '../../../server/index/upstashIndex'

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
    batch.setNx('lock', 'run-1', 3600)
    batch.mset({ one: 'a', two: 'b' })
    batch.del(['one', 'two'])
    batch.expire('key', 60)
    batch.sadd('facet', ['1', '2'])
    batch.srem('versions', ['7'])
    batch.smembers('facet')
    batch.sunion(['left', 'right'])
    batch.zadd('order', [
      [0, '1'],
      [1, '2'],
    ])
    batch.zrangeAll('order')
    batch.zrangebyscore('range', '-inf', '300')
    batch.hset('names', { '1': 'alpha' })
    await batch.exec()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('pipeline')
    expect(sent[0]?.commands).toEqual([
      ['SET', 'key', 'value'],
      ['SET', 'lock', 'run-1', 'NX', 'EX', 3600],
      ['MSET', 'one', 'a', 'two', 'b'],
      ['DEL', 'one', 'two'],
      ['EXPIRE', 'key', 60],
      ['SADD', 'facet', '1', '2'],
      ['SREM', 'versions', '7'],
      ['SMEMBERS', 'facet'],
      ['SUNION', 'left', 'right'],
      ['ZADD', 'order', 0, '1', 1, '2'],
      ['ZRANGE', 'order', 0, -1],
      ['ZRANGEBYSCORE', 'range', '-inf', '300'],
      ['HSET', 'names', '1', 'alpha'],
    ])
  })

  it('reads a lock as taken only when the store answers', async () => {
    const taken: SendCommands = async () => [{ result: 'OK' }]
    const refused: SendCommands = async () => [{ result: null }]
    const first = createRedisCommands(taken).pipeline()
    const mine = first.setNx('lock', 'run-1', 60)
    await first.exec()
    const second = createRedisCommands(refused).pipeline()
    const theirs = second.setNx('lock', 'run-1', 60)
    await second.exec()
    expect([mine.value, theirs.value]).toEqual([true, false])
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
    const ids = batch.zrangeAll('page')
    const documents = batch.mget(['a', 'b'])
    const members = batch.smembers('registry')
    const names = batch.hgetall('names')
    await batch.exec()

    expect(pointer.value).toBe('7')
    expect(sequence.value).toBe(4)
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
    batch.smembers('a')
    await expect(batch.exec()).rejects.toThrow(/Command 2 \[ SMEMBERS \] failed: WRONGTYPE/)
  })

  it('refuses a reply that is not a list of the right length', async () => {
    const notAList: SendCommands = async () => ({ result: 'OK' }) as unknown as CommandReply[]
    const short: SendCommands = async () => [{ result: 'OK' }]

    const first = createRedisCommands(notAList).pipeline()
    first.set('a', '1')
    await expect(first.exec()).rejects.toThrow(RedisBatchError)

    const second = createRedisCommands(short).pipeline()
    second.set('a', '1')
    const unanswered = second.get('b')
    await expect(second.exec()).rejects.toThrow(/2 commands/)
    // The failure is reported where it happened, not later as an unanswered command.
    expect(() => unanswered.value).toThrow()
  })

  it('names the failing command without naming the credentials', async () => {
    const send: SendCommands = async () => [{ error: 'NOPERM no permission' }]
    const batch = createRedisCommands(send).pipeline()
    batch.smembers('idx:v1:f:genre:indie')
    const failure = await batch.exec().catch((error: unknown) => error as RedisBatchError)
    expect(failure).toBeInstanceOf(RedisBatchError)
    expect((failure as RedisBatchError).command).toBe('SMEMBERS')
    expect((failure as RedisBatchError).commandIndex).toBe(0)
    expect((failure as RedisBatchError).message).not.toContain('token')
  })

  it('refuses to execute a batch twice', async () => {
    const { send } = recorder()
    const batch = createRedisCommands(send).pipeline()
    batch.set('a', '1')
    await batch.exec()
    await expect(batch.exec()).rejects.toThrow()
  })
})
