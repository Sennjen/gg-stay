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
  title: 'The Witcher 3: Wild Hunt — GG Stay',
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

/** The two nodes of the game page's graph. */
function nodes(game: GameForJsonLd, overrides: Partial<typeof options> = {}) {
  const data = gameJsonLd(game, { ...options, ...overrides })
  expect(data['@context']).toBe('https://schema.org')
  const graph = data['@graph'] as Record<string, unknown>[]
  expect(graph.map((node) => node['@type'])).toEqual(['WebPage', 'VideoGame'])
  return { page: graph[0]!, video: graph[1]! }
}

describe('gameJsonLd', () => {
  it('describes the page, in its language, with the game as its main entity', () => {
    expect(nodes(witcher).page).toEqual({
      '@type': 'WebPage',
      '@id': `${options.url}#webpage`,
      url: options.url,
      name: 'The Witcher 3: Wild Hunt — GG Stay',
      description: options.description,
      inLanguage: 'uk-UA',
      mainEntity: { '@id': `${options.url}#game` },
    })
  })

  it('describes the game with every field the page knows', () => {
    expect(nodes(witcher).video).toEqual({
      '@type': 'VideoGame',
      '@id': `${options.url}#game`,
      name: 'The Witcher 3: Wild Hunt',
      url: options.url,
      image:
        'https://media.rawg.io/media/resize/1280/-/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg',
      description: options.description,
      datePublished: '2015-05-18',
      genre: ['Action', 'RPG'],
      gamePlatform: ['PC', 'PlayStation 5'],
      publisher: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
      author: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
      offers: {
        '@type': 'Offer',
        price: '675',
        priceCurrency: 'UAH',
        availability: 'https://schema.org/InStock',
        url: 'https://store.steampowered.com/app/292030/',
      },
    })
  })

  it('never claims a language for the game itself: the page language is not the game’s', () => {
    // A game without Ukrainian localisation must not be declared Ukrainian because the page is.
    expect(nodes(witcher).video).not.toHaveProperty('inLanguage')
    expect(nodes(witcher, { inLanguage: 'en-US' }).page.inLanguage).toBe('en-US')
  })

  it('republishes no third-party rating', () => {
    // Google's review-snippet rules forbid aggregating ratings from other sites; RAWG's are.
    expect(nodes(witcher).video).not.toHaveProperty('aggregateRating')
  })

  it('offers the Steam price only while it is fresh', () => {
    const steam = witcher.stores[0]!
    const aged = new Date(Date.parse(NOW) - PRICE_FRESH_MS - 1).toISOString()
    const stale = { ...witcher, stores: [{ ...steam, updatedAt: aged }] }
    expect(nodes(stale).video).not.toHaveProperty('offers')

    const undated = { ...witcher, stores: [{ ...steam, updatedAt: null }] }
    expect(nodes(undated).video).not.toHaveProperty('offers')

    const unpriced = { ...witcher, stores: [{ ...steam, priceUah: null }] }
    expect(nodes(unpriced).video).not.toHaveProperty('offers')

    const edge = new Date(Date.parse(NOW) - PRICE_FRESH_MS).toISOString()
    const justFresh = { ...witcher, stores: [{ ...steam, updatedAt: edge }] }
    expect(nodes(justFresh).video).toHaveProperty('offers')
  })

  it('keeps an offer through one late nightly run', () => {
    // The index is refreshed nightly; a window of exactly a day would drop the offer whenever a
    // run is a little late.
    expect(PRICE_FRESH_MS).toBeGreaterThan(30 * 60 * 60 * 1000)
  })

  it('offers a game that is not out yet as a pre-order', () => {
    const upcoming = { ...witcher, released: '2026-12-01' }
    expect(nodes(upcoming).video.offers).toMatchObject({
      availability: 'https://schema.org/PreOrder',
    })
    const today = { ...witcher, released: NOW.slice(0, 10) }
    expect(nodes(today).video.offers).toMatchObject({
      availability: 'https://schema.org/InStock',
    })
  })

  it('offers a free game at zero', () => {
    const free = { ...witcher, stores: [{ ...witcher.stores[0]!, priceUah: 0, isFree: true }] }
    expect(nodes(free).video.offers).toMatchObject({ price: '0', priceCurrency: 'UAH' })
  })

  it('leaves out what the game does not have, rather than writing empty values', () => {
    const bare: GameForJsonLd = {
      name: 'Unknown',
      released: null,
      cover: null,
      platforms: [],
      genres: [],
      developers: [],
      publishers: [],
      stores: [],
    }
    expect(nodes(bare).video).toEqual({
      '@type': 'VideoGame',
      '@id': `${options.url}#game`,
      name: 'Unknown',
      url: options.url,
      description: options.description,
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
