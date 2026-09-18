import { describe, expect, it } from 'vitest'
import { mapGame, mapGameCard, mapGamePage, mapTaxonomy } from '../../server/rawg/mappers'
import games from '../fixtures/rawg/games.json'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json'
import stores from '../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json'

describe('mapGameCard', () => {
  it('maps a complete list item', () => {
    const card = mapGameCard(games.results[0]!)
    expect(card).toMatchObject({
      id: '3328',
      slug: 'the-witcher-3-wild-hunt',
      name: 'The Witcher 3: Wild Hunt',
      released: '2015-05-18',
      rating: 4.65,
      metacritic: 92,
      playtime: 43,
      price: null,
      localisation: null,
      madeInUkraine: false,
    })
    expect(card.platforms.map((p) => p.slug)).toEqual(['pc', 'playstation5', 'nintendo-switch'])
    expect(card.genres[0]).toEqual({ id: '4', slug: 'action', name: 'Action' })
  })

  it('survives null collections and missing values', () => {
    const card = mapGameCard(games.results[3]!)
    expect(card).toMatchObject({
      released: null,
      rating: null,
      metacritic: null,
      playtime: null,
      cover: null,
      platforms: [],
      genres: [],
    })
  })
})

describe('mapGame', () => {
  it('maps detail fields, modes, age rating and store links', () => {
    const game = mapGame(detail, stores.results)
    expect(game.description).toContain('monster slayer')
    expect(game.ageRating).toBe('PEGI18')
    expect(game.gameModes).toEqual(['SINGLE'])
    expect(game.developers[0]?.slug).toBe('cd-projekt-red')
    expect(game.website).toBe('https://thewitcher.com/en/witcher3')
    expect(game.stores).toEqual([
      {
        store: 'steam',
        url: 'https://store.steampowered.com/app/292030/',
        priceUah: null,
        regularPriceUah: null,
        discountPercent: null,
        updatedAt: null,
      },
      {
        store: 'gog',
        url: 'https://www.gog.com/game/the_witcher_3_wild_hunt',
        priceUah: null,
        regularPriceUah: null,
        discountPercent: null,
        updatedAt: null,
      },
    ])
    expect(game.screenshots).toEqual([])
    expect(game.similar).toEqual([])
  })

  it('drops store links with unknown stores or empty urls', () => {
    const game = mapGame(detail, [
      { store_id: 999, url: 'https://x.test' },
      { store_id: 1, url: '' },
    ])
    expect(game.stores).toEqual([])
  })
})

describe('mapTaxonomy / mapGamePage', () => {
  it('stringifies ids', () => {
    expect(mapTaxonomy({ id: 4, slug: 'pc', name: 'PC' })).toEqual({
      id: '4',
      slug: 'pc',
      name: 'PC',
    })
  })

  it('builds page metadata', () => {
    expect(mapGamePage({ count: 45, next: 'x' }, [], 2, 20)).toEqual({
      items: [],
      total: 45,
      page: 2,
      pageSize: 20,
      hasNext: true,
      indexedOnly: false,
    })
    expect(mapGamePage({ count: 45, next: null }, [], 3, 20).hasNext).toBe(false)
  })
})
