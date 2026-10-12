import { describe, expect, it } from 'vitest'
import {
  MAX_OFFER_TITLE_LENGTH,
  type IndexedExchangeRate,
  type IndexedGame,
  type IndexedOffer,
} from '../../../server/index/document'
import type { GameCard, StoreOffer } from '../../../server/graphql/__generated__/resolvers-types'
import {
  RAWG_ONLY_CARD_FIELDS,
  exchangeRateOf,
  steamStorePageOf,
  toGame,
  toGameCard,
  toLocalisationInfo,
  toPriceSummary,
  toSteamOffer,
  toStoreOffer,
  withCheapest,
  withStoreOffers,
  type OfferTerms,
} from '../../../server/index/toGraphql'
import { mapGame, mapGameCard, toStoreLink } from '../../../server/rawg/mappers'
import { DEV_FIXTURE_GAMES } from '../../fixtures/index/devGames'
import rawgGames from '../../fixtures/rawg/games.json' with { type: 'json' }
import rawgDetail from '../../fixtures/rawg/game-the-witcher-3-wild-hunt.json' with { type: 'json' }
import rawgStores from '../../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json' with { type: 'json' }
import type { RawgGameListItem, RawgList } from '../../../server/rawg/types'

const indexed = (overrides: Partial<IndexedGame> = {}): IndexedGame => ({
  id: 7,
  slug: 'seven',
  name: 'Seven',
  cover: 'https://media.rawg.io/media/games/seven.jpg',
  preview: 'https://media.rawg.io/media/screenshots/7.jpg',
  released: '2020-06-01',
  popularity: 100,
  platforms: [4, 187],
  genres: ['action'],
  stores: ['steam'],
  gameModes: ['SINGLE'],
  ageRating: 'PEGI16',
  rating: 4,
  ratingsCount: 12,
  metacritic: 80,
  playtime: 20,
  priceUah: null,
  regularPriceUah: null,
  discountPercent: 0,
  free: false,
  localisation: null,
  madeInUkraine: false,
  priceUpdatedAt: null,
  ...overrides,
})

const onSale = indexed({
  priceUah: 337,
  regularPriceUah: 1349,
  discountPercent: 75,
  priceUpdatedAt: '2026-09-20T06:00:00.000Z',
})

/** What a row says of another store's price when it has none: Steam's row always, and a link. */
const NOT_ANOTHER_STORE = {
  title: null,
  foreignPrice: null,
  foreignRegularPrice: null,
  approxUah: null,
  cheapest: false,
}

/** A row that is a link and nothing more. */
const NO_PRICE = {
  ...NOT_ANOTHER_STORE,
  priceUah: null,
  regularPriceUah: null,
  discountPercent: null,
  isFree: null,
  updatedAt: null,
}

describe('toPriceSummary', () => {
  it('is null for a game whose price the index does not know', () => {
    expect(toPriceSummary(indexed())).toBeNull()
  })

  it('is null for a price the index cannot date, so a price is never shown undated', () => {
    expect(toPriceSummary(indexed({ priceUah: 337, priceUpdatedAt: null }))).toBeNull()
  })

  it('reports the sale price, the price it was, the percentage and when it was read', () => {
    expect(toPriceSummary(onSale)).toEqual({
      bestUah: 337,
      regularUah: 1349,
      bestStore: 'steam',
      discountPercent: 75,
      isFree: false,
      updatedAt: '2026-09-20T06:00:00.000Z',
    })
  })

  it('leaves the pre-discount price out when the game is not on sale', () => {
    const full = indexed({
      priceUah: 225,
      regularPriceUah: 225,
      discountPercent: 0,
      priceUpdatedAt: '2026-09-20T06:00:00.000Z',
    })
    expect(toPriceSummary(full)).toMatchObject({ bestUah: 225, regularUah: null, isFree: false })
  })

  it('reports a free game as free rather than as zero hryvnia', () => {
    const free = indexed({
      priceUah: 0,
      regularPriceUah: 0,
      discountPercent: 0,
      free: true,
      priceUpdatedAt: '2026-09-20T06:00:00.000Z',
    })
    expect(toPriceSummary(free)).toMatchObject({ bestUah: 0, isFree: true, regularUah: null })
  })
})

describe('toLocalisationInfo', () => {
  it('is null when the index knows nothing about the game languages', () => {
    expect(toLocalisationInfo(indexed())).toBeNull()
  })

  it('is null when the game has neither Ukrainian text nor Ukrainian audio', () => {
    const none = indexed({ localisation: { text: false, audio: false, source: 'steam' } })
    expect(toLocalisationInfo(none)).toBeNull()
  })

  it.each([
    ['text only', { text: true, audio: false }],
    ['audio without text', { text: false, audio: true }],
    ['text and audio', { text: true, audio: true }],
  ])('reports %s', (_name, levels) => {
    const game = indexed({ localisation: { ...levels, source: 'steam' } })
    expect(toLocalisationInfo(game)).toEqual({ ...levels, source: 'steam' })
  })
})

describe('toSteamOffer', () => {
  it('carries the price onto the Steam store link', () => {
    expect(toSteamOffer(onSale, 'https://store.steampowered.com/app/292030/')).toEqual({
      ...NOT_ANOTHER_STORE,
      store: 'steam',
      url: 'https://store.steampowered.com/app/292030/',
      priceUah: 337,
      regularPriceUah: 1349,
      discountPercent: 75,
      isFree: false,
      updatedAt: '2026-09-20T06:00:00.000Z',
    })
  })

  it('leaves the price fields empty for a game the index has no price for', () => {
    expect(toSteamOffer(indexed(), 'https://store.steampowered.com/app/1/')).toEqual({
      ...NO_PRICE,
      store: 'steam',
      url: 'https://store.steampowered.com/app/1/',
    })
  })

  it('strikes nothing through when the game is not on sale', () => {
    const full = indexed({
      priceUah: 225,
      regularPriceUah: 225,
      discountPercent: 0,
      priceUpdatedAt: '2026-09-20T06:00:00.000Z',
    })
    expect(toSteamOffer(full, 'https://store.steampowered.com/app/620/')).toMatchObject({
      priceUah: 225,
      regularPriceUah: null,
      discountPercent: 0,
    })
  })
})

describe('toGameCard', () => {
  it('refuses a cover URL whose scheme is not allowed, like the RAWG mapper does', () => {
    expect(toGameCard(indexed({ cover: 'javascript:alert(1)' })).cover).toBeNull()
  })

  it('derives the platform families from the indexed platform ids', () => {
    expect(toGameCard(indexed({ platforms: [4, 187, 7] })).platformFamilies).toEqual([
      'PC',
      'PLAYSTATION',
      'NINTENDO',
    ])
  })

  it('serves the same card as the RAWG path for a game both of them know', () => {
    const list = rawgGames as unknown as RawgList<RawgGameListItem>
    for (const document of DEV_FIXTURE_GAMES) {
      const raw = (list.results ?? []).find((item) => item.id === document.id)
      expect(raw, `RAWG fixture has no game ${document.id}`).toBeDefined()

      const fromIndex = toGameCard(document)
      // The RAWG path attaches price, localisation and the made-in-Ukraine flag from the same
      // index document, so the comparison starts from a RAWG card that has had them attached.
      const fromRawg: GameCard = {
        ...mapGameCard(raw!),
        price: fromIndex.price,
        localisation: fromIndex.localisation,
        madeInUkraine: fromIndex.madeInUkraine,
      }
      expect(shared(fromIndex)).toEqual(shared(fromRawg))
    }
  })

  it('leaves the fields the index document does not carry empty', () => {
    const card = toGameCard(indexed())
    expect(card.platforms).toEqual([])
    expect(card.genres).toEqual([])
    expect(RAWG_ONLY_CARD_FIELDS).toEqual(['platforms', 'genres'])
  })

  it('serves the indexed preview as the card hover preview, and nothing when there is none', () => {
    expect(toGameCard(indexed()).screenshots).toEqual([
      { url: 'https://media.rawg.io/media/screenshots/7.jpg', width: null, height: null },
    ])
    expect(toGameCard(indexed({ preview: null })).screenshots).toEqual([])
    expect(toGameCard(indexed({ preview: 'javascript:alert(1)' })).screenshots).toEqual([])
  })
})

describe('toGame', () => {
  it('serves what the document carries, leaves the rest empty and says the answer is partial', () => {
    const document = indexed({
      ...onSale,
      steamAppId: '292030',
      localisation: { text: true, audio: false, source: 'steam' },
      madeInUkraine: true,
    })
    expect(toGame(document)).toEqual({
      id: '7',
      slug: 'seven',
      name: 'Seven',
      released: '2020-06-01',
      rating: 4,
      ratingsCount: 12,
      metacritic: 80,
      playtime: 20,
      ageRating: 'PEGI16',
      gameModes: ['SINGLE'],
      cover: { url: 'https://media.rawg.io/media/games/seven.jpg', width: null, height: null },
      platformFamilies: ['PC', 'PLAYSTATION'],
      localisation: { text: true, audio: false, source: 'steam' },
      madeInUkraine: true,
      // The document's one preview is all the page has of the game's screenshots.
      screenshots: [
        { url: 'https://media.rawg.io/media/screenshots/7.jpg', width: null, height: null },
      ],
      // One store: the Steam page its app id names, with the price the index holds.
      stores: [
        {
          ...NOT_ANOTHER_STORE,
          store: 'steam',
          url: 'https://store.steampowered.com/app/292030/',
          priceUah: 337,
          regularPriceUah: 1349,
          discountPercent: 75,
          isFree: false,
          updatedAt: '2026-09-20T06:00:00.000Z',
        },
      ],
      // No store charges this game in another currency, so no rate was used.
      exchangeRate: null,
      // Only RAWG has these.
      description: null,
      website: null,
      platforms: [],
      genres: [],
      tags: [],
      developers: [],
      publishers: [],
      // The field resolver's to fill.
      similar: [],
      partial: true,
    })
  })

  it('offers no store for a document that does not know the game’s Steam app', () => {
    // Steam is among its stores, but there is no address to send anyone to.
    expect(onSale.stores).toContain('steam')
    expect(toGame(onSale).stores).toEqual([])
  })

  it.each([
    [['gog'], 'on another store only'],
    [['gog', 'epic-games'], 'on two other stores'],
    [[], 'on no store the index knows of'],
  ])(
    'offers no Steam store for a document that knows the app but lists the game %j (%s)',
    (stores, _where) => {
      // The app id says which Steam app the game is, not that RAWG lists the game on Steam: a page
      // RAWG answers would show no Steam link for this game, so neither does this one.
      const document = indexed({ ...onSale, steamAppId: '292030', stores })
      expect(toGame(document).stores).toEqual([])
      expect(steamStorePageOf(document)).toBeNull()
    },
  )

  it('offers the Steam store when the document has both: the app id and Steam among its stores', () => {
    const document = indexed({ ...onSale, steamAppId: '292030', stores: ['gog', 'steam'] })
    expect(steamStorePageOf(document)).toBe('https://store.steampowered.com/app/292030/')
    // One offer, Steam's: the document names its other stores by slug, and without an offer of
    // theirs it has no address for them.
    expect(toGame(document).stores.map((offer) => [offer.store, offer.url])).toEqual([
      ['steam', 'https://store.steampowered.com/app/292030/'],
    ])
  })

  it('offers the Steam page without a price when the index has none for the game', () => {
    expect(toGame(indexed({ steamAppId: '620' })).stores).toEqual([
      { ...NO_PRICE, store: 'steam', url: 'https://store.steampowered.com/app/620/' },
    ])
  })

  it.each(['', '620/../../login', 'portal-2', ' 620'])(
    'builds no store address from %j, which is not an app id',
    (steamAppId) => {
      expect(toGame(indexed({ ...onSale, steamAppId })).stores).toEqual([])
    },
  )

  it('has no screenshot without a preview, and refuses a URL whose scheme is not allowed', () => {
    expect(toGame(indexed({ preview: null })).screenshots).toEqual([])
    expect(toGame(indexed({ preview: 'javascript:alert(1)' })).screenshots).toEqual([])
    expect(toGame(indexed({ cover: 'javascript:alert(1)' })).cover).toBeNull()
    expect(toGame(indexed({ cover: null })).cover).toBeNull()
  })

  it('reads a rating count of zero as unknown, as the RAWG mapper does', () => {
    expect(toGame(indexed({ ratingsCount: 0 })).ratingsCount).toBeNull()
  })

  it('says nothing about languages the index does not know, and nothing of a flag it does not have', () => {
    expect(toGame(indexed())).toMatchObject({ localisation: null, madeInUkraine: false })
  })

  it('states the same facts as the RAWG page about a game both of them know', () => {
    const fromIndex = toGame(DEV_FIXTURE_GAMES[0]!)
    const fromRawg = mapGame(rawgDetail, rawgStores.results)

    for (const field of [
      'id',
      'slug',
      'name',
      'released',
      'rating',
      'ratingsCount',
      'metacritic',
      'playtime',
      'ageRating',
      'gameModes',
      'cover',
      'platformFamilies',
    ] as const) {
      expect(fromIndex[field], field).toEqual(fromRawg[field])
    }
    // The address built from the app id is the one RAWG's own store link carries.
    const steamLink = fromRawg.stores.find((offer) => offer.store === 'steam')
    expect(fromIndex.stores.find((offer) => offer.store === 'steam')!.url).toBe(steamLink!.url)
    // And the two pages name the same stores: the document's GOG offer puts GOG on this one.
    expect(fromIndex.stores.map((offer) => offer.store)).toEqual(
      fromRawg.stores.map((offer) => offer.store),
    )
  })
})

/** The moment the pages below are made at, and offers read six hours before it. */
const NOW = '2026-10-12T12:00:00.000Z'
const READ_AT = '2026-10-12T06:00:00.000Z'
/** Thirty-six hours and a millisecond before `NOW`: just too old to be a price. */
const TOO_OLD = '2026-10-10T23:59:59.999Z'

const RATE: IndexedExchangeRate = {
  currency: 'USD',
  uah: 44.9567,
  date: '2026-10-12',
  readAt: READ_AT,
}
const TERMS: OfferTerms = { now: NOW, rate: RATE }
const NO_RATE: OfferTerms = { now: NOW, rate: null }

const GOG_URL = 'https://www.gog.com/en/game/the_witcher_3_wild_hunt'
const MICROSOFT_URL = 'https://www.microsoft.com/uk-ua/p/stardew-valley/c3d891z6tnqm'

const gogOffer = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'gog',
  title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
  amount: 899,
  regularAmount: 3999,
  currency: 'USD',
  discountPercent: 78,
  url: GOG_URL,
  updatedAt: READ_AT,
  ...overrides,
})

const microsoftOffer = (overrides: Partial<IndexedOffer> = {}): IndexedOffer => ({
  store: 'xbox-store',
  title: 'Stardew Valley',
  amount: 38_500,
  regularAmount: 38_500,
  currency: 'UAH',
  discountPercent: 0,
  url: MICROSOFT_URL,
  updatedAt: READ_AT,
  ...overrides,
})

describe('toStoreOffer', () => {
  it('puts a dollar price in the foreign fields, with an estimate, and never in the hryvnia ones', () => {
    expect(toStoreOffer(gogOffer(), RATE)).toEqual({
      store: 'gog',
      url: GOG_URL,
      title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
      priceUah: null,
      regularPriceUah: null,
      discountPercent: 78,
      isFree: false,
      updatedAt: READ_AT,
      foreignPrice: { amount: 8.99, currency: 'USD' },
      foreignRegularPrice: { amount: 39.99, currency: 'USD' },
      // 8.99 × 44.9567 = 404.16
      approxUah: 404,
      cheapest: false,
    })
  })

  it('shows a dollar price alone when there is no rate to estimate it with', () => {
    expect(toStoreOffer(gogOffer(), null)).toMatchObject({
      foreignPrice: { amount: 8.99, currency: 'USD' },
      approxUah: null,
      priceUah: null,
    })
  })

  it('puts a hryvnia price in the fields Steam’s price fills, in whole hryvnia', () => {
    expect(toStoreOffer(microsoftOffer(), RATE)).toEqual({
      store: 'xbox-store',
      url: MICROSOFT_URL,
      title: 'Stardew Valley',
      priceUah: 385,
      regularPriceUah: null,
      discountPercent: 0,
      isFree: false,
      updatedAt: READ_AT,
      foreignPrice: null,
      foreignRegularPrice: null,
      approxUah: null,
      cheapest: false,
    })
  })

  it('serves a hryvnia price on sale with the price it was, kopecks rounded to a hryvnia', () => {
    const halo = microsoftOffer({ amount: 50_820, regularAmount: 154_000, discountPercent: 67 })
    expect(toStoreOffer(halo, null)).toMatchObject({
      priceUah: 508,
      regularPriceUah: 1540,
      discountPercent: 67,
    })
  })

  it('strikes nothing through when the game is not on sale, in either currency', () => {
    const full = gogOffer({ amount: 2999, regularAmount: 2999, discountPercent: 0 })
    expect(toStoreOffer(full, RATE)).toMatchObject({
      foreignPrice: { amount: 29.99, currency: 'USD' },
      foreignRegularPrice: null,
      discountPercent: 0,
      approxUah: 1348,
    })
    expect(toStoreOffer(microsoftOffer(), RATE)).toMatchObject({ regularPriceUah: null })
  })

  it('names no discount an offer cannot show the price before', () => {
    const odd = gogOffer({ amount: 899, regularAmount: 899, discountPercent: 78 })
    expect(toStoreOffer(odd, RATE)).toMatchObject({ discountPercent: 0, foreignRegularPrice: null })
  })

  it.each([
    [0, 'a discount of nothing'],
    [100, 'a discount of everything, on a price that is not zero'],
  ])(
    'keeps the higher regular price and names no discount of %i %%: %s is not a chip',
    (discountPercent, _what) => {
      // What a document can carry until the job clamps it: the amounts are the store's own, and
      // the percent beside them is not one a page may draw.
      expect(toStoreOffer(gogOffer({ discountPercent }), RATE)).toMatchObject({
        foreignPrice: { amount: 8.99, currency: 'USD' },
        foreignRegularPrice: { amount: 39.99, currency: 'USD' },
        discountPercent: 0,
      })
      const microsoft = microsoftOffer({ amount: 19_250, regularAmount: 38_500, discountPercent })
      expect(toStoreOffer(microsoft, RATE)).toMatchObject({
        priceUah: 193,
        regularPriceUah: 385,
        discountPercent: 0,
      })
    },
  )

  it.each([1, 50, 99])('names a discount of %i %% beside a higher regular price', (percent) => {
    expect(toStoreOffer(gogOffer({ discountPercent: percent }), RATE).discountPercent).toBe(percent)
    const microsoft = microsoftOffer({
      amount: 100,
      regularAmount: 38_500,
      discountPercent: percent,
    })
    expect(toStoreOffer(microsoft, RATE).discountPercent).toBe(percent)
  })

  it('strikes nothing through when a hryvnia price rounds onto its regular price', () => {
    // 384.60 ₴ down from 385 ₴: both are 385 ₴ on the page, and that is no sale to show.
    const barely = microsoftOffer({ amount: 38_460, regularAmount: 38_500, discountPercent: 1 })
    expect(toStoreOffer(barely, RATE)).toMatchObject({
      priceUah: 385,
      regularPriceUah: null,
      discountPercent: 0,
    })
  })

  it('names no discount on a game given away, whatever it used to cost', () => {
    const free = { amount: 0, regularAmount: 3999, discountPercent: 100 }
    expect(toStoreOffer(gogOffer(free), RATE)).toMatchObject({ isFree: true, discountPercent: 0 })
    const freeAtMicrosoft = microsoftOffer({ ...free, regularAmount: 38_500 })
    expect(toStoreOffer(freeAtMicrosoft, RATE)).toMatchObject({ isFree: true, discountPercent: 0 })
  })

  it('says a free game is free, and estimates nothing', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    expect(toStoreOffer(gogOffer(free), RATE)).toMatchObject({
      isFree: true,
      foreignPrice: { amount: 0, currency: 'USD' },
      approxUah: null,
    })
    expect(toStoreOffer(microsoftOffer(free), RATE)).toMatchObject({ isFree: true, priceUah: 0 })
  })

  it('has no title when the store gave none, or gave nothing but spaces', () => {
    const { title: _title, ...untitled } = gogOffer()
    expect(toStoreOffer(untitled, RATE).title).toBeNull()
    expect(toStoreOffer(gogOffer({ title: '   ' }), RATE).title).toBeNull()
    expect(toStoreOffer(gogOffer({ title: 42 as unknown as string }), RATE).title).toBeNull()
  })

  it('hands a title on as the text it is, markup and all, trimmed and no longer than the job cuts it', () => {
    const markup = '<img src=x onerror=alert(1)> Edition'
    expect(toStoreOffer(gogOffer({ title: `  ${markup}  ` }), RATE).title).toBe(markup)
    const long = toStoreOffer(gogOffer({ title: 'є'.repeat(MAX_OFFER_TITLE_LENGTH + 50) }), RATE)
    expect(long.title).toBe('є'.repeat(MAX_OFFER_TITLE_LENGTH))
    // Cut between characters, never through one.
    const emoji = toStoreOffer(gogOffer({ title: '🎮'.repeat(MAX_OFFER_TITLE_LENGTH + 1) }), RATE)
    expect(emoji.title).toBe('🎮'.repeat(MAX_OFFER_TITLE_LENGTH))
  })
})

describe('withStoreOffers', () => {
  const STEAM_URL = 'https://store.steampowered.com/app/292030/'
  const RAWG_GOG_URL = 'https://www.gog.com/game/the_witcher_3_wild_hunt'
  const rows = (): StoreOffer[] => [
    toSteamOffer(onSale, STEAM_URL),
    toStoreLink('gog', RAWG_GOG_URL),
    toStoreLink('playstation-store', 'https://store.playstation.com/x'),
  ]
  const holding = (...offers: IndexedOffer[]): IndexedGame =>
    indexed({ ...onSale, stores: ['steam', 'gog'], offers })

  it('puts a fresh offer on the row of its store, at the store’s own address for the product', () => {
    const priced = withStoreOffers(rows(), holding(gogOffer()), TERMS)
    expect(priced.map((row) => row.store)).toEqual(['steam', 'gog', 'playstation-store'])
    expect(priced[1]).toEqual(toStoreOffer(gogOffer(), RATE))
    expect(priced[1]!.url).toBe(GOG_URL)
  })

  it('leaves Steam’s row and every store without an offer exactly as they came', () => {
    const before = rows()
    const priced = withStoreOffers(before, holding(gogOffer()), TERMS)
    expect(priced[0]).toBe(before[0])
    expect(priced[2]).toBe(before[2])
  })

  it('adds no row for a store RAWG does not link', () => {
    const priced = withStoreOffers(rows(), holding(gogOffer(), microsoftOffer()), TERMS)
    expect(priced.map((row) => row.store)).toEqual(['steam', 'gog', 'playstation-store'])
  })

  it('leaves the link RAWG gave when the offer is too old to be a price', () => {
    const before = rows()
    const stale = withStoreOffers(before, holding(gogOffer({ updatedAt: TOO_OLD })), TERMS)
    expect(stale).toEqual(before)
    expect(stale[1]!.url).toBe(RAWG_GOG_URL)
  })

  it('takes an offer read thirty-six hours ago to the millisecond', () => {
    const edge = gogOffer({ updatedAt: '2026-10-11T00:00:00.000Z' })
    expect(withStoreOffers(rows(), holding(edge), TERMS)[1]!.foreignPrice).toEqual({
      amount: 8.99,
      currency: 'USD',
    })
  })

  it('prices a store RAWG links even when the document does not list the game on it', () => {
    // RAWG's own link is what says the game is sold there; the document's list is a night old.
    const unlisted = indexed({ ...onSale, stores: ['steam'], offers: [gogOffer()] })
    expect(withStoreOffers(rows(), unlisted, TERMS)[1]!.approxUah).toBe(404)
  })

  it('gives the offer to the first row when RAWG links one store twice', () => {
    const twice = [...rows(), toStoreLink('gog', 'https://www.gog.com/game/another_page')]
    const priced = withStoreOffers(twice, holding(gogOffer()), TERMS)
    expect(priced[1]!.approxUah).toBe(404)
    expect(priced[3]).toBe(twice[3])
  })

  it('changes nothing for a game the index does not hold, or a document without offers', () => {
    const before = rows()
    expect(withStoreOffers(before, null, TERMS)).toBe(before)
    expect(withStoreOffers(before, indexed(onSale), TERMS)).toBe(before)
  })
})

describe('withCheapest', () => {
  const steam = (priceUah: number | null): StoreOffer =>
    toSteamOffer(
      indexed({ priceUah, priceUpdatedAt: priceUah === null ? null : READ_AT }),
      'https://store.steampowered.com/app/1/',
    )
  const marked = (rows: StoreOffer[]): string[] =>
    withCheapest(rows)
      .filter((row) => row.cheapest)
      .map((row) => row.store)

  it('marks an estimate that is clearly below Steam’s price', () => {
    expect(marked([steam(675), toStoreOffer(gogOffer(), RATE)])).toEqual(['gog'])
  })

  it('marks Steam when its price is the lowest', () => {
    expect(marked([steam(400), toStoreOffer(gogOffer(), RATE)])).toEqual(['steam'])
    expect(marked([steam(300), toStoreOffer(microsoftOffer(), RATE)])).toEqual(['steam'])
  })

  it('marks a hryvnia store below Steam with no margin asked', () => {
    expect(marked([steam(386), toStoreOffer(microsoftOffer(), RATE)])).toEqual(['xbox-store'])
  })

  it('marks nothing when an estimate is less than five percent below Steam’s price', () => {
    expect(marked([steam(425), toStoreOffer(gogOffer(), RATE)])).toEqual([])
    expect(marked([steam(426), toStoreOffer(gogOffer(), RATE)])).toEqual(['gog'])
  })

  it('marks nothing on a tie, and nothing when one row has a price', () => {
    expect(marked([steam(385), toStoreOffer(microsoftOffer(), RATE)])).toEqual([])
    expect(marked([steam(404), toStoreOffer(gogOffer(), RATE)])).toEqual([])
    expect(marked([steam(675), toStoreLink('gog', GOG_URL)])).toEqual([])
    expect(marked([steam(null), toStoreOffer(gogOffer(), RATE)])).toEqual([])
    expect(marked([])).toEqual([])
  })

  it('leaves a dollar price that has no estimate out of it: there is no amount to weigh', () => {
    expect(marked([steam(675), toStoreOffer(gogOffer(), null)])).toEqual([])
    // Two other rows still have a price each, and are weighed as if it were not there.
    const rows = [steam(675), toStoreOffer(gogOffer(), null), toStoreOffer(microsoftOffer(), null)]
    expect(marked(rows)).toEqual(['xbox-store'])
  })

  it('marks no row when the lowest price is free, whatever the store charges in', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    // Not the free row, which says so itself, and not the row that charges, which is not lowest.
    expect(marked([steam(675), toStoreOffer(gogOffer(free), null)])).toEqual([])
    expect(marked([steam(675), toStoreOffer(microsoftOffer(free), null)])).toEqual([])
    expect(marked([steam(0), toStoreOffer(microsoftOffer(), RATE)])).toEqual([])
    expect(marked([steam(0), toStoreOffer(gogOffer(free), RATE)])).toEqual([])
    // A free row is still weighed: the 385 ₴ above it is not the cheapest of the three.
    const rows = [
      steam(675),
      toStoreOffer(gogOffer(free), RATE),
      toStoreOffer(microsoftOffer(), RATE),
    ]
    expect(marked(rows)).toEqual([])
  })

  it('marks a row that costs a single hryvnia: only nothing is free', () => {
    const hryvnia = { amount: 100, regularAmount: 100, discountPercent: 0 }
    expect(marked([steam(675), toStoreOffer(microsoftOffer(hryvnia), RATE)])).toEqual([
      'xbox-store',
    ])
  })

  it('takes the mark off a row that carried one', () => {
    const was = { ...toStoreOffer(gogOffer(), RATE), cheapest: true }
    expect(marked([steam(400), was])).toEqual(['steam'])
  })

  it('keeps the rows and their order, and changes nothing else on them', () => {
    const rows = [
      steam(675),
      toStoreLink('epic-games', 'https://x.test'),
      toStoreOffer(gogOffer(), RATE),
    ]
    const after = withCheapest(rows)
    expect(after.map(({ cheapest: _cheapest, ...row }) => row)).toEqual(
      rows.map(({ cheapest: _cheapest, ...row }) => row),
    )
  })
})

describe('exchangeRateOf', () => {
  it('is the rate an estimate on the page was made with, without the moment it was read', () => {
    expect(exchangeRateOf([toStoreOffer(gogOffer(), RATE)], RATE)).toEqual({
      currency: 'USD',
      uah: 44.9567,
      date: '2026-10-12',
    })
  })

  it('is nothing for a page with no estimate on it', () => {
    expect(exchangeRateOf([], RATE)).toBeNull()
    expect(exchangeRateOf([toStoreOffer(microsoftOffer(), RATE)], RATE)).toBeNull()
    expect(exchangeRateOf([toStoreLink('gog', GOG_URL)], RATE)).toBeNull()
    const free = gogOffer({ amount: 0, regularAmount: 0, discountPercent: 0 })
    expect(exchangeRateOf([toStoreOffer(free, RATE)], RATE)).toBeNull()
  })

  it('is nothing without a rate', () => {
    expect(exchangeRateOf([toStoreOffer(gogOffer(), null)], null)).toBeNull()
  })
})

describe('toGame, with what the other stores charge', () => {
  const witcher = (overrides: Partial<IndexedGame> = {}): IndexedGame =>
    indexed({
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      priceUpdatedAt: READ_AT,
      steamAppId: '292030',
      stores: ['steam', 'gog', 'xbox-store'],
      offers: [gogOffer(), microsoftOffer()],
      ...overrides,
    })

  it('shows the offers the document has, after Steam, and marks the cheapest', () => {
    const page = toGame(witcher(), TERMS)
    expect(page.stores.map((row) => row.store)).toEqual(['steam', 'gog', 'xbox-store'])
    expect(page.stores[1]).toEqual({ ...toStoreOffer(gogOffer(), RATE), cheapest: false })
    // 385 ₴ exact, against an estimate of 404 ₴ and Steam's 675 ₴.
    expect(page.stores[2]).toEqual({ ...toStoreOffer(microsoftOffer(), RATE), cheapest: true })
    expect(page.exchangeRate).toEqual({ currency: 'USD', uah: 44.9567, date: '2026-10-12' })
    expect(page.partial).toBe(true)
  })

  it('shows a hryvnia offer of the Microsoft Store on its own row', () => {
    const page = toGame(witcher({ offers: [microsoftOffer()] }), NO_RATE)
    expect(page.stores[1]).toMatchObject({
      store: 'xbox-store',
      url: MICROSOFT_URL,
      priceUah: 385,
      cheapest: true,
    })
    expect(page.exchangeRate).toBeNull()
  })

  it('shows a dollar price alone, and weighs it against nothing, when there is no rate', () => {
    const page = toGame(witcher({ offers: [gogOffer()] }), NO_RATE)
    expect(page.stores[1]).toMatchObject({
      foreignPrice: { amount: 8.99, currency: 'USD' },
      approxUah: null,
      cheapest: false,
    })
    expect(page.stores[0]!.cheapest).toBe(false)
    expect(page.exchangeRate).toBeNull()
  })

  it('makes a link of an offer that is too old to be a price', () => {
    const page = toGame(witcher({ offers: [gogOffer({ updatedAt: TOO_OLD })] }), TERMS)
    expect(page.stores[1]).toEqual({ ...NO_PRICE, store: 'gog', url: GOG_URL })
    expect(page.stores.some((row) => row.cheapest)).toBe(false)
    expect(page.exchangeRate).toBeNull()
  })

  it('makes links of every offer when it is given no terms, which is how they are withheld', () => {
    const page = toGame(witcher())
    expect(page.stores.slice(1)).toEqual([
      { ...NO_PRICE, store: 'gog', url: GOG_URL },
      { ...NO_PRICE, store: 'xbox-store', url: MICROSOFT_URL },
    ])
    expect(page.stores.some((row) => row.cheapest)).toBe(false)
    expect(page.exchangeRate).toBeNull()
  })

  it('shows no store the document does not list the game on, whatever offer it holds', () => {
    const page = toGame(witcher({ stores: ['steam', 'gog'] }), TERMS)
    expect(page.stores.map((row) => row.store)).toEqual(['steam', 'gog'])
  })

  it('shows the other stores of a game that has no Steam page', () => {
    const page = toGame(witcher({ steamAppId: undefined }), TERMS)
    expect(page.stores.map((row) => [row.store, row.cheapest])).toEqual([
      ['gog', false],
      ['xbox-store', true],
    ])
  })

  it('shows nothing of an offer it cannot read', () => {
    const broken = [gogOffer({ url: 'javascript:alert(1)' }), microsoftOffer({ amount: -1 })]
    expect(toGame(witcher({ offers: broken }), TERMS).stores.map((row) => row.store)).toEqual([
      'steam',
    ])
  })
})

/**
 * A card without the two fields the index document does not carry: the display names of platforms
 * and genres (the document keeps ids and slugs). `screenshots` is cut to its first element, which
 * is the only one anything reads — the card's hover preview — because the RAWG mapper keeps up to
 * four of them and the index document keeps exactly that one.
 */
function shared(card: GameCard): Omit<GameCard, (typeof RAWG_ONLY_CARD_FIELDS)[number]> {
  const { platforms: _p, genres: _g, ...rest } = card
  return { ...rest, screenshots: rest.screenshots.slice(0, 1) }
}
