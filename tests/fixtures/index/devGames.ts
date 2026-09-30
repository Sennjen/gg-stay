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
    // Cheap AND heavily discounted, on PC: the one game in this seed that satisfies a price
    // ceiling and a discount floor at the same time, so the design's own acceptance URL
    // (`?priceMaxUah=300&onSaleMinPercent=50`) has something to match and the resolver's AND
    // between the two ranges is actually exercised. Its 75 % also beats The Witcher 3's 50 %, so
    // `DISCOUNT_DESC` has a real order rather than a tie broken by popularity.
    priceUah: 225,
    regularPriceUah: 900,
    discountPercent: 75,
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

/**
 * Games made in Ukraine, so fixture mode has something for the "Зроблено в Україні" shelf and the
 * `madeInUkraine` filter. They are index-only: the RAWG fixtures do not show them, which is the
 * shape the refresh job's studios stage produces for a studio game outside the popularity list —
 * and why their game pages have no RAWG fixture to open in fixture mode.
 *
 * The ids, slugs, release dates and covers are RAWG's own; platforms, genres and stores are the
 * real ones. Popularity and rating figures are rounded stand-ins, and the prices are plausible
 * Steam prices in hryvnia, not recorded ones. Every price sits above 700 ₴ and the one discount
 * below 50 %, so the seed's cheap-and-discounted queries — and the acceptance URLs pinned on them —
 * still answer only the three games above. Languages were never recorded, so they stay unknown.
 * Listed most popular first, the index's own order.
 */
interface MadeInUkraine
  extends Pick<
    IndexedGame,
    | 'id'
    | 'slug'
    | 'name'
    | 'cover'
    | 'released'
    | 'popularity'
    | 'platforms'
    | 'genres'
    | 'stores'
    | 'ageRating'
    | 'rating'
    | 'ratingsCount'
    | 'metacritic'
    | 'playtime'
  > {
  price?: { priceUah: number; regularPriceUah: number; discountPercent: number }
}

function madeInUkraine({ price, ...game }: MadeInUkraine): IndexedGame {
  // Spelled out in the document's own field order, so `published.json` reads like its neighbours.
  return {
    id: game.id,
    slug: game.slug,
    name: game.name,
    cover: game.cover,
    preview: null,
    released: game.released,
    popularity: game.popularity,
    platforms: game.platforms,
    genres: game.genres,
    stores: game.stores,
    gameModes: ['SINGLE'],
    ageRating: game.ageRating,
    rating: game.rating,
    ratingsCount: game.ratingsCount,
    metacritic: game.metacritic,
    playtime: game.playtime,
    priceUah: price?.priceUah ?? null,
    regularPriceUah: price?.regularPriceUah ?? null,
    discountPercent: price?.discountPercent ?? 0,
    free: false,
    localisation: null,
    madeInUkraine: true,
    priceUpdatedAt: price ? DEV_FIXTURE_PRICES_UPDATED_AT : null,
  }
}

export const DEV_FIXTURE_UKRAINIAN_GAMES: IndexedGame[] = [
  // 4A Games, Kyiv. On sale: the seed's one discounted game made in Ukraine.
  madeInUkraine({
    id: 28201,
    slug: 'metro-exodus',
    name: 'Metro Exodus',
    cover: 'https://media.rawg.io/media/games/152/152e788b7504aa2753c86dae912fb34c.jpg',
    released: '2019-02-13',
    popularity: 9500,
    platforms: [4, 18, 1, 187, 186],
    genres: ['action', 'shooter'],
    stores: ['steam', 'gog'],
    ageRating: 'PEGI18',
    rating: 4.2,
    ratingsCount: 2900,
    metacritic: 82,
    playtime: 18,
    price: { priceUah: 749, regularPriceUah: 1249, discountPercent: 40 },
  }),
  // GSC Game World, Kyiv.
  madeInUkraine({
    id: 17857,
    slug: 'stalker-shadow-of-chernobyl',
    name: 'S.T.A.L.K.E.R.: Shadow of Chernobyl',
    cover: 'https://media.rawg.io/media/games/348/348640e78a7fcd4bb7dcad4fea014eeb.jpg',
    released: '2007-03-19',
    popularity: 9000,
    platforms: [4],
    genres: ['action', 'shooter', 'role-playing-games-rpg'],
    stores: ['steam', 'gog'],
    ageRating: 'PEGI18',
    rating: 4.3,
    ratingsCount: 2100,
    metacritic: 82,
    playtime: 14,
  }),
  // 4A Games, Kyiv.
  madeInUkraine({
    id: 29028,
    slug: 'metro-2033',
    name: 'Metro 2033',
    cover: 'https://media.rawg.io/media/games/120/1201a40e4364557b124392ee50317b99.jpg',
    released: '2010-03-16',
    popularity: 8500,
    platforms: [4, 14],
    genres: ['action', 'shooter'],
    stores: ['steam'],
    ageRating: 'PEGI18',
    rating: 4.0,
    ratingsCount: 1800,
    metacritic: 81,
    playtime: 9,
  }),
  // Frogwares, Kyiv.
  madeInUkraine({
    id: 447825,
    slug: 'sherlock-holmes-chapter-one',
    name: 'Sherlock Holmes Chapter One',
    cover: 'https://media.rawg.io/media/games/60c/60ca6f84551e6f5435d97b603a77d551.jpg',
    released: '2021-11-15',
    popularity: 2500,
    platforms: [4, 18, 187, 1, 186],
    genres: ['adventure'],
    stores: ['steam', 'gog'],
    ageRating: null,
    rating: 3.8,
    ratingsCount: 240,
    metacritic: null,
    playtime: 12,
    price: { priceUah: 899, regularPriceUah: 899, discountPercent: 0 },
  }),
  // GSC Game World, Kyiv.
  madeInUkraine({
    id: 9873,
    slug: 'cossacks-3',
    name: 'Cossacks 3',
    cover: 'https://media.rawg.io/media/games/149/149e4ff4a44f05dc8ea0cbd43153f8e3.jpg',
    released: '2016-09-19',
    popularity: 1500,
    platforms: [4],
    genres: ['strategy'],
    stores: ['steam'],
    ageRating: null,
    rating: 3.4,
    ratingsCount: 150,
    metacritic: null,
    playtime: 6,
  }),
]
