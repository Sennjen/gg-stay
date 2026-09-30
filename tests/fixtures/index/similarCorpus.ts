import { MAX_INDEXED_TAGS } from '../../../scripts/index/candidates'
import type { IndexedGame } from '../../../server/index/document'
import type { GameModeValue } from '../../../shared/catalog'

/**
 * A small index for the similar-games ranking: well-known games with the English tags RAWG gives
 * them (after the refresh job's mapping — no store features, no game modes), their RAWG genres and
 * roughly their RAWG popularity, in a crowd of generic games that makes the common tags as common
 * as they are in the real index. The popular all-rounders (GTA V, The Witcher 3, Portal 2, CS:GO)
 * are what a "same genre, most popular first" rule used to put under every action game.
 */

interface Named {
  id: number
  name: string
  popularity: number
  genres: string[]
  tags: string[]
  gameModes?: GameModeValue[]
}

/**
 * The tags as the job's mapper would keep them: at most `MAX_INDEXED_TAGS`, the common ones dropped
 * first (RAWG's `games_count`, here the crowd's share), in the listed order.
 */
function keptTags(tags: string[]): string[] {
  if (tags.length <= MAX_INDEXED_TAGS) return tags
  const share = new Map(CROWD_TAGS)
  const kept = new Set(
    [...tags]
      .sort((left, right) => (share.get(left) ?? 0) - (share.get(right) ?? 0))
      .slice(0, MAX_INDEXED_TAGS),
  )
  return tags.filter((tag) => kept.has(tag))
}

export function corpusGame(entry: Named): IndexedGame {
  return {
    id: entry.id,
    slug: entry.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    name: entry.name,
    cover: null,
    preview: null,
    released: '2015-01-01',
    popularity: entry.popularity,
    platforms: [4],
    genres: entry.genres,
    tags: keptTags(entry.tags),
    stores: ['steam'],
    gameModes: entry.gameModes ?? ['SINGLE'],
    ageRating: null,
    rating: 4,
    ratingsCount: 1000,
    metacritic: 80,
    playtime: 20,
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: null,
  }
}

export const METRO_EXODUS = 58386
export const METRO_EXODUS_ENHANCED = 622492
export const METRO_2033 = 5563
export const METRO_LAST_LIGHT = 3070
export const STALKER_SOC = 5679
export const STALKER_COP = 4166
export const GTA_V = 3498
export const WITCHER_3 = 3328
export const PORTAL_2 = 4200
export const CS_GO = 4291
export const SHERLOCK_CRIMES = 4459
export const SHERLOCK_DAUGHTER = 10213
export const SHERLOCK_CHAPTER_ONE = 452634
export const SINKING_CITY = 29177
export const LA_NOIRE = 4062
export const OBRA_DINN = 22509
export const DISCO_ELYSIUM = 20633
export const HER_STORY = 11932
export const WOLF_AMONG_US = 3272

const NAMED: Named[] = [
  {
    id: METRO_EXODUS,
    name: 'Metro Exodus',
    popularity: 7_400,
    genres: ['action', 'shooter'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'story-rich',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'survival',
      'sci-fi',
      'stealth',
      'open-world',
      'exploration',
      'survival-horror',
      'crafting',
      'dark',
    ],
  },
  {
    id: METRO_EXODUS_ENHANCED,
    name: 'Metro Exodus Enhanced Edition',
    popularity: 900,
    genres: ['action', 'shooter'],
    tags: [
      'atmospheric',
      'story-rich',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'survival',
      'sci-fi',
      'stealth',
      'open-world',
      'survival-horror',
      'ray-tracing',
    ],
  },
  {
    id: METRO_2033,
    name: 'Metro 2033',
    popularity: 7_000,
    genres: ['action', 'shooter'],
    tags: [
      'atmospheric',
      'story-rich',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'survival',
      'sci-fi',
      'stealth',
      'survival-horror',
      'dark',
      'linear',
    ],
  },
  {
    id: METRO_LAST_LIGHT,
    name: 'Metro: Last Light Redux',
    popularity: 8_100,
    genres: ['action', 'shooter'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'story-rich',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'sci-fi',
      'stealth',
      'survival-horror',
      'dark',
      'linear',
    ],
  },
  {
    id: STALKER_SOC,
    name: 'S.T.A.L.K.E.R.: Shadow of Chernobyl',
    popularity: 5_200,
    genres: ['action', 'shooter', 'role-playing-games-rpg'],
    tags: [
      'atmospheric',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'survival',
      'open-world',
      'sci-fi',
      'rpg',
      'exploration',
      'sandbox',
      'stealth',
      'survival-horror',
      'dark',
      'difficult',
    ],
  },
  {
    id: STALKER_COP,
    name: 'S.T.A.L.K.E.R.: Call of Pripyat',
    popularity: 4_300,
    genres: ['action', 'shooter', 'role-playing-games-rpg'],
    tags: [
      'atmospheric',
      'first-person',
      'fps',
      'post-apocalyptic',
      'horror',
      'survival',
      'open-world',
      'sci-fi',
      'rpg',
      'exploration',
      'sandbox',
      'survival-horror',
      'difficult',
    ],
  },
  {
    id: 3439,
    name: 'Fallout 4',
    popularity: 13_100,
    genres: ['action', 'role-playing-games-rpg'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'story-rich',
      'open-world',
      'rpg',
      'post-apocalyptic',
      'first-person',
      'fps',
      'sci-fi',
      'exploration',
      'sandbox',
      'crafting',
      'character-customization',
      'third-person',
      'choices-matter',
    ],
  },
  {
    id: 3636,
    name: 'Dying Light',
    popularity: 10_300,
    genres: ['action'],
    tags: [
      'atmospheric',
      'open-world',
      'zombies',
      'survival',
      'horror',
      'first-person',
      'parkour',
      'post-apocalyptic',
      'co-op',
      'crafting',
      'survival-horror',
      'gore',
    ],
    gameModes: ['SINGLE', 'ONLINE_COOP'],
  },
  {
    id: GTA_V,
    name: 'Grand Theft Auto V',
    popularity: 21_000,
    genres: ['action', 'adventure'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'open-world',
      'third-person',
      'first-person',
      'sandbox',
      'funny',
      'crime',
      'shooter',
      'comedy',
      'mature',
      'racing',
      'heist',
      'violent',
      'realistic',
    ],
    gameModes: ['SINGLE', 'MULTIPLAYER'],
  },
  {
    id: WITCHER_3,
    name: 'The Witcher 3: Wild Hunt',
    popularity: 20_100,
    genres: ['action', 'adventure', 'role-playing-games-rpg'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'story-rich',
      'open-world',
      'rpg',
      'third-person',
      'fantasy',
      'choices-matter',
      'exploration',
      'dark-fantasy',
      'magic',
      'medieval',
      'mature',
      'nudity',
      'multiple-endings',
    ],
  },
  {
    id: PORTAL_2,
    name: 'Portal 2',
    popularity: 18_300,
    genres: ['shooter', 'puzzle'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'first-person',
      'puzzle',
      'sci-fi',
      'funny',
      'comedy',
      'co-op',
      'story-rich',
      'physics',
      'female-protagonist',
      'robots',
      'logic',
    ],
    gameModes: ['SINGLE', 'ONLINE_COOP', 'LOCAL_COOP'],
  },
  {
    id: CS_GO,
    name: 'Counter-Strike: Global Offensive',
    popularity: 16_400,
    genres: ['action', 'shooter'],
    tags: [
      'fps',
      'first-person',
      'competitive',
      'pvp',
      'e-sports',
      'tactical',
      'team-based',
      'military',
      'shooter',
      'realistic',
      'war',
      'online-pvp',
    ],
    gameModes: ['MULTIPLAYER'],
  },
  {
    id: 13537,
    name: 'Half-Life 2',
    popularity: 13_300,
    genres: ['action', 'shooter'],
    tags: [
      'atmospheric',
      'great-soundtrack',
      'first-person',
      'fps',
      'sci-fi',
      'story-rich',
      'physics',
      'classic',
      'shooter',
      'dystopian',
      'aliens',
      'linear',
    ],
  },
  {
    id: 2454,
    name: 'DOOM',
    popularity: 12_200,
    genres: ['action', 'shooter'],
    tags: [
      'fps',
      'first-person',
      'gore',
      'great-soundtrack',
      'sci-fi',
      'demons',
      'fast-paced',
      'horror',
      'violent',
      'shooter',
      'atmospheric',
      'classic',
    ],
  },
  {
    id: 12020,
    name: 'Left 4 Dead 2',
    popularity: 15_300,
    genres: ['action', 'shooter'],
    tags: [
      'zombies',
      'co-op',
      'fps',
      'first-person',
      'horror',
      'survival',
      'gore',
      'shooter',
      'team-based',
      'post-apocalyptic',
      'survival-horror',
      'atmospheric',
    ],
    gameModes: ['SINGLE', 'ONLINE_COOP', 'MULTIPLAYER'],
  },
  {
    id: 30000,
    name: 'The Elder Scrolls V: Skyrim',
    popularity: 15_600,
    genres: ['action', 'role-playing-games-rpg'],
    tags: [
      'open-world',
      'rpg',
      'fantasy',
      'atmospheric',
      'first-person',
      'third-person',
      'exploration',
      'magic',
      'dragons',
      'sandbox',
      'great-soundtrack',
      'character-customization',
      'medieval',
    ],
  },
  {
    id: 5286,
    name: 'Tomb Raider',
    popularity: 16_100,
    genres: ['action', 'adventure'],
    tags: [
      'third-person',
      'female-protagonist',
      'exploration',
      'survival',
      'story-rich',
      'atmospheric',
      'shooter',
      'puzzle',
      'reboot',
      'cinematic',
    ],
  },
  {
    id: 3876,
    name: 'Life is Strange',
    popularity: 14_100,
    genres: ['adventure'],
    tags: [
      'story-rich',
      'choices-matter',
      'female-protagonist',
      'episodic',
      'emotional',
      'great-soundtrack',
      'time-manipulation',
      'atmospheric',
      'mystery',
      'third-person',
      'drama',
    ],
  },
  {
    id: 10035,
    name: 'Stardew Valley',
    popularity: 10_900,
    genres: ['indie', 'role-playing-games-rpg', 'simulation'],
    tags: [
      'pixel-graphics',
      'farming',
      'relaxing',
      'cute',
      'crafting',
      '2d',
      'life-sim',
      'co-op',
      'great-soundtrack',
      'casual',
      'sandbox',
    ],
    gameModes: ['SINGLE', 'ONLINE_COOP'],
  },
  {
    id: SHERLOCK_CRIMES,
    name: 'Sherlock Holmes: Crimes and Punishments',
    popularity: 2_600,
    genres: ['adventure', 'puzzle'],
    tags: [
      'detective',
      'investigation',
      'mystery',
      'crime',
      'story-rich',
      'atmospheric',
      'third-person',
      'first-person',
      'puzzle',
      'choices-matter',
      'victorian',
      'historical',
    ],
  },
  {
    id: SHERLOCK_DAUGHTER,
    name: "Sherlock Holmes: The Devil's Daughter",
    popularity: 2_100,
    genres: ['adventure', 'puzzle'],
    tags: [
      'detective',
      'investigation',
      'mystery',
      'crime',
      'story-rich',
      'atmospheric',
      'third-person',
      'puzzle',
      'victorian',
      'choices-matter',
      'historical',
    ],
  },
  {
    id: SHERLOCK_CHAPTER_ONE,
    name: 'Sherlock Holmes Chapter One',
    popularity: 1_500,
    genres: ['adventure', 'action'],
    tags: [
      'detective',
      'investigation',
      'mystery',
      'open-world',
      'third-person',
      'story-rich',
      'crime',
      'choices-matter',
      'puzzle',
    ],
  },
  {
    id: SINKING_CITY,
    name: 'The Sinking City',
    popularity: 2_700,
    genres: ['adventure', 'action'],
    tags: [
      'detective',
      'investigation',
      'mystery',
      'lovecraftian',
      'horror',
      'open-world',
      'third-person',
      'atmospheric',
      'psychological-horror',
      'dark',
      'story-rich',
    ],
  },
  {
    id: LA_NOIRE,
    name: 'L.A. Noire',
    popularity: 7_300,
    genres: ['action', 'adventure'],
    tags: [
      'detective',
      'investigation',
      'crime',
      'noir',
      'open-world',
      'third-person',
      'story-rich',
      'atmospheric',
      'historical',
      'mystery',
      'police',
      'great-soundtrack',
    ],
  },
  {
    id: OBRA_DINN,
    name: 'Return of the Obra Dinn',
    popularity: 3_100,
    genres: ['indie', 'adventure', 'puzzle'],
    tags: [
      'mystery',
      'detective',
      'investigation',
      'first-person',
      'puzzle',
      'atmospheric',
      'retro',
      'great-soundtrack',
      'story-rich',
      'historical',
    ],
  },
  {
    id: DISCO_ELYSIUM,
    name: 'Disco Elysium',
    popularity: 5_300,
    genres: ['role-playing-games-rpg'],
    tags: [
      'detective',
      'story-rich',
      'rpg',
      'choices-matter',
      'great-soundtrack',
      'atmospheric',
      'isometric',
      'noir',
      'mystery',
      'crime',
      'multiple-endings',
    ],
  },
  {
    id: HER_STORY,
    name: 'Her Story',
    popularity: 1_600,
    genres: ['indie', 'adventure'],
    tags: [
      'detective',
      'mystery',
      'investigation',
      'crime',
      'fmv',
      'story-rich',
      'female-protagonist',
      'interactive-fiction',
    ],
  },
  {
    id: WOLF_AMONG_US,
    name: 'The Wolf Among Us',
    popularity: 6_200,
    genres: ['adventure'],
    tags: [
      'detective',
      'noir',
      'mystery',
      'choices-matter',
      'story-rich',
      'episodic',
      'comic-book',
      'fantasy',
      'crime',
      'third-person',
    ],
  },
]

/**
 * The common tags, weighted roughly by how often RAWG's 3 000 most popular games carry them: the
 * crowd draws from these, so "atmospheric" ends up on more than half of the corpus and
 * "post-apocalyptic" on a handful, as in the real index.
 */
const CROWD_TAGS: [tag: string, share: number][] = [
  ['atmospheric', 0.55],
  ['great-soundtrack', 0.45],
  ['story-rich', 0.35],
  ['first-person', 0.3],
  ['third-person', 0.3],
  ['open-world', 0.2],
  ['fantasy', 0.2],
  ['sci-fi', 0.18],
  ['exploration', 0.2],
  ['2d', 0.2],
  ['funny', 0.15],
  ['difficult', 0.15],
  ['co-op', 0.15],
  ['rpg', 0.15],
  ['shooter', 0.12],
  ['fps', 0.1],
  ['horror', 0.1],
  ['pixel-graphics', 0.12],
  ['female-protagonist', 0.1],
  ['sandbox', 0.1],
  ['puzzle', 0.12],
  ['choices-matter', 0.08],
  ['survival', 0.08],
  ['stealth', 0.05],
  ['crafting', 0.06],
  ['violent', 0.06],
  ['mature', 0.06],
  ['dark', 0.05],
  ['platformer', 0.08],
  ['physics', 0.05],
]

const CROWD_GENRES: [genre: string, share: number][] = [
  ['action', 0.45],
  ['adventure', 0.35],
  ['indie', 0.3],
  ['role-playing-games-rpg', 0.18],
  ['shooter', 0.14],
  ['puzzle', 0.08],
  ['strategy', 0.1],
  ['platformer', 0.08],
  ['simulation', 0.08],
  ['casual', 0.06],
]

/** A fixed pseudo-random sequence, so the crowd is the same crowd in every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

function crowd(count: number): IndexedGame[] {
  const next = seeded(20260930)
  return Array.from({ length: count }, (_, n) => {
    const genres = CROWD_GENRES.filter(([, share]) => next() < share).map(([genre]) => genre)
    const tags = CROWD_TAGS.filter(([, share]) => next() < share).map(([tag]) => tag)
    return corpusGame({
      id: 900_000 + n,
      name: `Crowd Game ${n}`,
      // Below every named game but a few, so the crowd never wins on popularity alone.
      popularity: 500 + Math.floor(next() * 3_000),
      genres: genres.length > 0 ? genres : ['action'],
      tags,
      gameModes: next() < 0.2 ? ['SINGLE', 'MULTIPLAYER'] : ['SINGLE'],
    })
  })
}

export const SIMILAR_CORPUS: IndexedGame[] = [...NAMED.map(corpusGame), ...crowd(300)]
