import { useGameIndex } from '../index/index'
import { sendXml, siteUrlOf } from '../seo/respond'
import { gameSitemapCount, sitemapIndex } from '../seo/sitemap'
import { readSitemapSource, sitemapCacheControl } from '../seo/sitemapSource'

/**
 * The sitemap index: the static pages, and one file per 2 500 games of the published index. An
 * index that cannot answer leaves the static file alone in the list, briefly cached.
 */
export default defineEventHandler(async (event) => {
  const source = await readSitemapSource(await useGameIndex())
  const lastmod = source.updatedAt ?? undefined
  const games = Array.from({ length: gameSitemapCount(source.slugs.length) }, (_, i) => ({
    path: `/sitemaps/games-${i + 1}.xml`,
    lastmod,
  }))
  const xml = sitemapIndex(siteUrlOf(event), [{ path: '/sitemaps/static.xml', lastmod }, ...games])
  return sendXml(event, xml, sitemapCacheControl(source.complete))
})
