import { describe, expect, it } from 'vitest'
import {
  esrbSlugsForAgeRatings,
  esrbToAgeRating,
  gameModesFromTags,
  matchesPlaytime,
  storeIdsFromSlugs,
  storeSlugFromId,
  tagsForGameModes,
} from '../../server/rawg/lookups'

describe('lookups', () => {
  it('maps ESRB slugs to PEGI-style ratings', () => {
    expect(esrbToAgeRating('everyone')).toBe('PEGI3')
    expect(esrbToAgeRating('everyone-10-plus')).toBe('PEGI7')
    expect(esrbToAgeRating('teen')).toBe('PEGI12')
    expect(esrbToAgeRating('mature')).toBe('PEGI18')
    expect(esrbToAgeRating('adults-only')).toBe('PEGI18')
    expect(esrbToAgeRating('rating-pending')).toBeNull()
    expect(esrbToAgeRating(undefined)).toBeNull()
  })

  it('expands PEGI filters to ESRB slugs', () => {
    expect(esrbSlugsForAgeRatings(['PEGI7'])).toEqual(['everyone', 'everyone-10-plus'])
    expect(esrbSlugsForAgeRatings(['PEGI3', 'PEGI18']).sort()).toEqual(
      ['adults-only', 'everyone', 'mature'].sort(),
    )
  })

  it('maps game modes to RAWG tags and back', () => {
    expect(tagsForGameModes(['LOCAL_COOP', 'SINGLE'])).toEqual(['local-co-op', 'singleplayer'])
    expect(gameModesFromTags(['open-world', 'online-co-op', 'multiplayer'])).toEqual([
      'ONLINE_COOP',
      'MULTIPLAYER',
    ])
  })

  it('checks playtime buckets; unknown playtime never matches', () => {
    expect(matchesPlaytime(5, 'SHORT')).toBe(true)
    expect(matchesPlaytime(10, 'SHORT')).toBe(false)
    expect(matchesPlaytime(10, 'MEDIUM')).toBe(true)
    expect(matchesPlaytime(40, 'MEDIUM')).toBe(true)
    expect(matchesPlaytime(41, 'LONG')).toBe(true)
    expect(matchesPlaytime(0, 'SHORT')).toBe(false)
    expect(matchesPlaytime(null, 'LONG')).toBe(false)
  })

  it('resolves store slugs and ids, dropping unknown ones', () => {
    expect(storeIdsFromSlugs(['steam', 'nope', 'gog'])).toEqual([1, 5])
    expect(storeSlugFromId(11)).toBe('epic-games')
    expect(storeSlugFromId(999)).toBeNull()
  })
})
