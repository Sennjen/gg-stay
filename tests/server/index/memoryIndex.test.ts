import { describe, expect, it } from 'vitest'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import { describeGameIndexContract, publishGames } from './contract'

describeGameIndexContract('memoryIndex', () => {
  const store = createMemoryGameIndex()
  return { index: store, writer: store, rival: store.connect('another-run') }
})

describe('memoryIndex', () => {
  it('drops the replaced version instead of keeping it in memory', async () => {
    const store = createMemoryGameIndex()
    const adapter = { index: store, writer: store, rival: store.connect('another-run') }
    const first = await publishGames(adapter, FIXTURE_GAMES.slice(0, 2))
    await publishGames(adapter, FIXTURE_GAMES.slice(2, 4))
    expect(store.retainedVersions()).toEqual([await store.currentVersion()])
    expect(store.retainedVersions()).not.toContain(first)
  })

  it('hands back copies, so a caller cannot edit the index in place', async () => {
    const store = createMemoryGameIndex()
    await publishGames(
      { index: store, writer: store, rival: store.connect('another-run') },
      FIXTURE_GAMES.slice(0, 2),
    )
    const game = await store.getOne(1)
    game!.name = 'edited'
    expect((await store.getOne(1))?.name).toBe('Alpha Quest')
  })
})
