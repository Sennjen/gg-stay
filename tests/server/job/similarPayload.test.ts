import { describe, expect, it } from 'vitest'
import { MAX_INDEXED_TAGS, toIndexedGame } from '../../../scripts/index/candidates'
import { attachSimilar } from '../../../scripts/index/similarity'
import type { IndexedGame } from '../../../server/index/document'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import type { RawgGameListItem, RawgTag } from '../../../server/rawg/types'
import { seeded } from '../../fixtures/index/similarCorpus'
import { createFakeRedis } from '../index/fakeRedis'

/**
 * What the tags and the similar-games lists cost the store. A full run rewrites every document,
 * and the free tier's storage and bandwidth are measured in what a run writes, so the two fields
 * together may add at most a quarter to a full run's written bytes (`stats().bytes`, the adapter's
 * own count) for an index of 3 500 games.
 *
 * The games are built the way the job builds them — RAWG list items through the one mapper, then
 * the similarity stage — with RAWG-like tag lists (thirty English tags, the store features among
 * them, drawn so that a few tags are on most games and most tags on a few), RAWG-sized ids, and
 * the price and language coverage the index has in production.
 */

const VOCABULARY = (
  'atmospheric great-soundtrack story-rich open-world first-person third-person sci-fi ' +
  'post-apocalyptic exploration fantasy 2d funny difficult co-op rpg horror sandbox ' +
  'female-protagonist pixel-graphics choices-matter character-customization shooter fps survival ' +
  'stealth crafting violent mature dark platformer physics puzzle detective investigation mystery ' +
  'crime noir historical victorian lovecraftian psychological-horror survival-horror zombies ' +
  'parkour gore military tactical war e-sports team-based competitive pvp roguelike roguelite ' +
  'metroidvania souls-like dark-fantasy magic medieval dragons multiple-endings cinematic ' +
  'emotional relaxing cute farming life-sim casual strategy turn-based real-time city-builder ' +
  'management racing driving sports football anime visual-novel dating-sim romance comedy ' +
  'cyberpunk steampunk space aliens robots dystopian time-manipulation episodic comic-book ' +
  'isometric top-down side-scroller hack-and-slash beat-em-up fighting rhythm music vr ' +
  'open-world-survival-craft base-building colony-sim deckbuilding card-game board-game trading ' +
  'hunting fishing western pirates ninja samurai mythology'
).split(' ')

const STORE_FEATURES = [
  'steam-achievements',
  'full-controller-support',
  'steam-cloud',
  'steam-trading-cards',
  'steam-leaderboards',
]

function rawgGames(count: number): RawgGameListItem[] {
  const next = seeded(3_500)
  return Array.from({ length: count }, (_, n) => {
    const id = 1 + Math.floor(next() * 950_000) * 4 + (n % 4)
    const tags: RawgTag[] = STORE_FEATURES.map((slug, at) => ({
      id: at,
      slug,
      name: slug,
      language: 'eng',
      games_count: 90_000,
    }))
    const drawn = new Set<number>()
    while (drawn.size < 25) drawn.add(Math.floor(VOCABULARY.length * next() ** 1.7))
    for (const at of drawn) {
      tags.push({
        id: 1_000 + at,
        slug: VOCABULARY[at]!,
        name: VOCABULARY[at]!,
        language: 'eng',
        games_count: 60_000 - at * 400,
      })
    }
    return {
      id,
      slug: `a-game-with-a-typical-title-${n}`,
      name: `A Game With a Typical Title ${n}`,
      released: '2019-06-18',
      background_image: `https://media.rawg.io/media/games/${String(n).padStart(3, '0')}/0123456789abcdef0123456789abcdef.jpg`,
      short_screenshots: [
        {
          id: n,
          image: `https://media.rawg.io/media/screenshots/${String(n).padStart(3, '0')}/fedcba9876543210fedcba9876543210.jpg`,
        },
      ],
      rating: 3.9,
      ratings_count: 1_200,
      metacritic: 78,
      playtime: 12,
      added: Math.floor(next() * 20_000),
      platforms: [{ platform: { id: 4 } }, { platform: { id: 187 } }, { platform: { id: 7 } }],
      genres: [{ slug: 'action' }, { slug: 'adventure' }].slice(0, 1 + (n % 2)),
      tags,
      stores: [{ store: { id: 1 } }, { store: { id: 5 } }],
      esrb_rating: { slug: 'mature' },
    }
  })
}

/** Nine in ten priced, one in seven with Ukrainian text, as the published index has them. */
function asPublished(game: IndexedGame, n: number): IndexedGame {
  return {
    ...game,
    ...(n % 10 === 0
      ? {}
      : {
          priceUah: 599,
          regularPriceUah: 799,
          discountPercent: 25,
          priceUpdatedAt: '2026-09-30T03:00:00.000Z',
        }),
    localisation:
      n % 7 === 0
        ? { text: true, audio: false, source: 'steam', updatedAt: '2026-09-27T03:00:00.000Z' }
        : null,
  }
}

async function writtenBytes(games: IndexedGame[]): Promise<number> {
  const index = createUpstashIndex(createFakeRedis(), { runId: 'payload' })
  const version = await index.beginVersion()
  await index.writeVersion(version, games)
  await index.publish(version, {
    version,
    updatedAt: '2026-09-30T03:00:00.000Z',
    pricesUpdatedAt: '2026-09-30T03:00:00.000Z',
    gameCount: games.length,
  })
  return index.stats().bytes
}

describe('the similar-games payload', () => {
  it('adds at most a quarter to what a full run of 3 500 games writes', async () => {
    const games = rawgGames(3_500).map((raw, n) => asPublished(toIndexedGame(raw)!, n))
    attachSimilar(games)
    const without = games.map(({ tags: _tags, similar: _similar, ...rest }) => rest)

    expect(games.every((game) => game.tags!.length === MAX_INDEXED_TAGS)).toBe(true)
    expect(games.every((game) => game.similar!.length === 8)).toBe(true)

    const before = await writtenBytes(without)
    const after = await writtenBytes(games)
    expect((after - before) / before).toBeLessThan(0.25)
  })
})
