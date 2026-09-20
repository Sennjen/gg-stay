import { describe, expect, it } from 'vitest'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { FIXTURE_GAMES } from '../../fixtures/index/games'
import published from '../../fixtures/index/published.json' with { type: 'json' }

/**
 * `published.json` is the same version the contract suite uses, in the form a server asset can
 * serve: it is what `useGameIndex` seeds the in-memory adapter from when no Upstash credentials
 * are configured. The two are pinned to each other here, because a fixture that drifts from the
 * games the suite reasons about would make a development server disagree with every test.
 */

const fixture = published as unknown as { meta: IndexMeta; games: IndexedGame[] }

describe('the published index fixture', () => {
  it('holds exactly the games of the contract fixture', () => {
    expect(fixture.games).toEqual(FIXTURE_GAMES)
    expect(fixture.meta.gameCount).toBe(FIXTURE_GAMES.length)
  })

  it('publishes through the writer port as it stands', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })
    expect((await index.search({ ukrainianLocalisation: 'AUDIO' })).ids).toEqual([34, 35, 38])
    expect((await index.meta())?.gameCount).toBe(FIXTURE_GAMES.length)
  })
})
