import { describe, expect, it } from 'vitest'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import { describeGameIndexContract, publishGames } from './contract'

describeGameIndexContract('memoryIndex', () => {
  const store = createMemoryGameIndex()
  return { index: store, writer: store }
})

describe('memoryIndex', () => {
  it('refuses to publish a version that was never written', async () => {
    const store = createMemoryGameIndex()
    await expect(
      store.publish(7, {
        version: 7,
        updatedAt: '2026-09-20T06:30:00.000Z',
        pricesUpdatedAt: null,
        gameCount: 0,
      }),
    ).rejects.toThrow(/version/i)
  })

  it('accepts games in several calls before the version is published', async () => {
    const store = createMemoryGameIndex()
    const version = await store.beginVersion()
    await store.putGames(version, FIXTURE_GAMES.slice(0, 2))
    await store.putGames(version, FIXTURE_GAMES.slice(2, 4))
    await store.publish(version, {
      version,
      updatedAt: '2026-09-20T06:30:00.000Z',
      pricesUpdatedAt: null,
      gameCount: 4,
    })
    expect((await store.search({})).ids).toEqual([1, 2, 3, 4])
  })

  it('numbers versions upwards from the published one', async () => {
    const store = createMemoryGameIndex()
    expect(await store.beginVersion()).toBe(1)
    await publishGames({ index: store, writer: store }, FIXTURE_GAMES.slice(0, 1))
    expect(await store.beginVersion()).toBe(3)
  })
})
