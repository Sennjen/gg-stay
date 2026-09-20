import type { RawgGameListItem, RawgList, RawgStoreLink } from '../../../server/rawg/types'

/**
 * A miniature RAWG catalog and the Steam answers that go with it, hand-written for the refresh
 * job's tests. Nine games over three pages, each one there to discriminate a rule of the job:
 *
 * | id  | what it proves                                                             |
 * | --- | -------------------------------------------------------------------------- |
 * | 101 | the ordinary case: a Steam page, a discounted price, Ukrainian text и audio |
 * | 102 | Ukrainian text without audio                                               |
 * | 103 | no store links at all — never asked for an app id                          |
 * | 104 | store links without a Steam one — the empty-string "has none" marker        |
 * | 105 | a free game: `data: []` under `filters=price_overview`, `is_free` per app   |
 * | 106 | Ukrainian audio on a game whose name is not the first in the language list  |
 * | 107 | a game Steam refuses to price in the region (`success: false`)              |
 * | 108 | a second priced game, so a halved run is still above the blue/green floor   |
 * | 109 | a non-Steam store only (Nintendo) — priced by nobody                        |
 *
 * The payload shapes follow the recorded RAWG and Steam fixtures next to this file.
 */

const PC = { platform: { id: 4, slug: 'pc', name: 'PC' } }
const PS5 = { platform: { id: 187, slug: 'playstation5', name: 'PlayStation 5' } }
const SWITCH = { platform: { id: 7, slug: 'nintendo-switch', name: 'Nintendo Switch' } }

const STEAM = { store: { id: 1, slug: 'steam', name: 'Steam' } }
const GOG = { store: { id: 5, slug: 'gog', name: 'GOG' } }
const EPIC = { store: { id: 11, slug: 'epic-games', name: 'Epic Games' } }
const NINTENDO = { store: { id: 6, slug: 'nintendo', name: 'Nintendo eShop' } }

const SINGLEPLAYER = { id: 31, slug: 'singleplayer', name: 'Singleplayer' }
const MULTIPLAYER = { id: 7, slug: 'multiplayer', name: 'Multiplayer' }
const ONLINE_COOP = { id: 9, slug: 'online-co-op', name: 'Online Co-Op' }

const ACTION = { id: 4, slug: 'action', name: 'Action' }
const INDIE = { id: 51, slug: 'indie', name: 'Indie' }
const STRATEGY = { id: 10, slug: 'strategy', name: 'Strategy' }

export const JOB_GAMES: RawgGameListItem[] = [
  {
    id: 101,
    slug: 'hollow-cradle',
    name: 'Hollow Cradle',
    released: '2021-03-11',
    background_image: 'https://media.rawg.io/media/games/101.jpg',
    rating: 4.65,
    ratings_count: 6800,
    metacritic: 92,
    playtime: 43,
    added: 21000,
    platforms: [PC, PS5],
    genres: [ACTION],
    tags: [SINGLEPLAYER],
    stores: [STEAM, GOG],
    esrb_rating: { id: 4, slug: 'mature', name: 'Mature' },
  },
  {
    id: 102,
    slug: 'neon-district',
    name: 'Neon District',
    released: '2019-08-02',
    background_image: 'https://media.rawg.io/media/games/102.jpg',
    rating: 4.1,
    ratings_count: 1200,
    metacritic: 81,
    playtime: 12,
    added: 15000,
    platforms: [PC],
    genres: [INDIE],
    tags: [MULTIPLAYER],
    stores: [STEAM],
    esrb_rating: { id: 3, slug: 'teen', name: 'Teen' },
  },
  {
    id: 103,
    slug: 'paper-harbour',
    name: 'Paper Harbour',
    released: '2024-01-30',
    background_image: 'https://media.rawg.io/media/games/103.jpg',
    rating: 3.8,
    ratings_count: 210,
    metacritic: null,
    playtime: 6,
    added: 9000,
    platforms: [SWITCH],
    genres: [INDIE],
    tags: [SINGLEPLAYER],
    stores: [],
  },
  {
    id: 104,
    slug: 'frost-relay',
    name: 'Frost Relay',
    released: '2022-11-15',
    background_image: 'https://media.rawg.io/media/games/104.jpg',
    rating: 4,
    ratings_count: 800,
    metacritic: 77,
    playtime: 25,
    added: 8000,
    platforms: [PC],
    genres: [STRATEGY],
    tags: [SINGLEPLAYER, ONLINE_COOP],
    stores: [STEAM, EPIC],
    esrb_rating: { id: 2, slug: 'everyone-10-plus', name: 'Everyone 10+' },
  },
  {
    id: 105,
    slug: 'quiet-orbit',
    name: 'Quiet Orbit',
    released: '2023-05-04',
    background_image: 'https://media.rawg.io/media/games/105.jpg',
    rating: 3.5,
    ratings_count: 430,
    metacritic: 70,
    playtime: 3,
    added: 7000,
    platforms: [PC],
    genres: [INDIE],
    tags: [MULTIPLAYER],
    stores: [STEAM],
    esrb_rating: { id: 1, slug: 'everyone', name: 'Everyone' },
  },
  {
    id: 106,
    slug: 'amber-trail',
    name: 'Amber Trail',
    released: '2020-02-20',
    background_image: 'https://media.rawg.io/media/games/106.jpg',
    rating: 4.3,
    ratings_count: 2400,
    metacritic: 85,
    playtime: 60,
    added: 6000,
    platforms: [PC, PS5],
    genres: [ACTION, INDIE],
    tags: [SINGLEPLAYER],
    stores: [STEAM],
    esrb_rating: { id: 3, slug: 'teen', name: 'Teen' },
  },
  {
    id: 107,
    slug: 'deep-signal',
    name: 'Deep Signal',
    released: '2018-06-09',
    background_image: 'https://media.rawg.io/media/games/107.jpg',
    rating: 3.2,
    ratings_count: 150,
    metacritic: 64,
    playtime: 9,
    added: 5000,
    platforms: [PC],
    genres: [ACTION],
    tags: [SINGLEPLAYER],
    stores: [STEAM],
  },
  {
    id: 108,
    slug: 'silent-meridian',
    name: 'Silent Meridian',
    released: '2025-04-18',
    background_image: 'https://media.rawg.io/media/games/108.jpg',
    rating: 4.45,
    ratings_count: 980,
    metacritic: 88,
    playtime: 32,
    added: 4000,
    platforms: [PC, PS5],
    genres: [ACTION],
    tags: [SINGLEPLAYER, ONLINE_COOP],
    stores: [STEAM],
    esrb_rating: { id: 4, slug: 'mature', name: 'Mature' },
  },
  {
    id: 109,
    slug: 'lost-canton',
    name: 'Lost Canton',
    released: '2017-09-29',
    background_image: 'https://media.rawg.io/media/games/109.jpg',
    rating: 3.9,
    ratings_count: 640,
    metacritic: 74,
    playtime: 18,
    added: 3000,
    platforms: [SWITCH],
    genres: [STRATEGY],
    tags: [SINGLEPLAYER],
    stores: [NINTENDO],
  },
]

export const JOB_PAGE_SIZE = 3

/** `JOB_GAMES` served the way RAWG serves `games?ordering=-added`, three to a page. */
export function jobGamesPage(page: number): RawgList<RawgGameListItem> {
  const from = (page - 1) * JOB_PAGE_SIZE
  const results = JOB_GAMES.slice(from, from + JOB_PAGE_SIZE)
  return {
    count: JOB_GAMES.length,
    next: from + JOB_PAGE_SIZE < JOB_GAMES.length ? `https://api.rawg.io/api/games?page=${page + 1}` : null,
    results,
  }
}

export const JOB_PAGE_COUNT = Math.ceil(JOB_GAMES.length / JOB_PAGE_SIZE)

/** `games/{id}/stores` per game, for every game that has store links at all. */
export const JOB_STORE_LINKS: Record<number, RawgList<RawgStoreLink>> = {
  101: {
    count: 2,
    results: [
      { id: 1, store_id: 1, url: 'https://store.steampowered.com/app/411000/Hollow_Cradle/' },
      { id: 2, store_id: 5, url: 'https://www.gog.com/game/hollow_cradle' },
    ],
  },
  102: {
    count: 1,
    results: [{ id: 3, store_id: 1, url: 'https://store.steampowered.com/app/412000/' }],
  },
  104: {
    count: 2,
    // Listed on Steam by RAWG, but the link points at the publisher's page: no app id to keep.
    results: [
      { id: 4, store_id: 1, url: 'https://frostrelay.example/buy' },
      { id: 5, store_id: 11, url: 'https://store.epicgames.com/p/frost-relay' },
    ],
  },
  105: {
    count: 1,
    results: [{ id: 6, store_id: 1, url: 'https://store.steampowered.com/app/415000/Quiet_Orbit/' }],
  },
  106: {
    count: 1,
    results: [{ id: 7, store_id: 1, url: 'https://store.steampowered.com/app/416000/Amber_Trail/' }],
  },
  107: {
    count: 1,
    results: [{ id: 8, store_id: 1, url: 'https://store.steampowered.com/app/417000/' }],
  },
  108: {
    count: 1,
    results: [{ id: 9, store_id: 1, url: 'https://store.steampowered.com/app/418000/' }],
  },
  109: {
    count: 1,
    results: [{ id: 10, store_id: 6, url: 'https://www.nintendo.com/store/products/lost-canton/' }],
  },
}

/** RAWG game id to the Steam app id the store links resolve to (`''` = the game has none). */
export const JOB_APP_IDS: Record<number, string> = {
  101: '411000',
  102: '412000',
  104: '',
  105: '415000',
  106: '416000',
  107: '417000',
  108: '418000',
}

/** `appdetails?filters=price_overview` entries, keyed by app id, exactly as Steam returns them. */
export const JOB_STEAM_PRICES: Record<string, unknown> = {
  '411000': {
    success: true,
    data: {
      price_overview: {
        currency: 'UAH',
        initial: 134900,
        final: 67450,
        discount_percent: 50,
        initial_formatted: '1 349 ₴',
        final_formatted: '675 ₴',
      },
    },
  },
  '412000': {
    success: true,
    data: {
      price_overview: {
        currency: 'UAH',
        initial: 44900,
        final: 44900,
        discount_percent: 0,
        initial_formatted: '449 ₴',
        final_formatted: '449 ₴',
      },
    },
  },
  // Free — indistinguishable from "not for sale here" until the per-app call reports `is_free`.
  '415000': { success: true, data: [] },
  '416000': {
    success: true,
    data: {
      price_overview: {
        currency: 'UAH',
        initial: 79900,
        final: 59925,
        discount_percent: 25,
        initial_formatted: '799 ₴',
        final_formatted: '599 ₴',
      },
    },
  },
  '417000': { success: false },
  '418000': {
    success: true,
    data: {
      price_overview: {
        currency: 'UAH',
        initial: 129900,
        final: 129900,
        discount_percent: 0,
        initial_formatted: '1 299 ₴',
        final_formatted: '1 299 ₴',
      },
    },
  },
}

/** The unfiltered per-app `appdetails` payload the language stage reads, keyed by app id. */
export const JOB_STEAM_APPS: Record<string, unknown> = {
  '411000': {
    success: true,
    data: {
      is_free: false,
      supported_languages:
        'English<strong>*</strong>, French, Українська<strong>*</strong><br><strong>*</strong>мови з повною аудіопідтримкою',
    },
  },
  '412000': {
    success: true,
    data: { is_free: false, supported_languages: 'English, German, Українська, Polish' },
  },
  '415000': {
    success: true,
    data: { is_free: true, supported_languages: 'English, Українська' },
  },
  '416000': {
    success: true,
    data: {
      is_free: false,
      supported_languages:
        'English<strong>*</strong>, French, German, Українська<strong>*</strong><br><strong>*</strong>languages with full audio support',
    },
  },
  '417000': {
    success: true,
    data: { is_free: false, supported_languages: 'English, French, Spanish - Spain' },
  },
  '418000': {
    success: true,
    data: { is_free: false, supported_languages: 'English, Japanese' },
  },
}
