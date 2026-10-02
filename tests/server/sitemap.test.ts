import { describe, expect, it } from 'vitest'
import {
  GAMES_PER_SITEMAP,
  SITEMAP_LOCALES,
  gameSitemapCount,
  gameSitemapPages,
  robotsTxt,
  sitemapIndex,
  urlset,
  type SitemapPage,
} from '../../server/seo/sitemap'
import {
  readSitemapMeta,
  readSitemapSource,
  sitemapCacheControl,
} from '../../server/seo/sitemapSource'
import {
  gamesSitemapResponse,
  sitemapIndexResponse,
  staticSitemapResponse,
} from '../../server/seo/sitemapResponses'
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

describe('splitting the games into files', () => {
  const slugs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ slug: `g-${i}`, updatedAt: 'T' }))

  it('fills a file with 5 000 URLs, every locale counted, and opens the next one after', () => {
    const all = slugs(2_501)
    expect(gameSitemapCount(all.length)).toBe(2)
    const first = parseXml(urlset(SITE, gameSitemapPages(all, 1)!))
    expect(childrenNamed(first, 'url')).toHaveLength(5_000)
    const second = parseXml(urlset(SITE, gameSitemapPages(all, 2)!))
    expect(childrenNamed(second, 'url')).toHaveLength(SITEMAP_LOCALES.length)
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
    expect(childrenNamed(parseXml(xml), 'url')).toHaveLength(5_000)
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

describe('readSitemapMeta', () => {
  it('reads only the publication date, never the documents', async () => {
    const index = await publishTestIndex(SEED_GAMES)
    const counted = overriding(index, {
      allSlugs: () => Promise.reject(new Error('the static sitemap must not read every game')),
    })
    expect(await readSitemapMeta(counted)).toEqual({
      updatedAt: TEST_INDEX_META.updatedAt,
      complete: true,
    })
  })

  it('is incomplete when the index lets it down', async () => {
    const broken = overriding(await publishTestIndex(SEED_GAMES), {
      meta: () => Promise.reject(new IndexUnavailableError('the store did not answer')),
    })
    expect(await readSitemapMeta(broken)).toEqual({ updatedAt: null, complete: false })
  })
})

describe('the sitemap responses', () => {
  const XML = 'application/xml; charset=utf-8'
  const LONG = 'public, max-age=21600, s-maxage=21600'
  const SHORT = 'public, max-age=600, s-maxage=600'
  const games = Array.from({ length: 3 }, (_, i) => ({ slug: `g-${i}`, updatedAt: 'T' }))
  const complete = { slugs: games, updatedAt: 'T', complete: true }
  const failed = { slugs: [], updatedAt: null, complete: false }

  it('indexes the static file and the game files, cached for six hours', () => {
    const response = sitemapIndexResponse(SITE, complete)
    expect(response.status).toBe(200)
    expect(response.headers).toEqual({ 'content-type': XML, 'cache-control': LONG })
    const locs = childrenNamed(parseXml(response.body), 'sitemap').map((s) => childText(s, 'loc'))
    expect(locs).toEqual([`${SITE}/sitemaps/static.xml`, `${SITE}/sitemaps/games-1.xml`])
  })

  it('indexes the static file alone, briefly cached, when the index read failed', () => {
    const response = sitemapIndexResponse(SITE, failed)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe(SHORT)
    const locs = childrenNamed(parseXml(response.body), 'sitemap').map((s) => childText(s, 'loc'))
    expect(locs).toEqual([`${SITE}/sitemaps/static.xml`])
  })

  it('lists the landing, the catalog and the ask page in both locales, briefly cached if the date is missing', () => {
    const response = staticSitemapResponse(SITE, { updatedAt: 'T', complete: true })
    expect(response.headers).toEqual({ 'content-type': XML, 'cache-control': LONG })
    const urls = childrenNamed(parseXml(response.body), 'url')
    expect(urls.map((url) => childText(url, 'loc'))).toEqual([
      SITE,
      `${SITE}/en`,
      `${SITE}/games`,
      `${SITE}/en/games`,
      `${SITE}/ask`,
      `${SITE}/en/ask`,
    ])
    expect(urls.map((url) => childText(url, 'lastmod'))).toEqual(['T', 'T', 'T', 'T', 'T', 'T'])
    // The ask page is listed without a question: only the empty page is indexable.
    for (const url of urls.slice(4)) {
      expect(
        childrenNamed(url, 'xhtml:link').map((link) => [
          link.attributes.hreflang,
          link.attributes.href,
        ]),
      ).toEqual([
        ['uk', `${SITE}/ask`],
        ['en', `${SITE}/en/ask`],
        ['x-default', `${SITE}/ask`],
      ])
    }
    const degraded = staticSitemapResponse(SITE, { updatedAt: null, complete: false })
    expect(degraded.status).toBe(200)
    expect(degraded.headers['cache-control']).toBe(SHORT)
  })

  it('serves a games file, and 404s one past the end or with a padded number', () => {
    const response = gamesSitemapResponse(SITE, 'games-1.xml', complete)
    expect(response.status).toBe(200)
    expect(response.headers).toEqual({ 'content-type': XML, 'cache-control': LONG })
    expect(childrenNamed(parseXml(response.body), 'url')).toHaveLength(6)
    for (const file of [
      'games-2.xml',
      'games-0.xml',
      'games-01.xml',
      'other.xml',
      'games-1.xmlx',
    ]) {
      expect(gamesSitemapResponse(SITE, file, complete).status).toBe(404)
    }
  })

  it('answers 503 with Retry-After for a games file the index could not be asked for', () => {
    // A 404 would tell a crawler every game it listed is gone; a 503 tells it to come back.
    const response = gamesSitemapResponse(SITE, 'games-1.xml', failed)
    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('600')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})
