const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Formats a YYYY-MM-DD date in UTC so server and client always render the same string. */
export function formatDate(iso: string | null | undefined, localeTag: string): string {
  if (!iso || !ISO_DATE.test(iso)) return ''
  const formatted = new Intl.DateTimeFormat(localeTag, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`))
  // Ukrainian ICU output ends with "р." (year marker); the design calls for "18 вересня 2026".
  return formatted.replace(/\s*р\.$/, '')
}

/**
 * The thousands separator of a locale, written out rather than read from the runtime.
 *
 * `Intl.NumberFormat` takes it from the runtime's CLDR data, and the two runtimes that have to
 * agree here — Node, which renders the page, and the browser, which hydrates it — ship different
 * CLDR versions. That is not hypothetical: CLDR 42 moved `fr-FR` from U+00A0 to U+202F, and the
 * same data is what made the UAH symbol differ between the two (see `formatUah`). Any number the
 * server renders into HTML and the client re-renders has to be built from characters we chose.
 *
 * Both locales this app ships are here; anything else falls back to the non-breaking space, which
 * is what every locale the project might add next uses.
 */
const GROUP_SEPARATORS: Record<string, string> = { uk: '\u00a0', en: ',' }

function groupSeparatorFor(localeTag: string): string {
  return GROUP_SEPARATORS[localeTag.slice(0, 2).toLowerCase()] ?? '\u00a0'
}

/**
 * A whole number with its digits grouped in threes, hydration-safe (see `GROUP_SEPARATORS`). The
 * sign is a plain ASCII hyphen for the same reason the separator is ours — no value this app
 * formats is negative today, and a minus sign the runtime chose would be one more character that
 * could differ between the two halves of a render.
 */
export function groupInteger(value: number, localeTag: string): string {
  const digits = Math.abs(Math.trunc(value)).toString()
  const separator = groupSeparatorFor(localeTag)
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return `${value < 0 ? '-' : ''}${groups.join(separator)}`
}

export function formatNumber(value: number, localeTag: string): string {
  // Whole numbers are grouped by hand; anything else is a decimal and goes to `formatDecimal`'s
  // formatter, which is never used where a group separator can appear (ratings are under ten).
  if (Number.isInteger(value)) return groupInteger(value, localeTag)
  return new Intl.NumberFormat(localeTag).format(value)
}

/** Formats a decimal with a fixed number of fraction digits, localised (e.g. "3,6" in uk-UA). */
export function formatDecimal(value: number, localeTag: string, fractionDigits = 1): string {
  return new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * Formats a whole-number hryvnia amount: "1 349 ₴" in uk-UA, "1,349 ₴" in en-US, with a
 * non-breaking space before the symbol so a price never wraps across it.
 *
 * Every character of the result is this module's. `style: 'currency'` read the symbol out of the
 * runtime's CLDR data, and Node and Chrome disagree about UAH — one writes "1 349 ₴", the other
 * "1 349 грн" — so a price rendered on the server and hydrated in the browser was a guaranteed
 * hydration mismatch on every priced card. The group separator came from the same data and is
 * therefore built here too (`groupInteger`). The design names the symbol, and the currency is the
 * same in both locales, so neither is the runtime's to choose.
 */
export function formatUah(value: number, localeTag: string): string {
  return `${groupInteger(value, localeTag)}\u00a0₴`
}

/**
 * Whole hours between an ISO timestamp and a reference "now", rounded to the nearest hour and
 * never negative (a price refreshed a moment ago, timestamped a few seconds in the future of a
 * caller's own clock skew, still reads as "0 hours ago"). Pure — takes `now` as an argument
 * instead of reading the clock, so it is safe to call from a render path: the caller supplies the
 * same `now` on the server and on the client (see `useServerNow`), so SSR and hydration agree.
 */
export function hoursSince(iso: string | null | undefined, nowIso: string): number | null {
  if (!iso) return null
  const then = Date.parse(iso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(then) || Number.isNaN(now)) return null
  return Math.max(0, Math.round((now - then) / 3_600_000))
}

/**
 * Splits a RAWG `description_raw` block into paragraphs. Handles `\n`, `\r\n` and blank-line
 * separated paragraphs, trims each one, and drops empty paragraphs (including leading/trailing
 * blank lines).
 */
export function splitParagraphs(text: string | null | undefined): string[] {
  if (!text) return []
  return text
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}
