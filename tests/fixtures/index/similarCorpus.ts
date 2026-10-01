import { indexTags } from '../../../scripts/index/candidates'
import type { IndexedGame } from '../../../server/index/document'
import type { RawgTag } from '../../../server/rawg/types'
import type { GameModeValue } from '../../../shared/catalog'

/**
 * A small index for the similar-games ranking: well-known games with the tags RAWG gives them,
 * their RAWG genres and roughly their RAWG popularity, in a crowd of generic games that makes the
 * common tags as common as they are in the real index. The popular all-rounders (GTA V, The Witcher
 * 3, Portal 2, CS:GO) are what a "same genre, most popular first" rule used to put under every
 * action game.
 *
 * The named games and the crowd reach the corpus through the job's own mapper (`indexTags`), from
 * RAWG-shaped tag lists: English tags with RAWG's catalog `games_count`, the store features and the
 * game modes RAWG adds to nearly every game, a rarer tag that defines a series
 * ("chernobyl", "sherlock-holmes"), and the long tail — a tag of the game's own that no other game
 * in the corpus carries, and one below the mapper's catalog floor.
 */

interface Named {
  id: number
  name: string
  popularity: number
  genres: string[]
  tags: string[]
  gameModes?: GameModeValue[]
}

/** Roughly RAWG's catalog `games_count` for the tags the corpus uses. */
const CATALOG_COUNTS: Record<string, number> = {
  singleplayer: 220_000,
  'steam-achievements': 40_000,
  'full-controller-support': 18_000,
  casual: 60_000,
  horror: 45_000,
  '2d': 45_000,
  atmospheric: 34_000,
  puzzle: 30_000,
  fantasy: 30_000,
  'first-person': 30_000,
  cute: 25_000,
  difficult: 25_000,
  rpg: 20_000,
  'story-rich': 20_000,
  exploration: 20_000,
  funny: 20_000,
  'sci-fi': 18_000,
  'pixel-graphics': 15_000,
  dark: 15_000,
  fps: 13_000,
  realistic: 12_000,
  retro: 12_000,
  relaxing: 12_000,
  'third-person': 11_000,
  'female-protagonist': 11_000,
  comedy: 10_000,
  'co-op': 10_000,
  violent: 9_000,
  pvp: 9_000,
  mystery: 9_000,
  'multiple-endings': 9_000,
  'survival-horror': 8_500,
  survival: 8_000,
  physics: 8_000,
  logic: 8_000,
  racing: 8_000,
  'open-world': 7_500,
  shooter: 7_000,
  sandbox: 7_000,
  gore: 7_000,
  magic: 7_000,
  mature: 6_000,
  zombies: 6_000,
  classic: 6_000,
  emotional: 6_000,
  platformer: 6_000,
  stealth: 5_000,
  medieval: 5_000,
  'psychological-horror': 5_000,
  'great-soundtrack': 4_600,
  'post-apocalyptic': 4_200,
  crafting: 4_000,
  'choices-matter': 4_000,
  war: 4_000,
  tactical: 3_500,
  nudity: 3_500,
  aliens: 3_500,
  historical: 3_500,
  isometric: 3_500,
  drama: 3_500,
  'interactive-fiction': 3_500,
  linear: 3_000,
  robots: 3_000,
  military: 3_000,
  'character-customization': 3_000,
  'dark-fantasy': 3_000,
  cinematic: 3_000,
  'life-sim': 3_000,
  detective: 2_600,
  competitive: 2_500,
  'fast-paced': 2_500,
  dystopian: 2_000,
  crime: 2_000,
  investigation: 1_500,
  'team-based': 1_500,
  'online-pvp': 1_500,
  farming: 1_500,
  lovecraftian: 1_300,
  demons: 1_200,
  dragons: 1_200,
  episodic: 1_000,
  police: 900,
  parkour: 800,
  'comic-book': 800,
  noir: 700,
  chernobyl: 700,
  'e-sports': 600,
  'time-manipulation': 400,
  'ray-tracing': 350,
  'sherlock-holmes': 350,
  fmv: 300,
  heist: 300,
  victorian: 250,
  reboot: 150,
}

/** What RAWG adds to nearly every game, and the mapper drops: game modes and store features. */
const RAWG_NOISE = ['singleplayer', 'steam-achievements', 'full-controller-support']

/**
 * The tags the job would store for a game RAWG lists with `tags`, plus a long-tail tag of its own
 * that no other game carries (`<key>-lore`, above the catalog floor) and one below the floor
 * (`<key>-trivia`). RAWG lists tags most common first.
 */
function mappedTags(tags: readonly string[], key: string): string[] {
  const counts: Record<string, number> = {
    ...CATALOG_COUNTS,
    [`${key}-lore`]: 450,
    [`${key}-trivia`]: 25,
  }
  const raw: RawgTag[] = [...RAWG_NOISE, ...tags, `${key}-lore`, `${key}-trivia`].map(
    (slug, id) => {
      const gamesCount = counts[slug]
      if (gamesCount === undefined) throw new Error(`no catalog count for the tag ${slug}`)
      return { id, slug, name: slug, language: 'eng', games_count: gamesCount }
    },
  )
  return indexTags(raw.sort((left, right) => right.games_count! - left.games_count!))
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
    tags: entry.tags,
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
export const FALLOUT_4 = 3439
export const DYING_LIGHT = 3636

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
      'chernobyl',
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
      'chernobyl',
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
    id: FALLOUT_4,
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
    id: DYING_LIGHT,
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
      'sherlock-holmes',
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
      'sherlock-holmes',
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
      'sherlock-holmes',
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
      tags: mappedTags(tags, `crowd-${n}`),
      gameModes: next() < 0.2 ? ['SINGLE', 'MULTIPLAYER'] : ['SINGLE'],
    })
  })
}

export const SIMILAR_CORPUS: IndexedGame[] = [
  ...NAMED.map((entry) => corpusGame({ ...entry, tags: mappedTags(entry.tags, `game-${entry.id}`) })),
  ...crowd(300),
]
