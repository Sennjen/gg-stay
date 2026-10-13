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
import {
  DEV_FIXTURE_EXCHANGE_RATE,
  DEV_FIXTURE_GAMES,
  DEV_FIXTURE_UPDATED_AT,
} from '../../fixtures/index/devGames'
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
  /** The moment the development seed's run ended, and the rate it read: its offers are current. */
  const SEEDED: OfferTerms = { now: DEV_FIXTURE_UPDATED_AT, rate: DEV_FIXTURE_EXCHANGE_RATE }

  it('refuses a cover URL whose scheme is not allowed, like the RAWG mapper does', () => {
    expect(toGameCard(indexed({ cover: 'javascript:alert(1)' }), SEEDED).cover).toBeNull()
  })

  it('derives the platform families from the indexed platform ids', () => {
    expect(toGameCard(indexed({ platforms: [4, 187, 7] }), SEEDED).platformFamilies).toEqual([
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

      const fromIndex = toGameCard(document, SEEDED)
      // The RAWG path attaches the price, the store that is cheaper, localisation and the
      // made-in-Ukraine flag from the same index document, so the comparison starts from a RAWG
      // card that has had them attached.
      const fromRawg: GameCard = {
        ...mapGameCard(raw!),
        price: fromIndex.price,
        cheaperAt: fromIndex.cheaperAt,
        localisation: fromIndex.localisation,
        madeInUkraine: fromIndex.madeInUkraine,
      }
      expect(shared(fromIndex)).toEqual(shared(fromRawg))
    }
  })

  it('names the store that is clearly cheaper than Steam, and none on a card without one', () => {
    // The seed's own cases: GOG at about 404 ₴ against Steam's 675 ₴; no offer at all; and the
    // Microsoft Store at 385 ₴ against a game Steam gives away.
    const named = DEV_FIXTURE_GAMES.map((game) => [game.slug, toGameCard(game, SEEDED).cheaperAt])
    expect(named).toEqual([
      ['the-witcher-3-wild-hunt', 'gog'],
      ['portal-2', null],
      ['stardew-valley', null],
    ])
    // Without a rate there is no hryvnia amount to weigh GOG's dollars by.
    expect(toGameCard(DEV_FIXTURE_GAMES[0]!, { ...SEEDED, rate: null }).cheaperAt).toBeNull()
    // A card RAWG mapped starts with none, like its price: the index attaches both.
    const list = rawgGames as unknown as RawgList<RawgGameListItem>
    expect(mapGameCard(list.results![0]!)).toMatchObject({ price: null, cheaperAt: null })
  })

  it('leaves the fields the index document does not carry empty', () => {
    const card = toGameCard(indexed(), SEEDED)
    expect(card.platforms).toEqual([])
    expect(card.genres).toEqual([])
    expect(RAWG_ONLY_CARD_FIELDS).toEqual(['platforms', 'genres'])
  })

  it('serves the indexed preview as the card hover preview, and nothing when there is none', () => {
    expect(toGameCard(indexed(), SEEDED).screenshots).toEqual([
      { url: 'https://media.rawg.io/media/screenshots/7.jpg', width: null, height: null },
    ])
    expect(toGameCard(indexed({ preview: null }), SEEDED).screenshots).toEqual([])
    expect(toGameCard(indexed({ preview: 'javascript:alert(1)' }), SEEDED).screenshots).toEqual([])
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

/** The row of an offer whose address is sound, which is every offer here that no case breaks. */
const rowOf = (offer: IndexedOffer, rate: IndexedExchangeRate | null): StoreOffer => {
  const row = toStoreOffer(offer, rate)
  if (!row) throw new Error('the offer has no address a row could carry')
  return row
}

describe('toStoreOffer', () => {
  it.each([
    ['a script', 'javascript:alert(1)'],
    ['a data address', 'data:text/html,<script>alert(1)</script>'],
    ['an address with no scheme', '//www.gog.com/en/game/the_witcher_3_wild_hunt'],
    ['a path', '/en/game/the_witcher_3_wild_hunt'],
    ['nothing', ''],
    ['no string at all', undefined],
  ])(
    'has no row for an offer whose address is %s: what the allow-list refuses is not handed on',
    (_what, url) => {
      // A fresh price, a title, everything a row needs but somewhere to send a visitor.
      expect(toStoreOffer(gogOffer({ url: url as string }), RATE)).toBeNull()
      expect(toStoreOffer(microsoftOffer({ url: url as string }), RATE)).toBeNull()
    },
  )

  it('carries the address as the allow-list hands it back, not as the document held it', () => {
    const row = toStoreOffer(gogOffer({ url: 'https://user:secret@www.gog.com/en/game/x' }), RATE)
    expect(row?.url).toBe('https://www.gog.com/en/game/x')
  })

  it('puts a dollar price in the foreign fields, with an estimate, and never in the hryvnia ones', () => {
    expect(rowOf(gogOffer(), RATE)).toEqual({
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
    expect(rowOf(gogOffer(), null)).toMatchObject({
      foreignPrice: { amount: 8.99, currency: 'USD' },
      approxUah: null,
      priceUah: null,
    })
  })

  it('puts a hryvnia price in the fields Steam’s price fills, in whole hryvnia', () => {
    expect(rowOf(microsoftOffer(), RATE)).toEqual({
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
    expect(rowOf(halo, null)).toMatchObject({
      priceUah: 508,
      regularPriceUah: 1540,
      discountPercent: 67,
    })
  })

  it('strikes nothing through when the game is not on sale, in either currency', () => {
    const full = gogOffer({ amount: 2999, regularAmount: 2999, discountPercent: 0 })
    expect(rowOf(full, RATE)).toMatchObject({
      foreignPrice: { amount: 29.99, currency: 'USD' },
      foreignRegularPrice: null,
      discountPercent: 0,
      approxUah: 1348,
    })
    expect(rowOf(microsoftOffer(), RATE)).toMatchObject({ regularPriceUah: null })
  })

  it('names no discount an offer cannot show the price before', () => {
    const odd = gogOffer({ amount: 899, regularAmount: 899, discountPercent: 78 })
    expect(rowOf(odd, RATE)).toMatchObject({ discountPercent: 0, foreignRegularPrice: null })
  })

  it.each([
    [0, 'a discount of nothing'],
    [100, 'a discount of everything, on a price that is not zero'],
  ])(
    'keeps the higher regular price and names no discount of %i %%: %s is not a chip',
    (discountPercent, _what) => {
      // What a document can carry until the job clamps it: the amounts are the store's own, and
      // the percent beside them is not one a page may draw.
      expect(rowOf(gogOffer({ discountPercent }), RATE)).toMatchObject({
        foreignPrice: { amount: 8.99, currency: 'USD' },
        foreignRegularPrice: { amount: 39.99, currency: 'USD' },
        discountPercent: 0,
      })
      const microsoft = microsoftOffer({ amount: 19_250, regularAmount: 38_500, discountPercent })
      expect(rowOf(microsoft, RATE)).toMatchObject({
        priceUah: 193,
        regularPriceUah: 385,
        discountPercent: 0,
      })
    },
  )

  it.each([1, 50, 99])('names a discount of %i %% beside a higher regular price', (percent) => {
    expect(rowOf(gogOffer({ discountPercent: percent }), RATE).discountPercent).toBe(percent)
    const microsoft = microsoftOffer({
      amount: 100,
      regularAmount: 38_500,
      discountPercent: percent,
    })
    expect(rowOf(microsoft, RATE).discountPercent).toBe(percent)
  })

  it('strikes nothing through when a hryvnia price rounds onto its regular price', () => {
    // 384.60 ₴ down from 385 ₴: both are 385 ₴ on the page, and that is no sale to show.
    const barely = microsoftOffer({ amount: 38_460, regularAmount: 38_500, discountPercent: 1 })
    expect(rowOf(barely, RATE)).toMatchObject({
      priceUah: 385,
      regularPriceUah: null,
      discountPercent: 0,
    })
  })

  it('names no discount on a game given away, whatever it used to cost', () => {
    const free = { amount: 0, regularAmount: 3999, discountPercent: 100 }
    expect(rowOf(gogOffer(free), RATE)).toMatchObject({ isFree: true, discountPercent: 0 })
    const freeAtMicrosoft = microsoftOffer({ ...free, regularAmount: 38_500 })
    expect(rowOf(freeAtMicrosoft, RATE)).toMatchObject({ isFree: true, discountPercent: 0 })
  })

  it('says a free game is free, and estimates nothing', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    expect(rowOf(gogOffer(free), RATE)).toMatchObject({
      isFree: true,
      foreignPrice: { amount: 0, currency: 'USD' },
      approxUah: null,
    })
    expect(rowOf(microsoftOffer(free), RATE)).toMatchObject({ isFree: true, priceUah: 0 })
  })

  it('has no title when the store gave none, or gave nothing but spaces', () => {
    const { title: _title, ...untitled } = gogOffer()
    expect(rowOf(untitled, RATE).title).toBeNull()
    expect(rowOf(gogOffer({ title: '   ' }), RATE).title).toBeNull()
    expect(rowOf(gogOffer({ title: 42 as unknown as string }), RATE).title).toBeNull()
  })

  it('hands a title on as the text it is, markup and all, trimmed and no longer than the job cuts it', () => {
    const markup = '<img src=x onerror=alert(1)> Edition'
    expect(rowOf(gogOffer({ title: `  ${markup}  ` }), RATE).title).toBe(markup)
    const long = rowOf(gogOffer({ title: 'є'.repeat(MAX_OFFER_TITLE_LENGTH + 50) }), RATE)
    expect(long.title).toBe('є'.repeat(MAX_OFFER_TITLE_LENGTH))
    // Cut between characters, never through one.
    const emoji = rowOf(gogOffer({ title: '🎮'.repeat(MAX_OFFER_TITLE_LENGTH + 1) }), RATE)
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
    expect(priced[1]).toEqual(rowOf(gogOffer(), RATE))
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

  it('leaves the PlayStation Store’s row the link RAWG gave, whatever the document holds for it', () => {
    // The job publishes that store's offers before any page knows its rules (`PAGE_OFFER_STORES`).
    const playstation: IndexedOffer = {
      store: 'playstation-store',
      title: 'Grand Theft Auto Online (PlayStation\u00AE5)',
      amount: 89_900,
      regularAmount: 89_900,
      currency: 'UAH',
      discountPercent: 0,
      url: 'https://store.playstation.com/uk-ua/product/EP1004-PPSA01721_00-GTAOSTANDALONE01',
      updatedAt: gogOffer().updatedAt,
    }
    const before = rows()
    const priced = withStoreOffers(before, holding(gogOffer(), playstation), TERMS)

    expect(priced[2]).toBe(before[2])
    expect(priced[2]).toMatchObject({ url: 'https://store.playstation.com/x' })
    expect(priced[2]!.priceUah ?? null).toBeNull()
    // The row it does know is priced as ever.
    expect(priced[1]).toEqual(rowOf(gogOffer(), RATE))
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
  /** Steam's row at `priceUah`, read six hours ago unless a case dates it otherwise. */
  const steam = (priceUah: number | null, priceUpdatedAt: string = READ_AT): StoreOffer =>
    toSteamOffer(
      indexed({ priceUah, priceUpdatedAt: priceUah === null ? null : priceUpdatedAt }),
      'https://store.steampowered.com/app/1/',
    )
  const marked = (rows: StoreOffer[]): string[] =>
    withCheapest(rows, NOW)
      .filter((row) => row.cheapest)
      .map((row) => row.store)

  it('marks an estimate that is clearly below Steam’s price', () => {
    expect(marked([steam(675), rowOf(gogOffer(), RATE)])).toEqual(['gog'])
  })

  it('marks Steam when its price is the lowest', () => {
    expect(marked([steam(400), rowOf(gogOffer(), RATE)])).toEqual(['steam'])
    expect(marked([steam(300), rowOf(microsoftOffer(), RATE)])).toEqual(['steam'])
  })

  it('marks a hryvnia store below Steam with no margin asked', () => {
    expect(marked([steam(386), rowOf(microsoftOffer(), RATE)])).toEqual(['xbox-store'])
  })

  it('marks nothing when an estimate is less than five percent below Steam’s price', () => {
    expect(marked([steam(425), rowOf(gogOffer(), RATE)])).toEqual([])
    expect(marked([steam(426), rowOf(gogOffer(), RATE)])).toEqual(['gog'])
  })

  it('marks nothing on a tie, and nothing when one row has a price', () => {
    expect(marked([steam(385), rowOf(microsoftOffer(), RATE)])).toEqual([])
    expect(marked([steam(404), rowOf(gogOffer(), RATE)])).toEqual([])
    expect(marked([steam(675), toStoreLink('gog', GOG_URL)])).toEqual([])
    expect(marked([steam(null), rowOf(gogOffer(), RATE)])).toEqual([])
    expect(marked([])).toEqual([])
  })

  it('marks no row while a fresh dollar price has no estimate: it may be the lowest on the page', () => {
    // Steam 675 ₴, the Xbox Store 385 ₴, GOG $8.99 and no rate to place it by. 385 ₴ is the
    // lowest of what can be weighed, and "cheapest" beside a dollar price nobody can place is
    // a claim the page cannot make.
    const unplaced = rowOf(gogOffer(), null)
    expect(marked([steam(675), unplaced])).toEqual([])
    expect(marked([steam(675), unplaced, rowOf(microsoftOffer(), null)])).toEqual([])
    expect(marked([steam(300), unplaced, rowOf(microsoftOffer(), null)])).toEqual([])
    // With a rate the same three rows are weighed as ever.
    const placed = rowOf(gogOffer(), RATE)
    expect(marked([steam(675), placed, rowOf(microsoftOffer(), RATE)])).toEqual(['xbox-store'])
  })

  it('is not silenced by a dollar price that is free, or by one that is no longer fresh', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    const hryvnia = { amount: 100, regularAmount: 100, discountPercent: 0 }
    // Nothing needs no rate: the free row is weighed, and what it does to the mark is its own
    // rule (the lowest is free, so no row is marked).
    expect(marked([steam(675), rowOf(gogOffer(free), null)])).toEqual([])
    // A dollar price under a date too old to be a price is not on a page at all; made by hand
    // here, it takes no part and is in nobody's way.
    const old = { ...rowOf(gogOffer(), null), updatedAt: TOO_OLD }
    expect(marked([steam(675), old, rowOf(microsoftOffer(hryvnia), null)])).toEqual(['xbox-store'])
  })

  it('marks no row when the lowest price is free, whatever the store charges in', () => {
    const free = { amount: 0, regularAmount: 0, discountPercent: 0 }
    // Not the free row, which says so itself, and not the row that charges, which is not lowest.
    expect(marked([steam(675), rowOf(gogOffer(free), null)])).toEqual([])
    expect(marked([steam(675), rowOf(microsoftOffer(free), null)])).toEqual([])
    expect(marked([steam(0), rowOf(microsoftOffer(), RATE)])).toEqual([])
    expect(marked([steam(0), rowOf(gogOffer(free), RATE)])).toEqual([])
    // A free row is still weighed: the 385 ₴ above it is not the cheapest of the three.
    const rows = [steam(675), rowOf(gogOffer(free), RATE), rowOf(microsoftOffer(), RATE)]
    expect(marked(rows)).toEqual([])
  })

  it('marks a row that costs a single hryvnia: only nothing is free', () => {
    const hryvnia = { amount: 100, regularAmount: 100, discountPercent: 0 }
    expect(marked([steam(675), rowOf(microsoftOffer(hryvnia), RATE)])).toEqual(['xbox-store'])
  })

  it('takes the mark off a row that carried one', () => {
    const was = { ...rowOf(gogOffer(), RATE), cheapest: true }
    expect(marked([steam(400), was])).toEqual(['steam'])
  })

  it('keeps the rows and their order, and changes nothing else on them', () => {
    const rows = [steam(675), toStoreLink('epic-games', 'https://x.test'), rowOf(gogOffer(), RATE)]
    const after = withCheapest(rows, NOW)
    expect(after.map(({ cheapest: _cheapest, ...row }) => row)).toEqual(
      rows.map(({ cheapest: _cheapest, ...row }) => row),
    )
  })

  describe('among fresh prices only', () => {
    /** Thirty-six hours before `NOW`, to the millisecond: the oldest a price may be and count. */
    const JUST_FRESH = '2026-10-11T00:00:00.000Z'
    const SIX_WEEKS_AGO = '2026-09-01T12:00:00.000Z'
    const gog = () => rowOf(gogOffer(), RATE)
    const microsoft = () => rowOf(microsoftOffer(), RATE)

    it('does not mark a Steam price older than an offer may be, however low it is', () => {
      // Steam stopped answering for the game weeks ago, at 300 ₴; GOG was read this morning at
      // about 404 ₴. The page shows both. It does not say the old one is the cheapest.
      expect(marked([steam(300, SIX_WEEKS_AGO), gog()])).toEqual([])
      expect(marked([steam(300, TOO_OLD), gog()])).toEqual([])
    })

    it('does not mark another store against a Steam price that old either: it is no yardstick', () => {
      // The sale it was read during may be over, and so may the reason GOG looks cheaper.
      expect(marked([steam(675, SIX_WEEKS_AGO), gog()])).toEqual([])
      expect(marked([steam(675, TOO_OLD), gog()])).toEqual([])
    })

    it('weighs a Steam price read thirty-six hours ago to the millisecond', () => {
      expect(marked([steam(675, JUST_FRESH), gog()])).toEqual(['gog'])
      expect(marked([steam(300, JUST_FRESH), gog()])).toEqual(['steam'])
    })

    it('still weighs the fresh rows against each other beside an old one', () => {
      // 385 ₴ exact against an estimate of 404 ₴; the 300 ₴ from six weeks ago is not in it.
      expect(marked([steam(300, SIX_WEEKS_AGO), gog(), microsoft()])).toEqual(['xbox-store'])
    })

    it('leaves a price dated ahead of the clock out, past five minutes', () => {
      // 12:05:00.000 is believed; a millisecond later is a date nothing can be said of.
      expect(marked([steam(300, '2026-10-12T12:05:00.000Z'), gog()])).toEqual(['steam'])
      expect(marked([steam(300, '2026-10-12T12:05:00.001Z'), gog()])).toEqual([])
      expect(marked([steam(300, '2027-06-01T00:00:00.000Z'), gog()])).toEqual([])
    })

    it('leaves a price with no date, or one that is not a date, out', () => {
      for (const updatedAt of [null, 'yesterday', '']) {
        expect(marked([{ ...steam(300), updatedAt }, gog()]), String(updatedAt)).toEqual([])
      }
    })

    it('weighs the same rows differently as the clock moves on, and changes nothing else', () => {
      const rows = [steam(300), gog()]
      const at = (now: string) => withCheapest(rows, now).map((row) => row.cheapest)
      // Both read at 06:00 on the 12th. Fresh at noon; thirty-six hours on, neither is.
      expect(at(NOW)).toEqual([true, false])
      expect(at('2026-10-13T18:00:00.000Z')).toEqual([true, false])
      expect(at('2026-10-13T18:00:00.001Z')).toEqual([false, false])
    })
  })
})

describe('exchangeRateOf', () => {
  it('is the rate an estimate on the page was made with, without the moment it was read', () => {
    expect(exchangeRateOf([rowOf(gogOffer(), RATE)], RATE)).toEqual({
      currency: 'USD',
      uah: 44.9567,
      date: '2026-10-12',
    })
  })

  it('is nothing for a page with no estimate on it', () => {
    expect(exchangeRateOf([], RATE)).toBeNull()
    expect(exchangeRateOf([rowOf(microsoftOffer(), RATE)], RATE)).toBeNull()
    expect(exchangeRateOf([toStoreLink('gog', GOG_URL)], RATE)).toBeNull()
    const free = gogOffer({ amount: 0, regularAmount: 0, discountPercent: 0 })
    expect(exchangeRateOf([rowOf(free, RATE)], RATE)).toBeNull()
  })

  it('is nothing without a rate', () => {
    expect(exchangeRateOf([rowOf(gogOffer(), null)], null)).toBeNull()
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
    expect(page.stores[1]).toEqual({ ...rowOf(gogOffer(), RATE), cheapest: false })
    // 385 ₴ exact, against an estimate of 404 ₴ and Steam's 675 ₴.
    expect(page.stores[2]).toEqual({ ...rowOf(microsoftOffer(), RATE), cheapest: true })
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
