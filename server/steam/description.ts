import type { SteamAppDetails } from './types'

export interface LocalizedText {
  text: string
  language: string
  source: 'RAWG' | 'STEAM'
}

type SteamDescriptionData = NonNullable<SteamAppDetails['data']>

const MAX_LENGTH = 4_000

// Named entities beyond the handful graphql/DOM parsers know out of the box. Numeric entities
// (decimal and hex) are decoded separately, below.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** Cuts `text` to at most `max` characters, breaking on the last paragraph boundary. */
function truncateAtParagraphBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const lastParagraphBreak = slice.lastIndexOf('\n')
  if (lastParagraphBreak > 0) return slice.slice(0, lastParagraphBreak)
  return slice
}

/**
 * Reduces Steam's HTML description fields to plain text, safe to render through text
 * interpolation (never `v-html`): strips every tag, turns block-level closing tags into
 * newlines, prefixes list items with "• ", drops `<img>`/`<video>`/`<script>`/`<style>` content
 * entirely, decodes HTML entities, collapses whitespace, and caps the result at 4000 characters
 * on a paragraph boundary.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  let text = html

  // Drop these elements and everything inside them before anything else touches the markup.
  text = text.replace(/<(script|style|img|video)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Void/self-closing forms (e.g. `<img src="...">` with no closing tag).
  text = text.replace(/<(img|video)\b[^>]*\/?>/gi, '')

  // List items become a bullet-prefixed line.
  text = text.replace(/<li\b[^>]*>/gi, '• ')
  text = text.replace(/<\/li>/gi, '\n')

  // Block-level boundaries become newlines.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|h[1-6])>/gi, '\n')

  // Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, '')

  text = decodeEntities(text)

  // Collapse runs of spaces/tabs, trim each line, then collapse blank-line runs to a single
  // paragraph break.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')

  if (text.length > MAX_LENGTH) text = truncateAtParagraphBoundary(text, MAX_LENGTH)

  return text
}

const CYRILLIC = /[Ѐ-ӿ]/
const LETTER = /\p{L}/u
const UKRAINIAN_MARKERS = /[іїєґ]/i

/**
 * Steam falls back to English without telling us. A text is accepted as Ukrainian only when at
 * least 60% of its letters are Cyrillic AND it contains at least one Ukrainian-specific letter
 * (і/ї/є/ґ, either case) — Russian text can be almost entirely Cyrillic but never uses those.
 */
export function isLikelyUkrainian(text: string): boolean {
  if (!text) return false
  const letters = Array.from(text).filter((char) => LETTER.test(char))
  if (letters.length === 0) return false
  const cyrillicCount = letters.filter((char) => CYRILLIC.test(char)).length
  const ratio = cyrillicCount / letters.length
  return ratio >= 0.6 && UKRAINIAN_MARKERS.test(text)
}

function localizedRawg(rawgDescription: string | null): LocalizedText | null {
  if (!rawgDescription) return null
  return { text: rawgDescription, language: 'en', source: 'RAWG' }
}

/** Picks `about_the_game` when non-empty, else `short_description`; both are raw Steam HTML. */
function pickSteamHtml(data: SteamDescriptionData | null): string | null {
  const aboutTheGame = data?.about_the_game?.trim()
  if (aboutTheGame) return data!.about_the_game as string
  const shortDescription = data?.short_description?.trim()
  if (shortDescription) return data!.short_description as string
  return null
}

/**
 * Resolves the description to show for a locale:
 * - locale other than `uk` -> the RAWG English text (`language: "en"`, `source: RAWG`), or null.
 * - `uk` -> the Steam text (`language: "uk"`, `source: STEAM`) when Steam provided a genuinely
 *   Ukrainian description; otherwise the RAWG English text, or null when neither exists.
 */
export function resolveLocalizedDescription(
  locale: string,
  rawgDescription: string | null,
  steamData: SteamDescriptionData | null,
): LocalizedText | null {
  if (locale !== 'uk') return localizedRawg(rawgDescription)

  const html = pickSteamHtml(steamData)
  if (html) {
    const text = htmlToText(html)
    if (text && isLikelyUkrainian(text)) return { text, language: 'uk', source: 'STEAM' }
  }

  return localizedRawg(rawgDescription)
}
