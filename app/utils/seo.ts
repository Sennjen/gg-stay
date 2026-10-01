/**
 * The small rules every page's head follows, kept pure so they are tested once rather than read
 * off three pages: how a title ends, how long a description may run and where it is cut, and which
 * pages a search engine may index.
 */

export const SITE_NAME = 'GG Stay'

/**
 * The landing's share card, served from `public/` and drawn by `scripts/og-image.ts` at the size
 * every large preview card uses. `tests/app/ogImage.test.ts` reads the file's own header, so the
 * size declared in `og:image:width`/`height` cannot drift from the image.
 */
export const OG_IMAGE = { path: '/og.png', width: 1200, height: 630 } as const

/** Every page title but the landing's ends with the site name. */
export function withSiteName(title: string): string {
  return `${title} — ${SITE_NAME}`
}

/** Search engines show roughly this many characters of a description before cutting it. */
export const DESCRIPTION_LIMIT = 160

/** Cut no further back than this share of the limit to land on a word boundary. */
const MIN_KEPT_SHARE = 0.6

/** Punctuation that reads wrong right before the ellipsis. */
const TRAILING_PUNCTUATION = /[\s,;:—–-]+$/

/**
 * The text with its whitespace collapsed, cut to `limit` characters (ellipsis included) on the
 * last word boundary before it — a description cut mid-word reads like an error in a result list.
 * A text with no boundary late enough to keep most of it is cut mid-word instead of losing half.
 */
export function trimDescription(text: string, limit: number = DESCRIPTION_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const room = flat.slice(0, limit - 1)
  const boundary = room.lastIndexOf(' ')
  const cut = boundary >= limit * MIN_KEPT_SHARE ? room.slice(0, boundary) : room
  return `${cut.replace(TRAILING_PUNCTUATION, '')}…`
}

/** A store's own section heading: a short line that does not end like a sentence. */
function isHeading(line: string): boolean {
  return line.length <= 40 && !/[.!?…:;]$/.test(line)
}

/**
 * A page's long text as a meta description: the heading a store puts above it is skipped (Steam's
 * Ukrainian descriptions open with "Про гру"), the rest is flattened and trimmed.
 */
export function metaDescription(text: string | null | undefined): string {
  const lines = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  while (lines.length > 1 && isHeading(lines[0]!)) lines.shift()
  return trimDescription(lines.join(' '))
}

/** Indexable, and a large image preview is fine: the covers are what a result is worth showing. */
export const INDEXABLE = 'index, follow, max-image-preview:large'

/** Out of the index, but its links still count, so the games it lists are still found. */
export const NOT_INDEXABLE = 'noindex, follow'

/**
 * The catalog's first plain page is the one worth a search result. A filtered or later page is a
 * view of it — one per combination of a dozen filters — so it stays out of the index, while its
 * canonical (always the query-free URL) points back at the page that is in.
 */
export function catalogRobots(state: { filtered: boolean; page: number }): string {
  return state.filtered || state.page > 1 ? NOT_INDEXABLE : INDEXABLE
}
