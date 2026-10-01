import { describe, expect, it } from 'vitest'
import {
  GAMES_PER_SITEMAP,
  SITEMAP_LOCALES,
  STATIC_PATHS,
  URLS_PER_SITEMAP,
  gameSitemapCount,
  gameSitemapPages,
  robotsTxt,
  sitemapIndex,
  urlset,
  type SitemapPage,
} from '../../server/seo/sitemap'
import { readSitemapSource, sitemapCacheControl } from '../../server/seo/sitemapSource'
import { IndexUnavailableError, unavailableGameIndex } from '../../server/index/index'
import { childText, childrenNamed, parseXml, type XmlElement } from './support/xml'
import { TEST_INDEX_META, overriding, publishTestIndex } from './support/yoga'
import { DEV_FIXTURE_GAMES as SEED_GAMES } from '../fixtures/index/devGames'

const SITE = 'https://gg-stay.vercel.app'
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

function alternates(url: XmlElement): Record<string, string> {
  return Object.fromEntries(
    childrenNamed(url, 'xhtml:link').map((link) => {
      expect(link.attributes.rel).toBe('alternate')
      return [link.attributes.hreflang!, link.attributes.href!]
    }),
  )
}

describe('the strict XML reader the sitemap tests rely on', () => {
  it.each([
    ['an unclosed element', '<?xml version="1.0" encoding="UTF-8"?><a><b></a>'],
    ['a bare ampersand', '<?xml version="1.0" encoding="UTF-8"?><a>x & y</a>'],
    ['an undeclared prefix', '<?xml version="1.0" encoding="UTF-8"?><a><x:b/></a>'],
    ['no declaration', '<a/>'],
    ['trailing content', '<?xml version="1.0" encoding="UTF-8"?><a/><b/>'],
  ])('refuses %s', (_, xml) => {
    expect(() => parseXml(xml)).toThrow()
  })
})

describe('urlset', () => {
  const pages: SitemapPage[] = [
    { path: '/', lastmod: '2026-09-20T06:30:00.000Z' },
    { path: '/games/the-witcher-3-wild-hunt', lastmod: '2026-09-20T06:30:00.000Z' },
  ]

  it('is a sitemap with the xhtml namespace declared for its alternates', () => {
    const root = parseXml(urlset(SITE, pages))
    expect(root.name).toBe('urlset')
    expect(root.attributes.xmlns).toBe(SITEMAP_NS)
    expect(root.attributes['xmlns:xhtml']).toBe(XHTML_NS)
  })

  it('lists every page once per locale, each with its uk/en pair and x-default', () => {
    const urls = childrenNamed(parseXml(urlset(SITE, pages)), 'url')
    expect(urls.map((url) => childText(url, 'loc'))).toEqual([
      'https://gg-stay.vercel.app',
      'https://gg-stay.vercel.app/en',
      'https://gg-stay.vercel.app/games/the-witcher-3-wild-hunt',
      'https://gg-stay.vercel.app/en/games/the-witcher-3-wild-hunt',
    ])
    for (const url of urls.slice(2)) {
      expect(alternates(url)).toEqual({
        uk: 'https://gg-stay.vercel.app/games/the-witcher-3-wild-hunt',
        en: 'https://gg-stay.vercel.app/en/games/the-witcher-3-wild-hunt',
        'x-default': 'https://gg-stay.vercel.app/games/the-witcher-3-wild-hunt',
      })
      expect(childText(url, 'lastmod')).toBe('2026-09-20T06:30:00.000Z')
    }
  })

  it('writes the root the way the canonical link does, without a trailing slash', () => {
    const [uk, en] = childrenNamed(parseXml(urlset(SITE, pages)), 'url')
    expect(alternates(uk!)).toEqual({
      uk: SITE,
      en: `${SITE}/en`,
      'x-default': SITE,
    })
    expect(childText(en!, 'loc')).toBe(`${SITE}/en`)
  })

  it('leaves lastmod out rather than inventing one', () => {
    const [url] = childrenNamed(parseXml(urlset(SITE, [{ path: '/games' }])), 'url')
    expect(childText(url!, 'lastmod')).toBeUndefined()
  })

  it('escapes what XML would not survive', () => {
    const root = parseXml(urlset(SITE, [{ path: '/games/a&b<c>' }]))
    expect(childText(childrenNamed(root, 'url')[0]!, 'loc')).toBe(`${SITE}/games/a&b<c>`)
  })
})

describe('sitemapIndex', () => {
  it('points at each file by its absolute URL, with lastmod where it is known', () => {
    const root = parseXml(
      sitemapIndex(SITE, [
        { path: '/sitemaps/static.xml' },
        { path: '/sitemaps/games-1.xml', lastmod: '2026-09-20T06:30:00.000Z' },
      ]),
    )
    expect(root.name).toBe('sitemapindex')
    expect(root.attributes.xmlns).toBe(SITEMAP_NS)
    const entries = childrenNamed(root, 'sitemap')
    expect(entries.map((entry) => childText(entry, 'loc'))).toEqual([
      `${SITE}/sitemaps/static.xml`,
      `${SITE}/sitemaps/games-1.xml`,
    ])
    expect(childText(entries[0]!, 'lastmod')).toBeUndefined()
    expect(childText(entries[1]!, 'lastmod')).toBe('2026-09-20T06:30:00.000Z')
  })
})

describe('the static sitemap pages', () => {
  it('are the landing and the catalog, each listed in both locales', () => {
    expect(STATIC_PATHS).toEqual(['/', '/games'])
    expect(SITEMAP_LOCALES.map((locale) => locale.code)).toEqual(['uk', 'en'])
  })
})

describe('splitting the games into files', () => {
  const slugs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ slug: `g-${i}`, updatedAt: 'T' }))

  it('keeps every file at or under 5 000 URLs, counting every locale', () => {
    expect(URLS_PER_SITEMAP).toBe(5_000)
    expect(GAMES_PER_SITEMAP * SITEMAP_LOCALES.length).toBeLessThanOrEqual(URLS_PER_SITEMAP)
  })

  it('needs no game file for an empty index, and one more file per full one', () => {
    expect(gameSitemapCount(0)).toBe(0)
    expect(gameSitemapCount(1)).toBe(1)
    expect(gameSitemapCount(GAMES_PER_SITEMAP)).toBe(1)
    expect(gameSitemapCount(GAMES_PER_SITEMAP + 1)).toBe(2)
  })

  it('hands each file its own slice, numbered from one, and nothing past the end', () => {
    const all = slugs(GAMES_PER_SITEMAP + 3)
    const first = gameSitemapPages(all, 1)!
    const second = gameSitemapPages(all, 2)!
    expect(first).toHaveLength(GAMES_PER_SITEMAP)
    expect(second.map((page) => page.path)).toEqual([
      `/games/g-${GAMES_PER_SITEMAP}`,
      `/games/g-${GAMES_PER_SITEMAP + 1}`,
      `/games/g-${GAMES_PER_SITEMAP + 2}`,
    ])
    expect(second[0]!.lastmod).toBe('T')
    expect(gameSitemapPages(all, 3)).toBeNull()
    expect(gameSitemapPages(all, 0)).toBeNull()
  })

  it('writes a full file well inside the 50 MB a sitemap may weigh', () => {
    const pages = gameSitemapPages(slugs(GAMES_PER_SITEMAP), 1)!
    const xml = urlset(SITE, pages)
    expect(childrenNamed(parseXml(xml), 'url')).toHaveLength(URLS_PER_SITEMAP)
    expect(xml.length).toBeLessThan(50 * 1024 * 1024)
  })
})

describe('robotsTxt', () => {
  it('allows everything but the API and names the sitemap', () => {
    expect(robotsTxt(SITE)).toBe(
      ['User-agent: *', 'Allow: /', 'Disallow: /api/', '', `Sitemap: ${SITE}/sitemap.xml`, ''].join(
        '\n',
      ),
    )
  })
})

describe('readSitemapSource', () => {
  it('reads every slug and the publication date of the published index', async () => {
    const index = await publishTestIndex(SEED_GAMES)
    const source = await readSitemapSource(index)
    expect(source.complete).toBe(true)
    expect(source.updatedAt).toBe(TEST_INDEX_META.updatedAt)
    expect(source.slugs.map((entry) => entry.slug).sort()).toEqual(
      SEED_GAMES.map((game) => game.slug).sort(),
    )
  })

  it('is complete and empty for an index that is not configured: there is nothing to list', async () => {
    const source = await readSitemapSource(unavailableGameIndex('no credentials are set'))
    expect(source).toEqual({ slugs: [], updatedAt: null, complete: true })
  })

  it('is incomplete, not failed, when the index lets it down', async () => {
    const index = await publishTestIndex(SEED_GAMES)
    const broken = overriding(index, {
      allSlugs: () => Promise.reject(new IndexUnavailableError('the store did not answer')),
    })
    expect(await readSitemapSource(broken)).toEqual({ slugs: [], updatedAt: null, complete: false })
  })
})

describe('sitemapCacheControl', () => {
  it('keeps a complete sitemap for six hours, at the CDN too', () => {
    expect(sitemapCacheControl(true)).toBe('public, max-age=21600, s-maxage=21600')
  })

  it('keeps a sitemap missing its games only briefly, so the games return soon', () => {
    expect(sitemapCacheControl(false)).toBe('public, max-age=600, s-maxage=600')
  })
})
