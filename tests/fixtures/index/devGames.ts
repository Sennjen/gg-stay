import type { IndexedGame } from '../../../server/index/document'

/**
 * The index documents a development server is seeded with — one per game the RAWG fixtures
 * actually show (see `tests/fixtures/rawg/games.json`), so fixture mode renders the price line,
 * the sale chip, a free game and the localisation badge instead of the empty state.
 *
 * Every field that also exists on the RAWG fixture (slug, name, release date, rating, Metacritic,
 * playtime, cover, platform ids, popularity) carries the same value here, so the card the index
 * path serves and the card the RAWG path serves are the same card — which is what
 * `tests/server/index/toGraphql.test.ts` pins.
 *
 * `unreleased-sample` (999001) is deliberately absent: a catalog page must keep showing a game the
 * index knows nothing about, with no price line at all.
 */

/** When the fixture run finished; `priceUpdatedAt` below is relative to it. */
export const DEV_FIXTURE_UPDATED_AT = '2026-09-20T06:30:00.000Z'
export const DEV_FIXTURE_PRICES_UPDATED_AT = '2026-09-20T06:00:00.000Z'

export const DEV_FIXTURE_GAMES: IndexedGame[] = [
  {
    id: 3328,
    slug: 'the-witcher-3-wild-hunt',
    name: 'The Witcher 3: Wild Hunt',
    cover: 'https://media.rawg.io/media/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg',
    // The first `short_screenshot` of the RAWG fixture that is not the cover — what the job's
    // `previewOf` picks, so the card's hover preview is the same on both paths.
    preview: 'https://media.rawg.io/media/screenshots/155001/screenshot1.jpg',
    released: '2015-05-18',
    popularity: 21000,
    platforms: [4, 187, 7],
    genres: ['action', 'role-playing-games-rpg'],
    stores: ['steam', 'gog'],
    gameModes: ['SINGLE'],
    ageRating: 'PEGI18',
    rating: 4.65,
    ratingsCount: 6800,
    metacritic: 92,
    playtime: 43,
    // The same numbers Steam's recorded price fixture carries for app 292030, so the live refresh
    // on the game page agrees with the index copy instead of contradicting it.
    priceUah: 675,
    regularPriceUah: 1349,
    discountPercent: 50,
    free: false,
    localisation: { text: true, audio: true, source: 'steam' },
    madeInUkraine: false,
    // Three hours before the run, so a development game page shows the "updated N hours ago"
    // caption and stays under the six-hour live-refresh threshold.
    priceUpdatedAt: '2026-09-20T03:00:00.000Z',
  },
  {
    id: 4200,
    slug: 'portal-2',
    name: 'Portal 2',
    cover: null,
    preview: 'https://media.rawg.io/media/screenshots/155101/screenshot1.jpg',
    released: '2011-04-18',
    popularity: 19500,
    platforms: [4],
    genres: ['shooter', 'puzzle'],
    stores: ['steam'],
    gameModes: ['SINGLE', 'ONLINE_COOP'],
    ageRating: 'PEGI7',
    rating: 4.6,
    ratingsCount: 5400,
    metacritic: 95,
    playtime: 11,
    priceUah: 225,
    regularPriceUah: 225,
    discountPercent: 0,
    free: false,
    localisation: { text: true, audio: false, source: 'steam' },
    madeInUkraine: false,
    priceUpdatedAt: DEV_FIXTURE_PRICES_UPDATED_AT,
  },
  {
    id: 654,
    slug: 'stardew-valley',
    name: 'Stardew Valley',
    cover: null,
    preview: 'https://media.rawg.io/media/screenshots/155201/screenshot1.jpg',
    released: '2016-02-25',
    popularity: 9800,
    platforms: [4, 7],
    genres: ['indie', 'simulation'],
    stores: ['steam'],
    gameModes: ['SINGLE', 'ONLINE_COOP'],
    ageRating: 'PEGI7',
    rating: 4.4,
    ratingsCount: 3100,
    metacritic: 89,
    playtime: 27,
    priceUah: 0,
    regularPriceUah: 0,
    discountPercent: 0,
    free: true,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: DEV_FIXTURE_PRICES_UPDATED_AT,
  },
]
