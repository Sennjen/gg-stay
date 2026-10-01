import { useGameIndex } from '../../index/index'
import { sendXml, siteUrlOf } from '../../seo/respond'
import { STATIC_PATHS, gameSitemapPages, urlset } from '../../seo/sitemap'
import { readSitemapSource, sitemapCacheControl } from '../../seo/sitemapSource'

const GAMES_FILE = /^games-(\d{1,4})\.xml$/

/**
 * `/sitemaps/static.xml` — the landing and the catalog in both locales — and
 * `/sitemaps/games-<n>.xml`, the n-th slice of the published index's games. A games file the index
 * does not reach is a 404; one it could not be asked for is a 503, so a crawler retries it rather
 * than dropping every game it listed.
 */
export default defineEventHandler(async (event) => {
  const file = getRouterParam(event, 'file') ?? ''
  const siteUrl = siteUrlOf(event)

  if (file === 'static.xml') {
    const source = await readSitemapSource(await useGameIndex())
    const lastmod = source.updatedAt ?? undefined
    const pages = STATIC_PATHS.map((path) => ({ path, lastmod }))
    return sendXml(event, urlset(siteUrl, pages), sitemapCacheControl(source.complete))
  }

  const number = GAMES_FILE.exec(file)?.[1]
  if (!number) throw createError({ statusCode: 404, statusMessage: 'Not Found' })

  const source = await readSitemapSource(await useGameIndex())
  if (!source.complete) {
    setResponseHeader(event, 'retry-after', 600)
    throw createError({ statusCode: 503, statusMessage: 'The game index is unavailable' })
  }
  const pages = gameSitemapPages(source.slugs, Number(number))
  if (!pages) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  return sendXml(event, urlset(siteUrl, pages), sitemapCacheControl(true))
})
