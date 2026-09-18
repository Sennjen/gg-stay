import { describe, expect, it } from 'vitest'
import { postFilter } from '../../server/rawg/postFilter'
import games from '../fixtures/rawg/games.json'

const items = games.results
const slugs = (list: { slug?: string }[]) => list.map((item) => item.slug)

describe('postFilter', () => {
  it('returns everything when no post-filter field is set', () => {
    expect(postFilter(items, { genres: ['action'] })).toHaveLength(items.length)
    expect(postFilter(items, null)).toHaveLength(items.length)
  })

  it('filters by minimum user rating', () => {
    expect(slugs(postFilter(items, { ratingMin: 4.5 }))).toEqual([
      'the-witcher-3-wild-hunt',
      'portal-2',
    ])
  })

  it('filters by playtime bucket', () => {
    expect(slugs(postFilter(items, { playtime: 'LONG' }))).toEqual(['the-witcher-3-wild-hunt'])
    expect(slugs(postFilter(items, { playtime: 'MEDIUM' }))).toEqual(['portal-2', 'stardew-valley'])
  })

  it('filters by age rating through the ESRB mapping', () => {
    expect(slugs(postFilter(items, { ageRating: ['PEGI7'] }))).toEqual([
      'portal-2',
      'stardew-valley',
    ])
    expect(slugs(postFilter(items, { ageRating: ['PEGI18'] }))).toEqual(['the-witcher-3-wild-hunt'])
  })
})
