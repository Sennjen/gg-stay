import type { IndexedGame } from '../../../server/index/document'

/**
 * Forty synthetic cards for the `GameIndex` contract suite. Every rule in the contract has at
 * least one discriminating game here: a facet value nothing else carries, a boundary value of a
 * range, a priced and an unpriced twin, a game with Ukrainian audio but no Ukrainian text, and a
 * trio that ties on the sort score so the tie-break is observable.
 *
 * Popularity is `1000 - id * 10`, so the default popularity order is the id order — except for
 * the deliberate tie group 38/39/40.
 */

export const FIXTURE_TODAY = '2026-09-20'

function game(id: number, name: string, overrides: Partial<IndexedGame> = {}): IndexedGame {
  return {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    cover: `https://cdn.test/${id}.jpg`,
    released: '2020-06-01',
    popularity: 1000 - id * 10,
    platforms: [4],
    genres: ['action'],
    stores: ['steam'],
    gameModes: ['SINGLE'],
    ageRating: 'PEGI16',
    rating: 4,
    ratingsCount: id * 7,
    metacritic: 75,
    playtime: 20,
    priceUah: null,
    regularPriceUah: null,
    discountPercent: 0,
    free: false,
    localisation: null,
    madeInUkraine: false,
    priceUpdatedAt: null,
    ...overrides,
  }
}

function priced(uah: number, regular: number, discountPercent: number): Partial<IndexedGame> {
  return {
    priceUah: uah,
    regularPriceUah: regular,
    discountPercent,
    priceUpdatedAt: '2026-09-20T06:00:00.000Z',
  }
}

export const FIXTURE_GAMES: IndexedGame[] = [
  // Facets: genres, platforms, stores.
  game(1, 'Alpha Quest'),
  game(2, 'Beta Run', { genres: ['indie'], platforms: [7] }),
  game(3, 'Gamma Ray', { genres: ['action', 'indie'], platforms: [4, 7] }),
  game(4, 'Delta Force', { genres: ['strategy'], platforms: [18] }),
  game(5, 'Epsilon Edge', { genres: ['indie'], stores: ['gog'] }),
  game(6, 'Zeta Zone', { platforms: [7], stores: ['epic-games', 'steam'] }),

  // Facets: game modes and age ratings.
  game(7, 'Eta Empire', { gameModes: ['MULTIPLAYER'], ageRating: 'PEGI18' }),
  game(8, 'Theta Tale', { gameModes: ['SINGLE', 'ONLINE_COOP'], ageRating: 'PEGI3' }),
  game(9, 'Iota Isle', { gameModes: ['LOCAL_COOP'], ageRating: 'PEGI7' }),

  // Release dates: range bounds, an upcoming game and a game with no date at all.
  game(10, 'Kappa Kart', { released: '2015-03-10' }),
  game(11, 'Lambda Legacy', { released: '2018-11-20' }),
  game(12, 'Mu Machine', { released: '2021-01-05' }),
  game(13, 'Nu Nights', { released: '2026-12-01' }),
  game(14, 'Xi Expedition', { released: null }),

  // Playtime buckets, including both MEDIUM bounds and an unknown playtime.
  game(15, 'Omicron Orbit', { playtime: 5 }),
  game(16, 'Pi Planet', { playtime: 10 }),
  game(17, 'Rho Raid', { playtime: 40 }),
  game(18, 'Sigma Storm', { playtime: 41 }),
  game(19, 'Tau Trail', { playtime: 0 }),

  // Metacritic and rating bounds, plus a game scored by neither.
  game(20, 'Upsilon Union', { metacritic: 90, rating: 4.8 }),
  game(21, 'Phi Fortress', { metacritic: 80, rating: 4 }),
  game(22, 'Chi Chase', { metacritic: 79, rating: 3.9 }),
  game(23, 'Psi Path', { metacritic: null, rating: null }),

  // Prices and discounts, with both bounds of the usual filters.
  game(24, 'Omega Order', priced(300, 300, 0)),
  game(25, 'Anchor Arena', priced(299, 598, 50)),
  game(26, 'Bastion Bay', priced(301, 1204, 75)),
  game(27, 'Citadel Core', priced(1000, 2000, 50)),
  game(28, 'Dune Drifter', { ...priced(0, 0, 0), free: true }),
  game(29, 'Ember Echo', priced(150, 600, 75)),
  game(30, 'Forge Front'),
  game(31, 'Glyph Gate'),
  game(32, 'Harbor Haze', priced(250, 1000, 75)),

  // Ukrainian localisation, including audio without text and an explicit "neither".
  game(33, 'Ion Island', { localisation: { text: true, audio: false, source: 'steam' } }),
  game(34, 'Jade Jungle', { localisation: { text: true, audio: true, source: 'steam' } }),
  game(35, 'Kite Keep', { localisation: { text: false, audio: true, source: 'steam' } }),
  game(36, 'Lumen Lake', { ...priced(0, 0, 0), free: true }),
  game(37, 'Mirror March', { localisation: { text: false, audio: false, source: 'steam' } }),

  // Made in Ukraine, and the three-way tie on the Metacritic score (genre `racing` is theirs
  // alone, so a query can isolate them).
  game(38, 'Nomad Nest', {
    genres: ['racing'],
    metacritic: 55,
    popularity: 500,
    madeInUkraine: true,
    localisation: { text: true, audio: true, source: 'steam' },
  }),
  game(39, 'Onyx Oath', {
    genres: ['racing'],
    metacritic: 55,
    popularity: 700,
    madeInUkraine: true,
  }),
  game(40, 'Pixel Pursuit', { genres: ['racing'], metacritic: 55, popularity: 700 }),
]
