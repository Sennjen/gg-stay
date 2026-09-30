import { describe, expect, it } from 'vitest'
import { dateRange, pickBestRated, pickFeatured } from '../../server/rawg/landing'
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

describe('pickBestRated', () => {
  it('ranks by rating among the items with enough votes, ties to the more voted', () => {
    const items = [
      item({ id: 1, rating: 5, ratings_count: 3 }),
      item({ id: 2, rating: 3.9, ratings_count: 400 }),
      item({ id: 3, rating: 4.4, ratings_count: 20 }),
      item({ id: 4, rating: 4.4, ratings_count: 90 }),
      item({ id: 5, rating: 4.9, ratings_count: 19 }),
    ]
    expect(pickBestRated(items, { minRatings: 20, limit: 12 }).map((entry) => entry.id)).toEqual([
      4, 3, 2,
    ])
  })

  it('caps the result to the limit', () => {
    const items = [1, 2, 3].map((id) => item({ id, rating: id, ratings_count: 50 }))
    expect(pickBestRated(items, { minRatings: 20, limit: 2 }).map((entry) => entry.id)).toEqual([
      3, 2,
    ])
  })
})
