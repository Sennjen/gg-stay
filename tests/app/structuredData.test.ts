import { describe, expect, it } from 'vitest'
import {
  PRICE_FRESH_MS,
  coverShareImage,
  gameJsonLd,
  serializeJsonLd,
  websiteJsonLd,
  type GameForJsonLd,
} from '~/utils/structuredData'

const NOW = '2026-10-01T12:00:00.000Z'
const COVER = 'https://media.rawg.io/media/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg'

const witcher: GameForJsonLd = {
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  ratingsCount: 6800,
  cover: { url: COVER },
  platforms: [{ name: 'PC' }, { name: 'PlayStation 5' }],
  genres: [{ name: 'Action' }, { name: 'RPG' }],
  developers: [{ name: 'CD PROJEKT RED' }],
  publishers: [{ name: 'CD PROJEKT RED' }],
  stores: [
    {
      store: 'steam',
      url: 'https://store.steampowered.com/app/292030/',
      priceUah: 675,
      isFree: false,
      updatedAt: '2026-10-01T09:00:00.000Z',
    },
    { store: 'gog', url: 'https://www.gog.com/game/the_witcher_3_wild_hunt' },
  ],
}

const options = {
  url: 'https://gg-stay.vercel.app/games/the-witcher-3-wild-hunt',
  description: 'Ви — Ґеральт із Рівії, відьмак-мисливець на чудовиськ.',
  inLanguage: 'uk-UA',
  now: NOW,
}

describe('coverShareImage', () => {
  it('asks the CDN for the 1280 variant and states its size', () => {
    expect(coverShareImage(COVER)).toEqual({
      url: 'https://media.rawg.io/media/resize/1280/-/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg',
      width: 1280,
      height: 720,
    })
  })

  it('claims no size for an image it cannot resize', () => {
    expect(coverShareImage('https://example.com/cover.jpg')).toEqual({
      url: 'https://example.com/cover.jpg',
    })
  })

  it('has nothing for a game without a cover', () => {
    expect(coverShareImage(null)).toBeNull()
  })
})

describe('gameJsonLd', () => {
  it('describes the game with every field the page knows', () => {
    expect(gameJsonLd(witcher, options)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'VideoGame',
      name: 'The Witcher 3: Wild Hunt',
      url: options.url,
      image: 'https://media.rawg.io/media/resize/1280/-/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg',
      description: options.description,
      datePublished: '2015-05-18',
      genre: ['Action', 'RPG'],
      gamePlatform: ['PC', 'PlayStation 5'],
      publisher: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
      author: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: 4.65,
        ratingCount: 6800,
        bestRating: 5,
        worstRating: 0,
      },
      offers: {
        '@type': 'Offer',
        price: '675',
        priceCurrency: 'UAH',
        availability: 'https://schema.org/InStock',
        url: 'https://store.steampowered.com/app/292030/',
      },
      inLanguage: 'uk-UA',
    })
  })

  it('leaves the rating out below five ratings, where an average says little', () => {
    const data = gameJsonLd({ ...witcher, ratingsCount: 4 }, options)
    expect(data).not.toHaveProperty('aggregateRating')
    expect(gameJsonLd({ ...witcher, rating: 0 }, options)).not.toHaveProperty('aggregateRating')
  })

  it('offers the Steam price only while it is fresh', () => {
    const steam = witcher.stores[0]!
    const aged = new Date(Date.parse(NOW) - PRICE_FRESH_MS - 1).toISOString()
    const stale = { ...witcher, stores: [{ ...steam, updatedAt: aged }] }
    expect(gameJsonLd(stale, options)).not.toHaveProperty('offers')

    const undated = { ...witcher, stores: [{ ...steam, updatedAt: null }] }
    expect(gameJsonLd(undated, options)).not.toHaveProperty('offers')

    const unpriced = { ...witcher, stores: [{ ...steam, priceUah: null }] }
    expect(gameJsonLd(unpriced, options)).not.toHaveProperty('offers')

    const edge = new Date(Date.parse(NOW) - PRICE_FRESH_MS).toISOString()
    const justFresh = { ...witcher, stores: [{ ...steam, updatedAt: edge }] }
    expect(gameJsonLd(justFresh, options)).toHaveProperty('offers')
  })

  it('offers a free game at zero', () => {
    const free = { ...witcher, stores: [{ ...witcher.stores[0]!, priceUah: 0, isFree: true }] }
    expect(gameJsonLd(free, options).offers).toMatchObject({ price: '0', priceCurrency: 'UAH' })
  })

  it('leaves out what the game does not have, rather than writing empty values', () => {
    const bare: GameForJsonLd = {
      name: 'Unknown',
      released: null,
      rating: null,
      ratingsCount: null,
      cover: null,
      platforms: [],
      genres: [],
      developers: [],
      publishers: [],
      stores: [],
    }
    expect(gameJsonLd(bare, options)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'VideoGame',
      name: 'Unknown',
      url: options.url,
      description: options.description,
      inLanguage: 'uk-UA',
    })
  })
})

describe('websiteJsonLd', () => {
  it('describes the site and where its search lives, in the page language', () => {
    expect(
      websiteJsonLd({
        homeUrl: 'https://gg-stay.vercel.app/en',
        catalogUrl: 'https://gg-stay.vercel.app/en/games',
        description: 'Games for Ukrainian players.',
        inLanguage: 'en-US',
      }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'GG Stay',
      url: 'https://gg-stay.vercel.app/en',
      description: 'Games for Ukrainian players.',
      inLanguage: 'en-US',
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: 'https://gg-stay.vercel.app/en/games?search={search_term_string}',
        },
        'query-input': 'required name=search_term_string',
      },
    })
  })
})

describe('serializeJsonLd', () => {
  it('can never close the script element it is written into', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script>' })
    expect(json).not.toContain('<')
    expect(json).not.toContain('>')
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script>' })
  })

  it('escapes the characters an HTML or JavaScript parser could trip on, and nothing else', () => {
    const value = { text: 'a & b\u2028c\u2029d — Ґеральт' }
    const json = serializeJsonLd(value)
    expect(json).not.toMatch(/[&\u2028\u2029]/)
    expect(json).toContain('Ґеральт')
    expect(JSON.parse(json)).toEqual(value)
  })
})
