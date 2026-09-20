import { describe, expect, it } from 'vitest'
import type { IndexedGame } from '../../../server/index/document'
import type { GameCard } from '../../../server/graphql/__generated__/resolvers-types'
import {
  RAWG_ONLY_CARD_FIELDS,
  toGameCard,
  toLocalisationInfo,
  toPriceSummary,
  toSteamOffer,
} from '../../../server/index/toGraphql'
import { mapGameCard } from '../../../server/rawg/mappers'
import { DEV_FIXTURE_GAMES } from '../../fixtures/index/devGames'
import rawgGames from '../../fixtures/rawg/games.json' with { type: 'json' }
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
      store: 'steam',
      url: 'https://store.steampowered.com/app/1/',
      priceUah: null,
      regularPriceUah: null,
      discountPercent: null,
      isFree: null,
      updatedAt: null,
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
