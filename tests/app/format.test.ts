import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDecimal,
  formatNumber,
  formatUah,
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
  it('formats a whole-number hryvnia amount, no fraction digits', () => {
    expect(formatUah(1349, 'uk-UA').replace(/\s/g, ' ')).toBe('1 349 ₴')
  })
  it('formats zero', () => {
    expect(formatUah(0, 'uk-UA').replace(/\s/g, ' ')).toBe('0 ₴')
  })
  it('formats in en-US too', () => {
    expect(formatUah(337, 'en-US').replace(/\s/g, ' ')).toBe('UAH 337')
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
