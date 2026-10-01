/** What a build without `NUXT_PUBLIC_SITE_URL` links to: the development server. */
export const DEV_SITE_URL = 'http://localhost:3000'

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/

/**
 * The site's public origin, checked before anything is built on it.
 *
 * Every canonical link, hreflang alternate, `og:url`, sitemap entry and JSON-LD `url` is this value
 * with a path appended, so a value that is not a bare origin breaks all of them at once and
 * silently: production once carried `https://gg-stay.vercel.app;`, and every canonical read
 * `https://gg-stay.vercel.app;/games`. The build therefore refuses anything that would not come
 * back unchanged from `new URL(raw).origin` — a trailing slash, semicolon or whitespace, a path, a
 * query, credentials, or a scheme other than http(s).
 *
 * Unset (or empty) falls back to the development origin, as it always has: local builds, CI and
 * the test server set nothing. A value that is set has to be right.
 */
export function parseSiteUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEV_SITE_URL
  let origin: string | null = null
  try {
    const url = new URL(raw)
    // The URL parser accepts `;` and `,` inside a host, so `https://gg-stay.vercel.app;` parses
    // with the semicolon as part of the host name. A real host name is labels of letters, digits
    // and hyphens (or a bracketed IPv6 address), and nothing else gets through.
    const hostOk = HOST_NAME.test(url.hostname) || IPV6_HOST.test(url.hostname)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && hostOk) origin = url.origin
  } catch {
    origin = null
  }
  // Comparing case-insensitively lets a capitalised host through (the URL parser lowercases it),
  // while anything the parser had to drop or rewrite — whitespace, a path, a stray character after
  // the host — makes the two differ.
  if (origin === null || origin !== raw.toLowerCase()) {
    throw new Error(
      `NUXT_PUBLIC_SITE_URL must be an absolute http(s) origin with no path, query, trailing ` +
        `slash, whitespace or punctuation, such as https://example.com — got ${JSON.stringify(raw)}.`,
    )
  }
  return origin
}
