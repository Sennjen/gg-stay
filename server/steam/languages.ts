export interface UkrainianSupport {
  text: boolean
  audio: boolean
}

// Steam's `supported_languages` field is a comma-separated list of language names, each
// optionally followed by an asterisk marker (full audio support), then — after a `<br>` — a
// legend line explaining the marker (e.g. "мови з повною аудіопідтримкою" or the English
// equivalent). The legend text itself is never a language name, so cutting at the first `<br>`
// drops it in one step, in any response language, without needing to recognise its wording.
const LEGEND_BREAK = /<br\s*\/?>/i

// A trailing "<strong>*</strong>" (with or without inner whitespace) directly after a language
// name, at the end of its comma-separated segment, marks that language's full audio support.
const TRAILING_ASTERISK_MARKER = /<strong>\s*\*\s*<\/strong>\s*$/i

// The whole (trimmed, marker-stripped) segment must equal one of these names — never a substring
// match — so "Ukrainian" inside a longer word or phrase is never mistaken for the language.
const UKRAINIAN_NAMES = /^(українська|ukrainian|украинский)$/i

// A literal "&nbsp;" (the HTML entity, not a whitespace character `\s` already matches) at either
// edge of a segment or name — Steam's markup sometimes pads a name with one instead of a plain
// space.
const EDGE_NBSP = /^(?:&nbsp;)+|(?:&nbsp;)+$/gi

function trimSegment(input: string): string {
  return input.trim().replace(EDGE_NBSP, '').trim()
}

/**
 * Parses Steam's `supported_languages` HTML into Ukrainian text/audio support. Robust to the
 * response language Steam actually returned the list in (we request `l=ukrainian`, but Steam does
 * not always honour it): detects the language by its Ukrainian, English or Russian name, and
 * associates an audio marker only with the name it is directly attached to — a marker on another
 * language is never attributed to Ukrainian.
 *
 * `isFree` is accepted for symmetry with the fetch layer's per-app result but does not change
 * parsing: a free game's language list, when present, is read the same way as any other's.
 *
 * Linear in the length of the input: one bounded search for the legend break, then one pass over
 * the comma-separated segments — no nested or backtracking-prone regexes.
 */
export function parseUkrainianSupport(
  supportedLanguagesHtml: string | null | undefined,
  _isFree?: boolean,
): UkrainianSupport {
  if (!supportedLanguagesHtml) return { text: false, audio: false }

  const breakIndex = supportedLanguagesHtml.search(LEGEND_BREAK)
  const listPart =
    breakIndex === -1 ? supportedLanguagesHtml : supportedLanguagesHtml.slice(0, breakIndex)

  let text = false
  let audio = false

  for (const rawSegment of listPart.split(',')) {
    const segment = trimSegment(rawSegment)
    if (!segment) continue

    const hasAsterisk = TRAILING_ASTERISK_MARKER.test(segment)
    const name = trimSegment(hasAsterisk ? segment.replace(TRAILING_ASTERISK_MARKER, '') : segment)

    if (UKRAINIAN_NAMES.test(name)) {
      text = true
      if (hasAsterisk) audio = true
    }
  }

  return { text, audio }
}
