import { siteUrlOf } from '../seo/respond'
import { robotsTxt } from '../seo/sitemap'
import { SITEMAP_CACHE_SECONDS } from '../seo/sitemapSource'

export default defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(
    event,
    'cache-control',
    `public, max-age=${SITEMAP_CACHE_SECONDS}, s-maxage=${SITEMAP_CACHE_SECONDS}`,
  )
  return robotsTxt(siteUrlOf(event))
})
