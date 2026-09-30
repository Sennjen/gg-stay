import { describe, expect, it } from 'vitest'
import {
  computeSimilar,
  editionKey,
  similarHealthWarning,
  SIMILAR_LIST_SIZE,
  similarityFeatures,
} from '../../../scripts/index/similarity'
import type { IndexedGame } from '../../../server/index/document'
import {
  corpusGame,
  CS_GO,
  DISCO_ELYSIUM,
  GTA_V,
  HER_STORY,
  LA_NOIRE,
  METRO_2033,
  METRO_EXODUS,
  METRO_EXODUS_ENHANCED,
  METRO_LAST_LIGHT,
  OBRA_DINN,
  PORTAL_2,
  seeded,
  SHERLOCK_CHAPTER_ONE,
  SHERLOCK_CRIMES,
  SHERLOCK_DAUGHTER,
  SIMILAR_CORPUS,
  SINKING_CITY,
  STALKER_COP,
  STALKER_SOC,
  WITCHER_3,
  WOLF_AMONG_US,
} from '../../fixtures/index/similarCorpus'

/**
 * The similar-games ranking the refresh job stores on every document. The quality cases run on a
 * corpus of well-known games in a crowd of generic ones (`tests/fixtures/index/similarCorpus.ts`);
 * the rules underneath them run on corpora small enough to read.
 */

/** Everything the ranking would list for `id`, not only the stored eight. */
function rankingOf(games: readonly IndexedGame[], id: number): number[] {
  return computeSimilar(games, { size: games.length }).get(id) ?? []
}

function positionOf(ranking: number[], id: number): number {
  const at = ranking.indexOf(id)
  return at === -1 ? Infinity : at
}

let nextId = 1
function game(overrides: Partial<IndexedGame> & { name?: string } = {}): IndexedGame {
  const id = overrides.id ?? nextId++
  return corpusGame({
    id,
    name: overrides.name ?? `Game ${id}`,
    popularity: overrides.popularity ?? 1_000,
    genres: overrides.genres ?? ['action'],
    tags: overrides.tags ?? [],
    gameModes: overrides.gameModes ?? ['SINGLE'],
  })
}

describe('computeSimilar on real-looking games', () => {
  it('ranks the Metro games and S.T.A.L.K.E.R. above GTA V and Portal 2 for Metro Exodus', () => {
    const ranking = rankingOf(SIMILAR_CORPUS, METRO_EXODUS)
    const hits = [GTA_V, PORTAL_2]
    for (const related of [METRO_2033, METRO_LAST_LIGHT, STALKER_SOC, STALKER_COP]) {
      for (const hit of hits) {
        expect(positionOf(ranking, related), `${related} above ${hit}`).toBeLessThan(
          positionOf(ranking, hit),
        )
      }
    }
    const stored = computeSimilar(SIMILAR_CORPUS).get(METRO_EXODUS)!
    expect(stored).toHaveLength(SIMILAR_LIST_SIZE)
    expect(stored).toEqual(
      expect.arrayContaining([METRO_2033, METRO_LAST_LIGHT, STALKER_SOC, STALKER_COP]),
    )
    for (const hit of [GTA_V, PORTAL_2, WITCHER_3, CS_GO]) expect(stored).not.toContain(hit)
  })

  it('keeps well-tagged related games whose other tags no game shares', () => {
    // RAWG gives a big game dozens of tags; some of them no other indexed game carries. They can
    // match nothing, and must not push the game out of every list by inflating its norm.
    const related = [METRO_2033, METRO_LAST_LIGHT, STALKER_SOC, STALKER_COP]
    const games = SIMILAR_CORPUS.map((entry) =>
      related.includes(entry.id)
        ? {
            ...entry,
            tags: [
              ...entry.tags!.slice(0, 6),
              ...Array.from({ length: 6 }, (_, n) => `only-${entry.id}-${n}`),
            ],
          }
        : entry,
    )
    expect(computeSimilar(games).get(METRO_EXODUS)).toEqual(expect.arrayContaining(related))
  })

  it('ranks the other detective games first for a Sherlock Holmes game', () => {
    const stored = computeSimilar(SIMILAR_CORPUS).get(SHERLOCK_CRIMES)!
    const detectives = [
      SHERLOCK_DAUGHTER,
      SHERLOCK_CHAPTER_ONE,
      SINKING_CITY,
      LA_NOIRE,
      OBRA_DINN,
      DISCO_ELYSIUM,
      HER_STORY,
      WOLF_AMONG_US,
    ]
    expect(stored.slice(0, 5).every((id) => detectives.includes(id))).toBe(true)
    expect(stored[0]).toBe(SHERLOCK_DAUGHTER)
    expect(stored).not.toContain(GTA_V)
  })

  it('never lists an edition of the game itself', () => {
    const similar = computeSimilar(SIMILAR_CORPUS)
    expect(similar.get(METRO_EXODUS)).not.toContain(METRO_EXODUS_ENHANCED)
    expect(similar.get(METRO_EXODUS_ENHANCED)).not.toContain(METRO_EXODUS)
  })

  it('stores a list for every game, of ids from the same corpus', () => {
    const similar = computeSimilar(SIMILAR_CORPUS)
    const ids = new Set(SIMILAR_CORPUS.map((entry) => entry.id))
    expect(similar.size).toBe(SIMILAR_CORPUS.length)
    for (const [id, list] of similar) {
      expect(list).not.toContain(id)
      expect(list.length).toBeLessThanOrEqual(SIMILAR_LIST_SIZE)
      expect(list.every((other) => ids.has(other))).toBe(true)
      expect(new Set(list).size).toBe(list.length)
    }
  })
})

describe('computeSimilar rules', () => {
  it('weighs a tag by how rare it is: common features barely count', () => {
    // Forty action games, every one singleplayer, and nothing post-apocalyptic among them.
    const crowd = Array.from({ length: 40 }, (_, n) =>
      game({ id: 100 + n, genres: ['action'], tags: [`crowd-${n}`] }),
    )
    const target = game({
      id: 1,
      genres: ['action'],
      tags: ['post-apocalyptic', 'survival-horror', 'unique-a'],
    })
    // Shares "singleplayer" and "action" only — and is by far the most popular.
    const common = game({ id: 2, popularity: 1_000_000, genres: ['action'], tags: ['unique-b'] })
    // Shares "post-apocalyptic" and "survival-horror" only: another genre, no game mode.
    const rare = game({
      id: 3,
      genres: ['adventure'],
      gameModes: [],
      tags: ['post-apocalyptic', 'survival-horror', 'unique-c'],
    })

    const ranking = rankingOf([target, common, rare, ...crowd], 1)
    expect(positionOf(ranking, 3)).toBeLessThan(positionOf(ranking, 2))
    expect(ranking[0]).toBe(3)
  })

  it('lists a game of another genre only when the tags make it close', () => {
    const target = game({ id: 1, genres: ['action'], tags: ['detective', 'noir', 'crime'] })
    const close = game({ id: 2, genres: ['adventure'], tags: ['detective', 'noir', 'crime'] })
    // Shares "crime" only; its other tags are the crowd's, so they count against it.
    const far = game({
      id: 3,
      genres: ['puzzle'],
      tags: ['crime', ...Array.from({ length: 8 }, (_, n) => `crowd-${n}`)],
    })
    const crowd = Array.from({ length: 20 }, (_, n) =>
      game({ id: 100 + n, genres: ['strategy'], tags: [`crowd-${n % 10}`] }),
    )

    const ranking = rankingOf([target, close, far, ...crowd], 1)
    expect(ranking).toContain(2)
    expect(ranking).not.toContain(3)
  })

  it('falls back to genre overlap, then popularity, for games without tags', () => {
    const games = [
      game({ id: 1, genres: ['action', 'shooter'] }),
      game({ id: 2, genres: ['action'], popularity: 50_000 }),
      game({ id: 3, genres: ['action', 'shooter'], popularity: 10 }),
      game({ id: 4, genres: ['shooter'], popularity: 20_000 }),
      game({ id: 5, genres: ['puzzle'], popularity: 90_000 }),
      ...Array.from({ length: 10 }, (_, n) => game({ id: 100 + n, genres: ['strategy'] })),
    ]

    const ranking = rankingOf(games, 1)
    expect(ranking[0]).toBe(3)
    expect(ranking.slice(1).sort()).toEqual([2, 4])
    expect(ranking).not.toContain(5)
  })

  it('orders equally similar games by popularity, then by id', () => {
    const games = [
      game({ id: 1, tags: ['a'] }),
      game({ id: 7, tags: ['a'], popularity: 500 }),
      game({ id: 5, tags: ['a'], popularity: 900 }),
      game({ id: 3, tags: ['a'], popularity: 900 }),
      ...Array.from({ length: 10 }, (_, n) => game({ id: 100 + n, genres: ['strategy'] })),
    ]
    expect(rankingOf(games, 1)).toEqual([3, 5, 7])
  })

  it('lets popularity break near-ties only, never lift an unrelated hit over a related game', () => {
    const crowd = Array.from({ length: 30 }, (_, n) =>
      game({ id: 100 + n, genres: ['action'], tags: [`crowd-${n}`, 'common'] }),
    )
    const target = game({ id: 1, tags: ['zombies', 'parkour', 'common'] })
    const related = game({ id: 2, popularity: 1, tags: ['zombies', 'common'] })
    const hit = game({ id: 3, popularity: 10_000_000, tags: ['common'] })

    const ranking = rankingOf([target, related, hit, ...crowd], 1)
    expect(ranking[0]).toBe(2)
  })

  it('lists one edition of another game, not two', () => {
    const games = [
      game({ id: 1, name: 'Metro Exodus', tags: ['post-apocalyptic'] }),
      game({ id: 2, name: 'Metro 2033', tags: ['post-apocalyptic'], popularity: 7_000 }),
      game({ id: 3, name: 'Metro 2033 Redux', tags: ['post-apocalyptic'], popularity: 5_000 }),
      game({ id: 4, name: 'Metro: Last Light', tags: ['post-apocalyptic'] }),
      ...Array.from({ length: 10 }, (_, n) => game({ id: 100 + n, genres: ['strategy'] })),
    ]
    expect(rankingOf(games, 1)).toEqual([2, 4])
  })

  it('is the same whatever order the games arrive in', () => {
    const shuffled = [...SIMILAR_CORPUS]
    const next = seeded(7)
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    expect(computeSimilar(shuffled)).toEqual(computeSimilar(SIMILAR_CORPUS))
  })

  it('gives a game with nothing in common with the rest an empty list', () => {
    const games = [game({ id: 1, genres: ['puzzle'], gameModes: [] }), game({ id: 2 })]
    expect(computeSimilar(games).get(1)).toEqual([])
    expect(computeSimilar([]).size).toBe(0)
  })

  it('ranks 3 500 games in a couple of seconds', () => {
    const next = seeded(3500)
    const genres = ['action', 'adventure', 'indie', 'role-playing-games-rpg', 'shooter', 'puzzle']
    const games = Array.from({ length: 3_500 }, (_, n) =>
      game({
        id: n + 1,
        popularity: Math.floor(next() * 20_000),
        genres: genres.filter(() => next() < 0.35),
        // A Zipf-like draw from 400 tags: a few on most games, most on a few.
        tags: Array.from({ length: 15 }, () => `tag-${Math.floor(400 * next() ** 2.5)}`),
        gameModes: next() < 0.9 ? ['SINGLE'] : ['MULTIPLAYER'],
      }),
    )

    const started = performance.now()
    const similar = computeSimilar(games)
    const elapsed = performance.now() - started

    expect(similar.size).toBe(3_500)
    expect(elapsed).toBeLessThan(3_000)
  })
})

describe('similarityFeatures', () => {
  it('are the tags, the genres and the game modes, each once', () => {
    expect(
      similarityFeatures(
        game({ genres: ['action'], tags: ['fps', 'fps'], gameModes: ['SINGLE', 'MULTIPLAYER'] }),
      ),
    ).toEqual(['genre:action', 'mode:MULTIPLAYER', 'mode:SINGLE', 'tag:fps'])
  })

  it('read a document published before tags existed', () => {
    const { tags: _tags, ...old } = game({ genres: ['action'] })
    expect(similarityFeatures(old)).toEqual(['genre:action', 'mode:SINGLE'])
  })
})

describe('editionKey', () => {
  it.each([
    ['Metro Exodus', 'Metro Exodus Enhanced Edition'],
    ['Metro 2033', 'Metro 2033 Redux'],
    ['Metro: Last Light', 'Metro: Last Light Redux'],
    ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt – Game of the Year Edition'],
    ['Batman: Arkham Asylum', 'Batman: Arkham Asylum GOTY'],
    ['Death Stranding', "Death Stranding Director's Cut"],
    ['Death Stranding', 'DEATH STRANDING DIRECTOR’S CUT'],
    ['BioShock', 'BioShock Remastered'],
    ['The Elder Scrolls V: Skyrim', 'The Elder Scrolls V: Skyrim Special Edition'],
    ['Mass Effect', 'Mass Effect Legendary Edition'],
    ['Divinity: Original Sin 2', 'Divinity: Original Sin 2 - Definitive Edition'],
  ])('reads %s and %s as one game', (left, right) => {
    expect(editionKey(left)).toBe(editionKey(right))
  })

  it.each([
    ['Metro 2033', 'Metro Exodus'],
    ['Portal', 'Portal 2'],
    ['S.T.A.L.K.E.R.: Shadow of Chernobyl', 'S.T.A.L.K.E.R.: Call of Pripyat'],
    ['Sherlock Holmes: Crimes and Punishments', "Sherlock Holmes: The Devil's Daughter"],
  ])('tells %s from %s', (left, right) => {
    expect(editionKey(left)).not.toBe(editionKey(right))
  })

  it('keeps a name that is nothing but an edition word', () => {
    expect(editionKey('Remastered')).toBe('remastered')
  })
})

describe('similarHealthWarning', () => {
  const tagged = (similar: number[]) => ({ ...game({ tags: ['a', 'b'] }), similar })
  const bare = (similar: number[]) => ({ ...game({ tags: [] }), similar })

  it('is quiet when most games have tags and a list', () => {
    expect(similarHealthWarning([tagged([1]), tagged([2]), bare([])])).toBeNull()
    expect(similarHealthWarning([])).toBeNull()
  })

  it('warns when the median game has no tag at all', () => {
    expect(similarHealthWarning([tagged([1]), bare([2]), bare([3])])).toBe(
      'Similar lists look empty — check RAWG tags: median 0 tags per game, 3 of 3 games have a list',
    )
  })

  it('warns when fewer than half the games have a list', () => {
    expect(similarHealthWarning([tagged([1]), tagged([]), tagged([])])).toBe(
      'Similar lists look empty — check RAWG tags: median 2 tags per game, 1 of 3 games have a list',
    )
    expect(similarHealthWarning([tagged([1]), tagged([])])).toBeNull()
  })

  it('counts a document without the fields as empty', () => {
    const { tags: _tags, ...old } = game()
    expect(similarHealthWarning([old, old])).toMatch(/median 0 tags per game, 0 of 2 games/)
  })
})
