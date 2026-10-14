import type {
  IndexMeta,
  IndexedExchangeRate,
  IndexedGame,
  IndexedOffer,
} from '../../../server/index/document'

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
 *
 * Four games also carry what GOG and the Microsoft Store charge (`IndexedGame.offers`), one case
 * each of what a page has to tell apart:
 *
 * | game                        | offers                           | what it is there for            |
 * | --------------------------- | -------------------------------- | ------------------------------- |
 * | The Witcher 3 (3328)        | GOG, $8.99                       | dollars, and clearly cheaper    |
 * |                             |                                  | than Steam: ≈ 404 ₴ against 675 |
 * | Stardew Valley (654)        | Microsoft Store, 385 ₴           | hryvnia, beside a free Steam    |
 * | Metro Exodus (28201)        | GOG, $29.99                      | dollars, and not cheaper than   |
 * |                             |                                  | Steam: ≈ 1 348 ₴ against 749    |
 * | Sherlock Holmes: Chapter    | GOG, $7.99, read two days before | a stale offer: it would be the  |
 * | One (447825)                | the run                          | cheapest, and is not a price    |
 *
 * The first two have a RAWG fixture whose store links name the same store, as the links of a
 * game with an offer always do; the other two are index-only. The GOG amounts and the two
 * index-only slugs are plausible, not recorded. Stardew Valley's offer is recorded: the product
 * RAWG links and what the Microsoft Store charged for it in Ukraine on 2026-10-12. The rate is
 * the National Bank's as recorded (`tests/fixtures/nbu/exchange.json`), so the first row is the
 * design's own example: $8.99 is ≈ 404 ₴.
 *
 * The Witcher 3's GOG product is recorded too, though its price is not: the pack GOG's catalog
 * holds for Ukraine, under its own slug and the title the catalog gave it on 2026-10-12
 * (`tests/fixtures/gog/catalog.json`). The slug RAWG's link still carries for the game,
 * `the_witcher_3_wild_hunt`, is in that catalog no longer, so a seed that named it would send a
 * development page to an address GOG does not sell at. A real run reads no GOG price for this
 * game for the same reason — nothing is guessed from a title — and the seed stands in for a game
 * whose link does name the product.
 *
 * Each offer also carries, or does not, what the store calls the product (`IndexedOffer.title`)
 * — again one case each of what a page has to tell apart from the game's own name:
 *
 * | game                 | the store's title                                   | against the name  |
 * | -------------------- | --------------------------------------------------- | ----------------- |
 * | The Witcher 3        | The Witcher 3: Wild Hunt — Remastered               | another edition   |
 * | Stardew Valley       | Stardew Valley                                      | the same          |
 * | Metro Exodus         | METRO EXODUS                                        | the same, but for |
 * |                      |                                                     | its capitals      |
 * | Sherlock Holmes: C1  | none                                                | nothing to say    |
 *
 * Three games carry what the PlayStation Store charges as well, one case each of what that
 * store's offers add to tell apart — and each on a game the fixture build can open as a page,
 * which takes a RAWG recording of the game (`tests/fixtures/rawg/game-<slug>.json`): without one
 * RAWG's answer is "no such game", and that answer is never second-guessed from the index.
 *
 * | game                  | the PlayStation Store's offer        | what it is there for            |
 * | --------------------- | ------------------------------------ | ------------------------------- |
 * | Metro Exodus (28201)  | 94,90 ₴ against 949,00 ₴, read by    | a fresh offer on sale, whose    |
 * |                       | the night's run; the sale ends in    | sale has days to run. Far below |
 * |                       | eight days                           | Steam's 749 ₴ and GOG's         |
 * |                       |                                      | ≈ 1 348 ₴, on a page where      |
 * |                       |                                      | Steam's is the cheapest of the  |
 * |                       |                                      | prices that are compared        |
 * | Stardew Valley (654)  | 314,30 ₴ against 449,00 ₴, read      | a fresh offer whose sale is     |
 * |                       | eighteen hours before the run; the   | over: its price is the regular  |
 * |                       | sale ended eight hours before it     | one                             |
 * | Cyberpunk 2077        | 1 499,00 ₴, read three days before   | an offer older than forty-eight |
 * | (41494)               | the run                              | hours: not a price              |
 *
 * In Metro Exodus and Cyberpunk 2077 the product's title is the game's own name, letter for
 * letter, which is the case a page has to show for this store and for no other: the product Sony
 * puts first is not always the game, so its name is shown whether or not it says anything new.
 * Stardew Valley's is two hundred characters long, the most a title may be
 * (`DEV_FIXTURE_PLAYSTATION_LONG_TITLE`), and made up: the row's worst case on a phone.
 *
 * What is recorded and what is not. The three products, their titles, and the prices of two of
 * them are Sony's own for Ukraine on 2026-10-13 (`tests/fixtures/playstation`): Metro Exodus at
 * 94,90 ₴ against 949,00 ₴, and Cyberpunk 2077 at 1 499,00 ₴. Two things a real run would have
 * done otherwise that day. Sony listed Metro Exodus's sale for the buyers of an experiment, which
 * the job reads as the regular price with no discount (`playstationPurchasePrice`); the seed
 * carries it as a sale for everybody, with an end of its own. And Sony's concept for Stardew
 * Valley lists that one product and puts no product first, so a real run reads no price for it
 * at all: its amounts here are made up, and the seed stands in for a game whose default product
 * is the game — as The Witcher 3's GOG offer stands in above. The title ids in the three RAWG
 * links are the real ones (Sony maps each to the concept the product is of); Cyberpunk 2077's
 * link is RAWG's own, and the rest of the other two product ids is not recorded.
 */

/** When the fixture run finished; `priceUpdatedAt` below is relative to it. */
export const DEV_FIXTURE_UPDATED_AT = '2026-09-20T06:30:00.000Z'
export const DEV_FIXTURE_PRICES_UPDATED_AT = '2026-09-20T06:00:00.000Z'

/**
 * When the fixture run's stores were last read: the prices run before it, under six hours
 * earlier. An offer dated then is fresh on a page — the site calls one stale past thirty-six
 * hours.
 */
export const DEV_FIXTURE_OFFERS_READ_AT = '2026-09-20T00:15:00.000Z'

/** A read two days before the run: past thirty-six hours, so an offer dated then is stale. */
export const DEV_FIXTURE_STALE_OFFER_AT = '2026-09-18T12:15:00.000Z'

/**
 * When the fixture run's own night read the PlayStation Store. That store is read a game at a
 * time, once a day, so its offers are dated one by one and no stamp in the metadata says when.
 */
export const DEV_FIXTURE_PLAYSTATION_READ_AT = '2026-09-20T02:40:00.000Z'

/** A sale that has eight days to run when the fixture run ends. */
export const DEV_FIXTURE_SALE_ENDS_AT = '2026-09-28T21:59:00.000Z'

/** A PlayStation Store read eighteen hours before the run: a day's read, and still a price. */
export const DEV_FIXTURE_PLAYSTATION_EARLIER_READ_AT = '2026-09-19T12:20:00.000Z'

/** A sale that was on at that read and ended eight hours before the run. */
export const DEV_FIXTURE_SALE_ENDED_AT = '2026-09-19T21:59:00.000Z'

/** A PlayStation Store read three days before the run: past forty-eight hours, so not a price. */
export const DEV_FIXTURE_PLAYSTATION_STALE_AT = '2026-09-17T06:20:00.000Z'

/**
 * A product title of two hundred characters, the most an offer's title may have
 * (`MAX_OFFER_TITLE_LENGTH`): made up, as the layout's worst case for a row that always shows its
 * title. A real PlayStation Store title is a game's name with an edition, under eighty.
 */
export const DEV_FIXTURE_PLAYSTATION_LONG_TITLE =
  'Stardew Valley: Complete Farming Collection for PlayStation 4 and PlayStation 5, with every free update from 1.0 to 1.6, the original soundtrack, a digital art book and the cooperative farm mode (PS5)'

/** The National Bank's dollar rate the fixture run read, for the day it ran on. */
export const DEV_FIXTURE_EXCHANGE_RATE: IndexedExchangeRate = {
  currency: 'USD',
  uah: 44.9567,
  date: '2026-09-20',
  readAt: DEV_FIXTURE_PRICES_UPDATED_AT,
}

/** What the fixture's metadata says of the stores other than Steam, beside what it always said. */
export const DEV_FIXTURE_META_EXTRA: Pick<IndexMeta, 'exchangeRate' | 'offersReadAt'> = {
  exchangeRate: DEV_FIXTURE_EXCHANGE_RATE,
  offersReadAt: {
    gog: DEV_FIXTURE_OFFERS_READ_AT,
    'xbox-store': DEV_FIXTURE_OFFERS_READ_AT,
  },
}

/** A GOG offer in cents, as the refresh job writes one. */
function gogOffer(
  slug: string,
  title: string | null,
  amount: number,
  regularAmount: number,
  updatedAt = DEV_FIXTURE_OFFERS_READ_AT,
): IndexedOffer {
  return {
    store: 'gog',
    // Left out, not written empty, when the store gave none.
    ...(title === null ? {} : { title }),
    amount,
    regularAmount,
    currency: 'USD',
    discountPercent: Math.round((1 - amount / regularAmount) * 100),
    url: `https://www.gog.com/en/game/${slug}`,
    updatedAt,
  }
}

/** A Microsoft Store offer in kopecks, as the refresh job writes one. */
function microsoftOffer(
  name: string,
  id: string,
  title: string | null,
  amount: number,
  regularAmount: number,
  updatedAt = DEV_FIXTURE_OFFERS_READ_AT,
): IndexedOffer {
  return {
    store: 'xbox-store',
    ...(title === null ? {} : { title }),
    amount,
    regularAmount,
    currency: 'UAH',
    discountPercent: Math.round((1 - amount / regularAmount) * 100),
    url: `https://www.microsoft.com/uk-ua/p/${name}/${id}`,
    updatedAt,
  }
}

/**
 * A PlayStation Store offer in kopecks, as the refresh job writes one: the product's page in the
 * Ukrainian store, and the end of the sale only where there is a sale with a stated end.
 */
function playstationOffer(
  productId: string,
  title: string,
  amount: number,
  regularAmount: number,
  updatedAt: string,
  saleEndsAt?: string,
): IndexedOffer {
  return {
    store: 'playstation-store',
    title,
    amount,
    regularAmount,
    currency: 'UAH',
    discountPercent: Math.round((1 - amount / regularAmount) * 100),
    url: `https://store.playstation.com/uk-ua/product/${productId}`,
    updatedAt,
    ...(saleEndsAt === undefined ? {} : { saleEndsAt }),
  }
}

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
    // The app the RAWG store-link fixture points at, published the way the refresh job publishes
    // it — so the game page knows which Steam app to ask about, and which store page to name,
    // before RAWG has said anything. The same goes for the two games below.
    steamAppId: '292030',
    // GOG in dollars, and clearly below Steam: $8.99 is ≈ 404 ₴ at the fixture's rate, against
    // 675 ₴. The product is the pack GOG's catalog holds for Ukraine, and the title is the
    // catalog's own for it, dash and all: another edition than the game's name says, which is
    // what the title is there to tell a page.
    offers: [
      gogOffer(
        'the_witcher_3_wild_hunt_game_of_the_year_edition',
        'The Witcher 3: Wild Hunt — Remastered',
        899,
        3999,
      ),
    ],
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
    steamAppId: '620',
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
    stores: ['steam', 'xbox-store', 'playstation-store'],
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
    steamAppId: '413150',
    // The Microsoft Store in hryvnia, beside a Steam page that gives the game away: the product
    // and the price are the store's own for Ukraine.
    //
    // And the PlayStation Store, read while a sale was on that has since ended: from that moment
    // the offer's price is its regular one. Under a product title as long as an offer's title may
    // be (`MAX_OFFER_TITLE_LENGTH`), which the row shows whole.
    offers: [
      microsoftOffer('stardew-valley', 'c3d891z6tnqm', 'Stardew Valley', 38_500, 38_500),
      playstationOffer(
        'EP2319-CUSA26625_00-2010147637670638',
        DEV_FIXTURE_PLAYSTATION_LONG_TITLE,
        31_430,
        44_900,
        DEV_FIXTURE_PLAYSTATION_EARLIER_READ_AT,
        DEV_FIXTURE_SALE_ENDED_AT,
      ),
    ],
  },
]

/**
 * Games made in Ukraine, so fixture mode has something for the "Зроблено в Україні" shelf and the
 * `madeInUkraine` filter. They are index-only: the RAWG fixtures do not list them, which is the
 * shape the refresh job's studios stage produces for a studio game outside the popularity list —
 * and why their game pages have no RAWG fixture to open in fixture mode. Metro Exodus is the one
 * exception to the second half: it has a recording of its own page, so that the page opens.
 *
 * The ids, slugs, release dates and covers are RAWG's own; platforms, genres and stores are the
 * real ones. Popularity and rating figures are rounded stand-ins, and the prices are plausible
 * Steam prices in hryvnia, not recorded ones. Every price sits above 700 ₴ and the one discount
 * below 50 %, so none of them joins the seed's cheap-and-discounted queries or the acceptance URLs
 * pinned on them. Languages were never recorded, so they stay unknown.
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
  offers?: IndexedOffer[]
}

function madeInUkraine({ price, offers, ...game }: MadeInUkraine): IndexedGame {
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
    // Left out, not written empty, as the refresh job leaves it.
    ...(offers ? { offers } : {}),
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
    stores: ['steam', 'gog', 'playstation-store'],
    ageRating: 'PEGI18',
    rating: 4.2,
    ratingsCount: 2900,
    metacritic: 82,
    playtime: 18,
    price: { priceUah: 749, regularPriceUah: 1249, discountPercent: 40 },
    // GOG at its regular price, which is not cheaper than Steam's sale: $29.99 is ≈ 1 348 ₴.
    // The store shouts the title; it is the game's own name all the same.
    //
    // And the PlayStation Store on sale for eight more days, at an eighth of Steam's price: the
    // one row of the page that is below Steam's, and the one that is never weighed against it.
    offers: [
      gogOffer('metro_exodus', 'METRO EXODUS', 2999, 2999),
      playstationOffer(
        'EP4062-PPSA01749_00-METROEXODUS0GEN9',
        'Metro Exodus',
        9_490,
        94_900,
        DEV_FIXTURE_PLAYSTATION_READ_AT,
        DEV_FIXTURE_SALE_ENDS_AT,
      ),
    ],
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
    // A stale offer: $7.99 would be ≈ 359 ₴ and far the cheapest, and it was read two days
    // before the run — so it is not a price, and its store is a link without one.
    offers: [gogOffer('sherlock_holmes_chapter_one', null, 799, 3999, DEV_FIXTURE_STALE_OFFER_AT)],
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

/**
 * Three more games so fixture mode renders every landing shelf and the similar-games row: with
 * them "Українською" reaches four games (The Witcher 3, Portal 2, Half-Life 2, Cyberpunk 2077),
 * "Зі знижкою" four at −30 % or more (Portal 2, The Witcher 3, The Witcher 2, Metro Exodus), and
 * The Witcher 3 six games that share a genre with it.
 *
 * The ids, slugs, names, release dates, covers, prices, discounts and Ukrainian-text flags are the
 * production index's own, read on 2026-09-30. That read carries no genres or platforms (the index
 * path serves neither on a card), so those are the games' RAWG genres and main platforms. The
 * popularity figures are rounded stand-ins that keep the production order (Half-Life 2 ahead of
 * Cyberpunk 2077, both behind Portal 2; The Witcher 2 behind The Witcher 3); nothing else is
 * known, so rating, Metacritic and playtime stay empty.
 *
 * The Witcher 2 is cheap AND heavily discounted (59 ₴ at −85 %), so it joins Portal 2 in the
 * seed's cheap-and-discounted queries; its −85 % is the seed's biggest discount and shares it
 * with nothing.
 */
interface ShelfGame
  extends Pick<
    IndexedGame,
    'id' | 'slug' | 'name' | 'cover' | 'released' | 'popularity' | 'platforms' | 'genres'
  > {
  price: { priceUah: number; regularPriceUah: number; discountPercent: number }
  ukrainianText: boolean
  /** The stores RAWG lists the game on besides Steam, and what they charge. */
  otherStores?: string[]
  offers?: IndexedOffer[]
}

function shelfGame({
  price,
  ukrainianText,
  otherStores = [],
  offers,
  ...game
}: ShelfGame): IndexedGame {
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
    stores: ['steam', ...otherStores],
    gameModes: ['SINGLE'],
    ageRating: null,
    rating: null,
    ratingsCount: 0,
    metacritic: null,
    playtime: null,
    priceUah: price.priceUah,
    regularPriceUah: price.regularPriceUah,
    discountPercent: price.discountPercent,
    free: false,
    localisation: ukrainianText ? { text: true, audio: false, source: 'steam' } : null,
    madeInUkraine: false,
    priceUpdatedAt: DEV_FIXTURE_PRICES_UPDATED_AT,
    // Left out, not written empty, as the refresh job leaves it.
    ...(offers ? { offers } : {}),
  }
}

export const DEV_FIXTURE_SHELF_GAMES: IndexedGame[] = [
  shelfGame({
    id: 13537,
    slug: 'half-life-2',
    name: 'Half-Life 2',
    cover: 'https://media.rawg.io/media/games/b8c/b8c243eaa0fbac8115e0cdccac3f91dc.jpg',
    released: '2004-11-16',
    popularity: 17000,
    platforms: [4],
    genres: ['action', 'shooter'],
    price: { priceUah: 225, regularPriceUah: 225, discountPercent: 0 },
    ukrainianText: true,
  }),
  shelfGame({
    id: 41494,
    slug: 'cyberpunk-2077',
    name: 'Cyberpunk 2077',
    cover: 'https://media.rawg.io/media/games/26d/26d4437715bee60138dab4a7c8c59c92.jpg',
    released: '2020-12-10',
    popularity: 16000,
    platforms: [4, 18, 187, 1, 186],
    genres: ['action', 'shooter', 'role-playing-games-rpg'],
    price: { priceUah: 1399, regularPriceUah: 1399, discountPercent: 0 },
    ukrainianText: true,
    // The one shelf game with a RAWG recording of its own page, so that the page opens in
    // fixture mode: it carries the PlayStation Store's offer that is too old to be a price.
    otherStores: ['playstation-store'],
    offers: [
      playstationOffer(
        'EP4497-PPSA04027_00-00000000000000N1',
        'Cyberpunk 2077',
        149_900,
        149_900,
        DEV_FIXTURE_PLAYSTATION_STALE_AT,
      ),
    ],
  }),
  shelfGame({
    id: 16944,
    slug: 'the-witcher-2-assassins-of-kings-enhanced-edition',
    name: 'The Witcher 2: Assassins of Kings Enhanced Edition',
    cover: 'https://media.rawg.io/media/games/6cd/6cd653e0aaef5ff8bbd295bf4bcb12eb.jpg',
    released: '2012-04-16',
    popularity: 11000,
    platforms: [4, 14],
    genres: ['action', 'role-playing-games-rpg'],
    price: { priceUah: 59, regularPriceUah: 399, discountPercent: 85 },
    ukrainianText: false,
  }),
]
