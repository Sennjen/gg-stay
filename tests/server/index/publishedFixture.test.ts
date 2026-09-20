import { describe, expect, it } from 'vitest'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { DEV_FIXTURE_GAMES } from '../../fixtures/index/devGames'
import published from '../../fixtures/index/published.json' with { type: 'json' }

/**
 * `published.json` is the version a development server (and CI, and anything else without Upstash
 * credentials) seeds its in-memory index from. It holds exactly the games the RAWG fixtures show,
 * so fixture mode renders real prices, a discount, a free game and the localisation badge — the
 * states the interface has, and the states a reviewer has to be able to see.
 *
 * It is pinned to `devGames.ts` here, because a fixture that drifts from the module the tests
 * reason about would make a development server disagree with every test.
 */

const fixture = published as unknown as { meta: IndexMeta; games: IndexedGame[] }

describe('the published index fixture', () => {
  it('holds exactly the development games', () => {
    expect(fixture.games).toEqual(DEV_FIXTURE_GAMES)
    expect(fixture.meta.gameCount).toBe(DEV_FIXTURE_GAMES.length)
  })

  it('dates every price it knows, so a price is never served without its timestamp', () => {
    for (const game of fixture.games) {
      if (game.priceUah !== null) expect(game.priceUpdatedAt).not.toBeNull()
    }
  })

  it('publishes through the writer port as it stands', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })
    expect((await index.search({ ukrainianLocalisation: 'AUDIO' })).ids).toEqual([3328])
    expect((await index.search({ free: true })).ids).toEqual([654])
    expect((await index.search({ sort: 'PRICE_ASC' })).ids).toEqual([654, 4200, 3328])
    expect((await index.meta())?.gameCount).toBe(DEV_FIXTURE_GAMES.length)
  })
})
