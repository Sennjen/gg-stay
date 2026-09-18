import { describe, expect, it } from 'vitest'
import { formatDate, formatNumber } from '~/utils/format'

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
