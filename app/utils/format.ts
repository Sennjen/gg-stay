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

export function formatNumber(value: number, localeTag: string): string {
  return new Intl.NumberFormat(localeTag).format(value)
}

/** Formats a decimal with a fixed number of fraction digits, localised (e.g. "3,6" in uk-UA). */
export function formatDecimal(value: number, localeTag: string, fractionDigits = 1): string {
  return new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** Formats a whole-number hryvnia amount, localised (e.g. "1 349 ₴" in uk-UA). */
export function formatUah(value: number, localeTag: string): string {
  return new Intl.NumberFormat(localeTag, {
    style: 'currency',
    currency: 'UAH',
    maximumFractionDigits: 0,
  }).format(value)
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
