import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDecimal,
  formatNumber,
  formatUah,
  groupInteger,
  hoursSince,
  splitParagraphs,
} from '~/utils/format'

describe('formatDate', () => {
  it('formats Ukrainian dates without the trailing year marker', () => {
    expect(formatDate('2026-09-18', 'uk-UA')).toBe('18 вересня 2026')
  })
  it('formats English dates', () => {
    expect(formatDate('2015-05-18', 'en-US')).toBe('May 18, 2015')
  })
  it('does not shift the day across time zones', () => {
    expect(formatDate('2020-01-01', 'en-US')).toBe('January 1, 2020')
  })
  it('returns an empty string for missing or malformed input', () => {
    expect(formatDate(null, 'uk-UA')).toBe('')
    expect(formatDate('soon', 'uk-UA')).toBe('')
  })
})

describe('formatNumber', () => {
  it('groups digits per locale', () => {
    expect(formatNumber(1299, 'en-US')).toBe('1,299')
    expect(formatNumber(1299, 'uk-UA').replace(/\s/g, ' ')).toBe('1 299')
  })
})

describe('formatDecimal', () => {
  it('uses a comma in uk-UA', () => {
    expect(formatDecimal(3.6, 'uk-UA')).toBe('3,6')
  })
  it('uses a dot in en-US', () => {
    expect(formatDecimal(3.6, 'en-US')).toBe('3.6')
  })
  it('pads and rounds to the requested fraction digits', () => {
    expect(formatDecimal(4, 'en-US')).toBe('4.0')
    expect(formatDecimal(3.14159, 'en-US', 2)).toBe('3.14')
  })
})

describe('formatUah', () => {
  // Every assertion here is on exact code points, never on whitespace normalised away: JavaScript's
  // `\s` matches U+00A0 and U+202F alike, so a separator that changed under a new ICU version
  // would pass a normalising test green — and would be a hydration mismatch on every priced card.
  it('groups the thousands with a non-breaking space and ends with a non-breaking ₴', () => {
    expect(formatUah(1349, 'uk-UA')).toBe('1\u00a0349\u00a0\u20b4')
    expect(formatUah(1234567, 'uk-UA')).toBe('1\u00a0234\u00a0567\u00a0\u20b4')
  })

  it('groups with a comma in en-US, and still writes the symbol rather than a currency code', () => {
    expect(formatUah(1349, 'en-US')).toBe('1,349\u00a0\u20b4')
    expect(formatUah(675, 'en-US')).toBe('675\u00a0\u20b4')
  })

  it('needs no separator below a thousand, and formats zero', () => {
    expect(formatUah(675, 'uk-UA')).toBe('675\u00a0\u20b4')
    expect(formatUah(0, 'uk-UA')).toBe('0\u00a0\u20b4')
  })

  it('falls back to the non-breaking space for a locale the app does not ship', () => {
    expect(formatUah(1349, 'fr-FR')).toBe('1\u00a0349\u00a0\u20b4')
  })

  it('writes a plain hyphen for a negative amount rather than the runtime minus sign', () => {
    // Unreachable today — no price is negative — but the sign is one more character that must not
    // come from CLDR if it ever becomes reachable.
    expect(formatUah(-50, 'uk-UA')).toBe('-50\u00a0\u20b4')
  })
})

describe('groupInteger', () => {
  it('groups in threes from the right, in both locales the app ships', () => {
    expect(groupInteger(6800, 'uk-UA')).toBe('6\u00a0800')
    expect(groupInteger(6800, 'en-US')).toBe('6,800')
    expect(groupInteger(900000, 'uk-UA')).toBe('900\u00a0000')
    expect(groupInteger(12, 'uk-UA')).toBe('12')
  })

  it('is what formatNumber uses for a whole number, so a count is hydration-safe too', () => {
    expect(formatNumber(6800, 'uk-UA')).toBe('6\u00a0800')
    expect(formatNumber(6800, 'en-US')).toBe('6,800')
    expect(formatNumber(3, 'uk-UA')).toBe('3')
  })
})

describe('hoursSince', () => {
  it('rounds the difference between two ISO timestamps to whole hours', () => {
    expect(hoursSince('2026-09-18T09:00:00.000Z', '2026-09-18T12:00:00.000Z')).toBe(3)
  })
  it('rounds to the nearest hour rather than truncating', () => {
    expect(hoursSince('2026-09-18T09:00:00.000Z', '2026-09-18T11:40:00.000Z')).toBe(3)
    expect(hoursSince('2026-09-18T09:00:00.000Z', '2026-09-18T11:20:00.000Z')).toBe(2)
  })
  it('never returns a negative number, even for a timestamp slightly in the future', () => {
    expect(hoursSince('2026-09-18T12:00:05.000Z', '2026-09-18T12:00:00.000Z')).toBe(0)
  })
  it('returns null for a missing or malformed timestamp', () => {
    expect(hoursSince(null, '2026-09-18T12:00:00.000Z')).toBeNull()
    expect(hoursSince('not-a-date', '2026-09-18T12:00:00.000Z')).toBeNull()
  })
})

describe('splitParagraphs', () => {
  it('returns a single paragraph unchanged', () => {
    expect(splitParagraphs('A single paragraph.')).toEqual(['A single paragraph.'])
  })
  it('splits on a single newline', () => {
    expect(splitParagraphs('First.\nSecond.')).toEqual(['First.', 'Second.'])
  })
  it('splits on a double newline', () => {
    expect(splitParagraphs('First.\n\nSecond.')).toEqual(['First.', 'Second.'])
  })
  it('splits on CRLF newlines', () => {
    expect(splitParagraphs('First.\r\nSecond.')).toEqual(['First.', 'Second.'])
  })
  it('drops leading and trailing blank lines', () => {
    expect(splitParagraphs('\n\nFirst.\n\nSecond.\n\n')).toEqual(['First.', 'Second.'])
  })
  it('returns an empty array for empty or missing input', () => {
    expect(splitParagraphs('')).toEqual([])
    expect(splitParagraphs(null)).toEqual([])
    expect(splitParagraphs(undefined)).toEqual([])
  })
})
