import { useGameIndex } from '../index/index'
import { send, siteUrlOf } from '../seo/respond'
import { sitemapIndexResponse } from '../seo/sitemapResponses'
import { readSitemapSource } from '../seo/sitemapSource'

/** The sitemap index; see `sitemapIndexResponse`. */
export default defineEventHandler(async (event) => {
  const source = await readSitemapSource(await useGameIndex())
  return send(event, sitemapIndexResponse(siteUrlOf(event), source))
})
