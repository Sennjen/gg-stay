import type { H3Event } from 'h3'
import type { TextResponse } from './sitemapResponses'

/**
 * The site's origin for the sitemap and robots.txt: the same `i18n.baseUrl` every canonical link
 * is built on, validated at build time (`shared/siteUrl.ts`), so the sitemap can never name a host
 * the pages do not.
 */
export function siteUrlOf(event: H3Event): string {
  return useRuntimeConfig(event).public.i18n.baseUrl
}

/** Applies a response built by `sitemapResponses.ts`. */
export function send(event: H3Event, response: TextResponse): string {
  setResponseStatus(event, response.status)
  for (const [name, value] of Object.entries(response.headers)) {
    setResponseHeader(event, name, value)
  }
  return response.body
}
