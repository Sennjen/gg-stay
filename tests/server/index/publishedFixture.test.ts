import { describe, expect, it } from 'vitest'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import {
  DEV_FIXTURE_GAMES,
  DEV_FIXTURE_SHELF_GAMES,
  DEV_FIXTURE_UKRAINIAN_GAMES,
} from '../../fixtures/index/devGames'
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
    expect(fixture.games).toEqual([
      ...DEV_FIXTURE_GAMES,
      ...DEV_FIXTURE_UKRAINIAN_GAMES,
      ...DEV_FIXTURE_SHELF_GAMES,
    ])
    expect(fixture.meta.gameCount).toBe(fixture.games.length)
  })

  it('holds at least five games made in Ukraine, so the shelf and the filter have something', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })

    const madeInUkraine = await index.search({ madeInUkraine: true })
    expect(madeInUkraine.total).toBeGreaterThanOrEqual(5)
    expect(madeInUkraine.ids).toEqual(DEV_FIXTURE_UKRAINIAN_GAMES.map((game) => game.id))
  })

  /**
   * A landing shelf, and the similar-games row, is not shown with fewer than four games. The seed
   * has to reach four on every index shelf and for The Witcher 3's similar games, or fixture mode
   * — the dev server, CI's SSR suite, a reviewer's browser — could never render them.
   */
  it('fills every index shelf and The Witcher 3 similar games with at least four games', async () => {
    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })

    const slugs = async (query: Parameters<typeof index.search>[0]) =>
      (await index.search(query)).games.map((game) => game.slug)
    expect(await slugs({ ukrainianLocalisation: 'ANY' })).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'half-life-2',
      'cyberpunk-2077',
    ])
    expect(await slugs({ onSaleMinPercent: 30 })).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
      'the-witcher-2-assassins-of-kings-enhanced-edition',
      'metro-exodus',
    ])
    const similar = (await slugs({ genres: ['action', 'role-playing-games-rpg'] })).filter(
      (slug) => slug !== 'the-witcher-3-wild-hunt',
    )
    expect(similar.length).toBeGreaterThanOrEqual(4)
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
    // Cheapest first: the free game, The Witcher 2 on sale, the two 225 ₴ games (the more popular
    // first), then the dearer ones up to Cyberpunk 2077 at 1 399 ₴.
    expect((await index.search({ sort: 'PRICE_ASC' })).ids).toEqual([
      654, 16944, 4200, 13537, 3328, 28201, 447825, 41494,
    ])
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
  })

  /**
   * The seed has to be able to answer the design's own acceptance URL with something, or the
   * "every card is under the ceiling AND over the discount floor" half of it is never exercised.
   * Portal 2 (225 ₴ at −75 %) and The Witcher 2 (59 ₴ at −85 %) are those games, both on PC, so
   * the discount order between them is observable too.
   */
  it('holds two games that are both cheap and heavily discounted, on PC', () => {
    const cheapAndDiscounted = fixture.games.filter(
      (game) =>
        game.priceUah !== null &&
        game.priceUah > 0 &&
        game.priceUah <= 300 &&
        game.discountPercent !== null &&
        game.discountPercent >= 50 &&
        game.platforms.includes(4),
    )
    expect(cheapAndDiscounted.map((game) => game.slug)).toEqual([
      'portal-2',
      'the-witcher-2-assassins-of-kings-enhanced-edition',
    ])
  })

  it('has no two games sharing a discount, so a discount order is never a tie-break', async () => {
    const discounts = fixture.games
      .map((game) => game.discountPercent)
      .filter((percent): percent is number => typeof percent === 'number' && percent > 0)
    expect(new Set(discounts).size).toBe(discounts.length)

    const index = createMemoryGameIndex()
    const version = await index.beginVersion()
    await index.writeVersion(version, fixture.games)
    await index.publish(version, { ...fixture.meta, version })
    // The Witcher 2 at −85 %, Portal 2 at −75 %, The Witcher 3 at −50 % and Metro Exodus at
    // −40 %, then the undiscounted priced games at zero — the free one among them — by popularity.
    expect((await index.search({ sort: 'DISCOUNT_DESC' })).ids).toEqual([
      16944, 4200, 3328, 28201, 13537, 41494, 654, 447825,
    ])
    expect((await index.search({ priceMaxUah: 300, onSaleMinPercent: 50 })).ids).toEqual([
      4200, 16944,
    ])
  })

  it('strikes a real pre-discount price through, rather than the same number twice', () => {
    for (const game of fixture.games) {
      if ((game.discountPercent ?? 0) > 0) {
        expect(game.regularPriceUah).toBeGreaterThan(game.priceUah!)
      }
    }
  })
})
