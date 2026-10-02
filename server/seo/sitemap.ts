import type { IndexedSlug } from '../index/GameIndex'

/**
 * The sitemap and robots.txt as pure strings; the routes in `server/routes/` only gather the data
 * and set the headers.
 *
 * Shape: `/sitemap.xml` is a sitemap index naming `/sitemaps/static.xml` (the landing, the
 * catalog and the ask page) and `/sitemaps/games-<n>.xml` (the game pages the published index
 * holds). Every page is listed once per locale, and every entry carries the full set of
 * `xhtml:link` alternates — the same uk/en pair and x-default the page's own head links to — so a
 * crawler that reads only the sitemap still sees the two languages as one page.
 */

/** The protocol's limit is 50 000; a smaller file is cheaper to build and to cache. */
export const URLS_PER_SITEMAP = 5_000

/**
 * The site's locales as URLs see them. It mirrors the i18n config in `nuxt.config.ts` — Ukrainian
 * is the default and unprefixed (`prefix_except_default`), English lives under `/en` — and the SEO
 * test holds every sitemap entry against the alternates the rendered page itself links to.
 */
export const SITEMAP_LOCALES = [
  { code: 'uk', prefix: '' },
  { code: 'en', prefix: '/en' },
] as const

const DEFAULT_LOCALE = SITEMAP_LOCALES[0]

/** Each game is one URL per locale, so a file holds this many games. */
export const GAMES_PER_SITEMAP = Math.floor(URLS_PER_SITEMAP / SITEMAP_LOCALES.length)

/**
 * The pages listed in the static sitemap, unprefixed. `/ask` is the empty ask page only: an answered
 * question (`/ask?q=…`) is `noindex` and never listed.
 */
export const STATIC_PATHS = ['/', '/games', '/ask'] as const

export interface SitemapPage {
  /** The path in the default locale, e.g. `/games/portal-2`. */
  path: string
  /** ISO timestamp; left out of the entry when unknown rather than invented. */
  lastmod?: string
}

export interface SitemapFile {
  path: string
  lastmod?: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * A page's absolute URL in one locale. The root is the bare origin (`https://host`, `https://host/en`),
 * exactly as the i18n canonical link writes it.
 */
function localizedUrl(siteUrl: string, prefix: string, path: string): string {
  return `${siteUrl}${prefix}${path === '/' ? '' : path}`
}

function urlEntry(siteUrl: string, page: SitemapPage, prefix: string): string {
  const links = [
    ...SITEMAP_LOCALES.map(
      (locale) =>
        `<xhtml:link rel="alternate" hreflang="${locale.code}" href="${escapeXml(localizedUrl(siteUrl, locale.prefix, page.path))}"/>`,
    ),
    `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(localizedUrl(siteUrl, DEFAULT_LOCALE.prefix, page.path))}"/>`,
  ]
  const lastmod = page.lastmod ? `<lastmod>${escapeXml(page.lastmod)}</lastmod>` : ''
  return `<url><loc>${escapeXml(localizedUrl(siteUrl, prefix, page.path))}</loc>${lastmod}${links.join('')}</url>`
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

/** A `<urlset>` listing every page once per locale. */
export function urlset(siteUrl: string, pages: readonly SitemapPage[]): string {
  const entries = pages.flatMap((page) =>
    SITEMAP_LOCALES.map((locale) => urlEntry(siteUrl, page, locale.prefix)),
  )
  return (
    `${XML_DECLARATION}\n` +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    entries.map((entry) => `${entry}\n`).join('') +
    '</urlset>\n'
  )
}

/** The `<sitemapindex>` naming every file. */
export function sitemapIndex(siteUrl: string, files: readonly SitemapFile[]): string {
  const entries = files.map((file) => {
    const lastmod = file.lastmod ? `<lastmod>${escapeXml(file.lastmod)}</lastmod>` : ''
    return `<sitemap><loc>${escapeXml(`${siteUrl}${file.path}`)}</loc>${lastmod}</sitemap>\n`
  })
  return (
    `${XML_DECLARATION}\n` +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.join('') +
    '</sitemapindex>\n'
  )
}

/** How many game files `slugCount` games need. */
export function gameSitemapCount(slugCount: number): number {
  return Math.ceil(slugCount / GAMES_PER_SITEMAP)
}

/** The pages of game file `file` (numbered from 1), or `null` for a file that does not exist. */
export function gameSitemapPages(
  slugs: readonly IndexedSlug[],
  file: number,
): SitemapPage[] | null {
  if (!Number.isInteger(file) || file < 1 || file > gameSitemapCount(slugs.length)) return null
  return slugs
    .slice((file - 1) * GAMES_PER_SITEMAP, file * GAMES_PER_SITEMAP)
    .map((entry) => ({ path: `/games/${entry.slug}`, lastmod: entry.updatedAt }))
}

/**
 * Everything may be crawled but the GraphQL endpoint, which answers POSTs a crawler has no use
 * for. Filtered catalog pages are not disallowed here: they carry `noindex, follow`, and a page a
 * crawler may not fetch is a page whose `noindex` it never reads.
 */
export function robotsTxt(siteUrl: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n')
}
