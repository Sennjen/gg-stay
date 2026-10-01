import type { H3Event } from 'h3'

/**
 * The site's origin for the sitemap and robots.txt: the same `i18n.baseUrl` every canonical link
 * is built on, validated at build time (`shared/siteUrl.ts`), so the sitemap can never name a host
 * the pages do not.
 */
export function siteUrlOf(event: H3Event): string {
  return useRuntimeConfig(event).public.i18n.baseUrl
}

export function sendXml(event: H3Event, xml: string, cacheControl: string): string {
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', cacheControl)
  return xml
}
