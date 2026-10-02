import { STATIC_PATHS, gameSitemapCount, gameSitemapPages, sitemapIndex, urlset } from './sitemap'
import type { SitemapMeta, SitemapSource } from './sitemapSource'
import { INCOMPLETE_SITEMAP_CACHE_SECONDS, sitemapCacheControl } from './sitemapSource'

/**
 * Every sitemap answer as plain data — status, headers, body — so the failure paths (the brief
 * cache, the 503, the 404) are tested without a server; the routes only apply them.
 */
export interface TextResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const XML = 'application/xml; charset=utf-8'

function xml(body: string, complete: boolean): TextResponse {
  return {
    status: 200,
    headers: { 'content-type': XML, 'cache-control': sitemapCacheControl(complete) },
    body,
  }
}

/** `games-1.xml`, `games-2.xml`, …; never a padded number, so one file has one URL. */
const GAMES_FILE = /^games-([1-9]\d{0,3})\.xml$/

const NOT_FOUND: TextResponse = {
  status: 404,
  headers: {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': sitemapCacheControl(false),
  },
  body: 'Not Found',
}

/** The sitemap index: the static file, then one file per slice of the published games. */
export function sitemapIndexResponse(siteUrl: string, source: SitemapSource): TextResponse {
  const lastmod = source.updatedAt ?? undefined
  const games = Array.from({ length: gameSitemapCount(source.slugs.length) }, (_, i) => ({
    path: `/sitemaps/games-${i + 1}.xml`,
    lastmod,
  }))
  const files = [{ path: '/sitemaps/static.xml', lastmod }, ...games]
  return xml(sitemapIndex(siteUrl, files), source.complete)
}

/** The landing, the catalog and the ask page, in both locales. Needs the publication date alone. */
export function staticSitemapResponse(siteUrl: string, meta: SitemapMeta): TextResponse {
  const lastmod = meta.updatedAt ?? undefined
  return xml(
    urlset(
      siteUrl,
      STATIC_PATHS.map((path) => ({ path, lastmod })),
    ),
    meta.complete,
  )
}

/**
 * One slice of the games. A file past the end is a 404; a file the index could not be asked for
 * is a 503 with `Retry-After`, so a crawler comes back rather than dropping every game it listed.
 */
export function gamesSitemapResponse(
  siteUrl: string,
  file: string,
  source: SitemapSource,
): TextResponse {
  const number = GAMES_FILE.exec(file)?.[1]
  if (!number) return NOT_FOUND
  if (!source.complete) {
    return {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(INCOMPLETE_SITEMAP_CACHE_SECONDS),
      },
      body: 'The game index is unavailable',
    }
  }
  const pages = gameSitemapPages(source.slugs, Number(number))
  return pages ? xml(urlset(siteUrl, pages), true) : NOT_FOUND
}

/** Whether `file` names a games file at all, so the route reads the index only for one. */
export function isGamesFile(file: string): boolean {
  return GAMES_FILE.test(file)
}
