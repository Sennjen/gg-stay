import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { childText, childrenNamed, parseXml } from '../server/support/xml'

// Build-time default and runtime override, so the server under test never calls RAWG.
process.env.RAWG_FIXTURES = '1'

/**
 * What a search engine reads, per page type, from the server HTML alone: the title, the
 * description and its language, the canonical and hreflang links, the robots rules, the Open Graph
 * and Twitter tags and the JSON-LD — and the sitemap and robots.txt that lead a crawler to them.
 */

const SITE = 'http://localhost:3000'
const CYRILLIC = /[А-ЩЬЮЯҐЄІЇа-щьюяґєії]/

interface Head {
  status: number
  lang: string | undefined
  title: string | undefined
  meta: Record<string, string>[]
  links: Record<string, string>[]
  jsonLd: Record<string, unknown>[]
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function attributesOf(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, decode(value!)]),
  )
}

async function headOf(path: string): Promise<Head> {
  const response = await fetch(path, { headers: { accept: 'text/html' } })
  const html = await response.text()
  const head = html.slice(0, html.indexOf('</head>'))
  return {
    status: response.status,
    lang: /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1],
    title: /<title>([^<]*)<\/title>/.exec(head)?.[1]?.replace(/&amp;/g, '&'),
    meta: [...head.matchAll(/<meta\s[^>]*>/g)].map(([tag]) => attributesOf(tag)),
    links: [...head.matchAll(/<link\s[^>]*>/g)].map(([tag]) => attributesOf(tag)),
    jsonLd: [
      ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
    ].map(([, body]) => JSON.parse(body!) as Record<string, unknown>),
  }
}

const metaName = (head: Head, name: string) => head.meta.find((m) => m.name === name)?.content
const metaProperty = (head: Head, property: string) =>
  head.meta.filter((m) => m.property === property).map((m) => m.content)
const og = (head: Head, property: string) => metaProperty(head, property)[0]
const canonical = (head: Head) => head.links.find((l) => l.rel === 'canonical')?.href
const alternate = (head: Head, hreflang: string) =>
  head.links.find((l) => l.rel === 'alternate' && l.hreflang === hreflang)?.href

interface PageCase {
  path: string
  locale: 'uk' | 'en'
  canonical: string
  /** The default-locale and English URLs of the same page. */
  pair: [string, string]
  robots: string
}

const INDEXABLE = 'index, follow, max-image-preview:large'
const NOT_INDEXABLE = 'noindex, follow'
const GAME = '/games/the-witcher-3-wild-hunt'

const PAGES: PageCase[] = [
  { path: '/', locale: 'uk', canonical: SITE, pair: [SITE, `${SITE}/en`], robots: INDEXABLE },
  {
    path: '/en',
    locale: 'en',
    canonical: `${SITE}/en`,
    pair: [SITE, `${SITE}/en`],
    robots: INDEXABLE,
  },
  {
    path: '/games',
    locale: 'uk',
    canonical: `${SITE}/games`,
    pair: [`${SITE}/games`, `${SITE}/en/games`],
    robots: INDEXABLE,
  },
  {
    path: '/en/games',
    locale: 'en',
    canonical: `${SITE}/en/games`,
    pair: [`${SITE}/games`, `${SITE}/en/games`],
    robots: INDEXABLE,
  },
  {
    path: '/games?ukrainianLocalisation=AUDIO&platforms=4',
    locale: 'uk',
    canonical: `${SITE}/games`,
    pair: [`${SITE}/games`, `${SITE}/en/games`],
    robots: NOT_INDEXABLE,
  },
  {
    path: '/en/games?ukrainianLocalisation=AUDIO&platforms=4',
    locale: 'en',
    canonical: `${SITE}/en/games`,
    pair: [`${SITE}/games`, `${SITE}/en/games`],
    robots: NOT_INDEXABLE,
  },
  {
    path: '/games?page=2',
    locale: 'uk',
    canonical: `${SITE}/games`,
    pair: [`${SITE}/games`, `${SITE}/en/games`],
    robots: NOT_INDEXABLE,
  },
  {
    path: GAME,
    locale: 'uk',
    canonical: `${SITE}${GAME}`,
    pair: [`${SITE}${GAME}`, `${SITE}/en${GAME}`],
    robots: INDEXABLE,
  },
  {
    path: `/en${GAME}`,
    locale: 'en',
    canonical: `${SITE}/en${GAME}`,
    pair: [`${SITE}${GAME}`, `${SITE}/en${GAME}`],
    robots: INDEXABLE,
  },
]

describe('SEO: what a crawler reads', async () => {
  await setup({
    server: true,
    browser: false,
    env: { RAWG_FIXTURES: '1', NUXT_RAWG_FIXTURES: '1' },
  })

  describe.each(PAGES)('$path', (page) => {
    it('has a title that names the site, and a description in the page language', async () => {
      const head = await headOf(page.path)
      expect(head.status).toBe(200)
      expect(head.lang).toBe(page.locale === 'uk' ? 'uk-UA' : 'en-US')
      if (page.path === '/' || page.path === '/en') expect(head.title).toMatch(/^GG Stay — /)
      else expect(head.title).toMatch(/ — GG Stay$/)

      const description = metaName(head, 'description')
      expect(description?.length).toBeGreaterThan(40)
      expect(description!.length).toBeLessThanOrEqual(160)
      if (page.locale === 'uk') expect(description).toMatch(CYRILLIC)
      else expect(description).not.toMatch(CYRILLIC)
    })

    it('links its absolute canonical and the uk/en pair, and says whether to index it', async () => {
      const head = await headOf(page.path)
      expect(canonical(head)).toBe(page.canonical)
      expect(alternate(head, 'uk')).toBe(page.pair[0])
      expect(alternate(head, 'en')).toBe(page.pair[1])
      expect(alternate(head, 'x-default')).toBe(page.pair[0])
      expect(metaName(head, 'robots')).toBe(page.robots)
    })

    it('carries the Open Graph and Twitter tags of a large preview card', async () => {
      const head = await headOf(page.path)
      expect(og(head, 'og:type')).toBe('website')
      expect(og(head, 'og:site_name')).toBe('GG Stay')
      expect(og(head, 'og:url')).toBe(page.canonical)
      expect(og(head, 'og:title')).toBeTruthy()
      expect(og(head, 'og:description')).toBe(metaName(head, 'description'))
      expect(og(head, 'og:locale')).toBe(page.locale === 'uk' ? 'uk_UA' : 'en_US')
      expect(metaProperty(head, 'og:locale:alternate')).toEqual([
        page.locale === 'uk' ? 'en_US' : 'uk_UA',
      ])
      expect(og(head, 'og:image')).toMatch(/^https?:\/\//)
      expect(Number(og(head, 'og:image:width'))).toBeGreaterThan(0)
      expect(Number(og(head, 'og:image:height'))).toBeGreaterThan(0)
      expect(metaName(head, 'twitter:card')).toBe('summary_large_image')
    })
  })

  it('gives every page a title of its own', async () => {
    const titles = await Promise.all(PAGES.map(async (page) => (await headOf(page.path)).title))
    // The two game pages share the game's own name, which is the right title in both languages.
    const distinct = new Set(titles.filter((title) => !title?.startsWith('The Witcher 3')))
    expect(distinct.size).toBe(PAGES.length - 2)
  })

  it('describes a filtered catalog page by its filters, in the words its chips use', async () => {
    const head = await headOf('/games?ukrainianLocalisation=AUDIO&platforms=4')
    expect(head.title).toBe('Ігри (PC, Українська: озвучка) — GG Stay')
    expect(metaName(head, 'description')).toContain('PC, Українська: озвучка')
    const english = await headOf('/en/games?ukrainianLocalisation=AUDIO&platforms=4')
    expect(english.title).toBe('Games (PC, Ukrainian: voice acting) — GG Stay')
  })

  it('numbers a later catalog page in its title', async () => {
    expect((await headOf('/games?page=2')).title).toBe('Каталог ігор, сторінка 2 — GG Stay')
  })

  it('shares the landing as its own static card', async () => {
    for (const path of ['/', '/en']) {
      const head = await headOf(path)
      expect(og(head, 'og:image')).toBe(`${SITE}/og.png`)
      expect(og(head, 'og:image:width')).toBe('1200')
      expect(og(head, 'og:image:height')).toBe('630')
      expect(og(head, 'og:image:alt')).toBeTruthy()
    }
    const image = await fetch('/og.png')
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
  })

  it('shares a game page as the 1280 variant of its cover', async () => {
    const head = await headOf(GAME)
    expect(og(head, 'og:image')).toBe(
      'https://media.rawg.io/media/resize/1280/-/games/618/618c2031a07bbff6b4f611f10b6bcdbc.jpg',
    )
    expect(og(head, 'og:image:width')).toBe('1280')
    expect(og(head, 'og:image:height')).toBe('720')
  })

  it('describes the Ukrainian game page with the Ukrainian description it shows', async () => {
    const description = metaName(await headOf(GAME), 'description')!
    // Steam's "Про гру" heading is skipped; the sentence after it is what the page is about.
    expect(description).toMatch(/^Ви — Ґеральт із Рівії, відьмак-мисливець на чудовиськ\./)
    expect(description.endsWith('…')).toBe(true)
    const english = metaName(await headOf(`/en${GAME}`), 'description')!
    expect(english).toMatch(/^The third game in a series/)
  })

  it('emits the landing JSON-LD: the site and its catalog search', async () => {
    for (const [path, home, language] of [
      ['/', SITE, 'uk-UA'],
      ['/en', `${SITE}/en`, 'en-US'],
    ] as const) {
      const [website, ...rest] = (await headOf(path)).jsonLd
      expect(rest).toEqual([])
      expect(website).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'GG Stay',
        url: home,
        inLanguage: language,
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${home === SITE ? SITE : home}/games?search={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      })
    }
  })

  it('emits the game JSON-LD with every required field', async () => {
    for (const [path, language] of [
      [GAME, 'uk-UA'],
      [`/en${GAME}`, 'en-US'],
    ] as const) {
      const head = await headOf(path)
      const [game, ...rest] = head.jsonLd
      expect(rest).toEqual([])
      expect(game).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: 'The Witcher 3: Wild Hunt',
        url: canonical(head),
        image: og(head, 'og:image'),
        description: metaName(head, 'description'),
        datePublished: '2015-05-18',
        genre: ['Action', 'RPG'],
        gamePlatform: expect.arrayContaining(['PC']),
        publisher: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
        author: [{ '@type': 'Organization', name: 'CD PROJEKT RED' }],
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: 4.65,
          ratingCount: 6800,
          bestRating: 5,
          worstRating: 0,
        },
        // The fixture index is published as of the server's start, so its price is fresh.
        offers: {
          '@type': 'Offer',
          price: '675',
          priceCurrency: 'UAH',
          availability: 'https://schema.org/InStock',
          url: 'https://store.steampowered.com/app/292030/',
        },
        inLanguage: language,
      })
    }
  })

  it('emits no JSON-LD on the catalog, where there is no single thing to describe', async () => {
    expect((await headOf('/games')).jsonLd).toEqual([])
  })

  it('keeps a missing page out of the index, in the language of the URL', async () => {
    for (const [path, lang, title] of [
      ['/games/does-not-exist', 'uk-UA', 'Сторінку не знайдено — GG Stay'],
      ['/en/games/does-not-exist', 'en-US', 'Page not found — GG Stay'],
    ] as const) {
      const head = await headOf(path)
      expect(head.status).toBe(404)
      expect(head.lang).toBe(lang)
      expect(head.title).toBe(title)
      expect(metaName(head, 'robots')).toBe('noindex')
      expect(metaName(head, 'description')).toBeTruthy()
      // Nothing to point at: a missing page has no canonical and no alternates.
      expect(canonical(head)).toBeUndefined()
      expect(alternate(head, 'en')).toBeUndefined()
    }
  })

  describe('the sitemap', () => {
    it('is an index of the static file and the game files, cached for six hours', async () => {
      const response = await fetch('/sitemap.xml')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('public, max-age=21600, s-maxage=21600')
      const root = parseXml(await response.text())
      expect(root.name).toBe('sitemapindex')
      expect(childrenNamed(root, 'sitemap').map((entry) => childText(entry, 'loc'))).toEqual([
        `${SITE}/sitemaps/static.xml`,
        `${SITE}/sitemaps/games-1.xml`,
      ])
    })

    it('lists the landing and the catalog in both locales', async () => {
      const response = await fetch('/sitemaps/static.xml')
      expect(response.headers.get('cache-control')).toBe('public, max-age=21600, s-maxage=21600')
      const root = parseXml(await response.text())
      expect(childrenNamed(root, 'url').map((url) => childText(url, 'loc'))).toEqual([
        SITE,
        `${SITE}/en`,
        `${SITE}/games`,
        `${SITE}/en/games`,
      ])
    })

    it('lists every game of the index, each with the alternates its own page links to', async () => {
      const root = parseXml(await (await fetch('/sitemaps/games-1.xml')).text())
      expect(root.attributes['xmlns:xhtml']).toBe('http://www.w3.org/1999/xhtml')
      const urls = childrenNamed(root, 'url')
      const locs = urls.map((url) => childText(url, 'loc'))
      expect(locs).toContain(`${SITE}${GAME}`)
      expect(locs).toContain(`${SITE}/en${GAME}`)
      expect(locs.length % 2).toBe(0)
      for (const url of urls) expect(childText(url, 'lastmod')).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      // The sitemap and the page itself must agree on the pair.
      const witcher = urls.find((url) => childText(url, 'loc') === `${SITE}${GAME}`)!
      const links = Object.fromEntries(
        childrenNamed(witcher, 'xhtml:link').map((l) => [l.attributes.hreflang, l.attributes.href]),
      )
      const head = await headOf(GAME)
      expect(links).toEqual({
        uk: alternate(head, 'uk'),
        en: alternate(head, 'en'),
        'x-default': alternate(head, 'x-default'),
      })
    })

    it('answers 404 for a game file past the end and for anything else under /sitemaps', async () => {
      expect((await fetch('/sitemaps/games-2.xml')).status).toBe(404)
      expect((await fetch('/sitemaps/other.xml')).status).toBe(404)
    })
  })

  it('serves robots.txt that keeps crawlers off the API and points at the sitemap', async () => {
    const response = await fetch('/robots.txt')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const body = await response.text()
    expect(body).toContain('User-agent: *\nAllow: /\nDisallow: /api/\n')
    expect(body).toContain(`Sitemap: ${SITE}/sitemap.xml`)
  })
})
