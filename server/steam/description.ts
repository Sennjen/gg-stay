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

// Elements whose *content* must be dropped entirely, not just the tags themselves — matched
// case-insensitively against the scanned tag name.
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'video', 'iframe', 'noscript'])
// Closing tags that become a paragraph break.
const NEWLINE_ON_CLOSE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function isAsciiLetter(char: string | undefined): boolean {
  if (!char) return false
  const code = char.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isTagNameChar(char: string | undefined): boolean {
  return !!char && /[a-zA-Z0-9]/.test(char)
}

/**
 * Strips HTML tags down to plain text with a single left-to-right scan (no regex over the tag
 * markup itself, so a quoted attribute value can safely contain `<`/`>` without derailing where
 * a tag ends — the classic `<div title="a>b">` failure mode of `/<[^>]+>/`).
 *
 * Behaviour: `<li>` becomes "• ", `</li>`/`<br>`/`</p>`/`</h1..6>` become a newline, everything
 * inside `<script>`/`<style>`/`<video>`/`<iframe>`/`<noscript>` is dropped up to the matching
 * close tag (case-insensitive) or end of input, `<!-- … -->` comments are dropped, every other
 * tag is dropped but its surrounding text is kept, an unclosed tag at the end of input drops only
 * that trailing tag, and a `<` that isn't the start of a tag or comment (`5 < 6`, `<3`) is kept
 * as literal text.
 */
function stripTags(html: string): string {
  let out = ''
  const n = html.length
  let i = 0
  // Lowercase name of the content-skipping tag currently open, or null when not skipping.
  let skipping: string | null = null

  while (i < n) {
    const char = html[i]!

    if (char !== '<') {
      if (!skipping) out += char
      i++
      continue
    }

    // HTML comment: drop up to and including the matching "-->", or to end of input.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
      continue
    }

    const next = html[i + 1]
    const closing = next === '/'
    const nameStart = closing ? i + 2 : i + 1
    const isTagStart = closing ? isTagNameChar(html[nameStart]) : isAsciiLetter(next)
    if (!isTagStart) {
      // A lone "<" that doesn't start a tag or comment — literal text (e.g. "5 < 6", "<3").
      if (!skipping) out += char
      i++
      continue
    }

    let j = nameStart
    while (j < n && isTagNameChar(html[j])) j++
    const tagName = html.slice(nameStart, j).toLowerCase()

    // Scan to the tag's closing ">" (respecting quoted attribute values, which may contain
    // "<"/">"). An unterminated quote or tag runs to end of input — the trailing, unclosed tag is
    // simply dropped, same as a real HTML parser would do with no more input to complete it.
    let k = j
    let quote: string | null = null
    let closedProperly = false
    while (k < n) {
      const c = html[k]!
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        closedProperly = true
        break
      }
      k++
    }
    const tagEnd = closedProperly ? k + 1 : n

    if (skipping) {
      if (closing && tagName === skipping) skipping = null
      i = tagEnd
      continue
    }

    if (!closing && SKIP_CONTENT_TAGS.has(tagName)) {
      const selfClosing = closedProperly && html[k - 1] === '/'
      if (!selfClosing) skipping = tagName
      i = tagEnd
      continue
    }

    if (!closing && tagName === 'li') out += '• '
    else if (closing && tagName === 'li') out += '\n'
    else if (!closing && tagName === 'br') out += '\n'
    else if (closing && NEWLINE_ON_CLOSE.has(tagName)) out += '\n'
    // Every other tag (div, strong, em, ul, the void <img>/<video> form, …) contributes nothing
    // itself; its surrounding text is already flowing straight into `out`.

    i = tagEnd
  }

  return out
}

/**
 * Reduces Steam's HTML description fields to plain text, safe to render through text
 * interpolation (never `v-html`): strips every tag, turns block-level closing tags into
 * newlines, prefixes list items with "• ", drops `<script>`/`<style>`/`<video>`/`<iframe>`/
 * `<noscript>` content entirely, decodes HTML entities (after tags are stripped, so an encoded
 * `&lt;script&gt;` never gets treated as a real tag), collapses whitespace, and caps the result
 * at 4000 characters on a paragraph boundary.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return ''
  let text = stripTags(html)

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
  if (aboutTheGame) return aboutTheGame
  const shortDescription = data?.short_description?.trim()
  if (shortDescription) return shortDescription
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
