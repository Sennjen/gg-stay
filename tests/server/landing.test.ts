import { describe, expect, it } from 'vitest'
import { dateRange, pickFeatured, pickTopRated } from '../../server/rawg/landing'
import type { RawgGameListItem } from '../../server/rawg/types'

function item(overrides: Partial<RawgGameListItem>): RawgGameListItem {
  return {
    id: 1,
    slug: 'game',
    name: 'Game',
    rating: 0,
    ratings_count: 0,
    background_image: 'https://example.test/cover.jpg',
    ...overrides,
  }
}

describe('dateRange', () => {
  it('formats a YYYY-MM-DD,YYYY-MM-DD window ending on today', () => {
    expect(dateRange('2026-09-19', 90)).toBe('2026-06-21,2026-09-19')
  })

  it('handles a year-long window across a leap year', () => {
    expect(dateRange('2024-03-01', 365)).toBe('2023-03-02,2024-03-01')
  })
})

describe('pickFeatured', () => {
  it('picks the highest rated item with at least 100 ratings and a cover', () => {
    const items = [
      item({ id: 1, rating: 4.5, ratings_count: 6800 }),
      item({ id: 2, rating: 4.8, ratings_count: 500 }),
      item({ id: 3, rating: 4.2, ratings_count: 50 }),
    ]
    expect(pickFeatured(items)?.id).toBe(2)
  })

  it('breaks a rating tie by more ratings_count', () => {
    const items = [
      item({ id: 1, rating: 4.5, ratings_count: 6800 }),
      item({ id: 2, rating: 4.5, ratings_count: 9000 }),
    ]
    expect(pickFeatured(items)?.id).toBe(2)
  })

  it('excludes items below the votes threshold', () => {
    const items = [item({ id: 1, rating: 4.9, ratings_count: 99 })]
    expect(pickFeatured(items)).toBeNull()
  })

  it('excludes items with no cover', () => {
    const items = [item({ id: 1, rating: 4.9, ratings_count: 500, background_image: null })]
    expect(pickFeatured(items)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(pickFeatured([])).toBeNull()
  })
})

describe('pickTopRated', () => {
  it('filters by the votes threshold, sorts by rating descending, and caps to the limit', () => {
    const items = [
      item({ id: 1, rating: 4.2, ratings_count: 6800 }),
      item({ id: 2, rating: 4.8, ratings_count: 500 }),
      item({ id: 3, rating: 4.9, ratings_count: 50 }), // below threshold
      item({ id: 4, rating: 4.6, ratings_count: 200 }),
    ]
    expect(pickTopRated(items, 2).map((entry) => entry.id)).toEqual([2, 4])
  })

  it('returns fewer than the limit when fewer items qualify', () => {
    const items = [item({ id: 1, rating: 4.2, ratings_count: 150 })]
    expect(pickTopRated(items, 8).map((entry) => entry.id)).toEqual([1])
  })

  it('returns an empty list when nothing qualifies', () => {
    expect(pickTopRated([item({ id: 1, ratings_count: 5 })], 8)).toEqual([])
  })
})
