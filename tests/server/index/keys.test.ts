import { describe, expect, it } from 'vitest'
import {
  CURRENT_VERSION_KEY,
  ageRatingFacetKey,
  appIdKey,
  cursorKey,
  facetKeysOf,
  freeFacetKey,
  gameKey,
  gameModeFacetKey,
  genreFacetKey,
  localisationFacetKey,
  madeInUkraineFacetKey,
  metaKey,
  platformFacetKey,
  playtimeFacetKey,
  pricedFacetKey,
  sortDescendingOf,
  sortFieldOf,
  sortKey,
  storeFacetKey,
  versionPrefix,
  yearFacetKey,
} from '../../../server/index/keys'
import { FIXTURE_GAMES } from '../../fixtures/index/games'

describe('index keys', () => {
  it('namespaces every key of a version under its prefix', () => {
    expect(versionPrefix(2)).toBe('idx:v2:')
    expect(gameKey(2, 3328)).toBe('idx:v2:game:3328')
    expect(genreFacetKey(2, 'indie')).toBe('idx:v2:f:genre:indie')
    expect(platformFacetKey(2, 4)).toBe('idx:v2:f:platform:4')
    expect(storeFacetKey(2, 'steam')).toBe('idx:v2:f:store:steam')
    expect(gameModeFacetKey(2, 'ONLINE_COOP')).toBe('idx:v2:f:mode:ONLINE_COOP')
    expect(ageRatingFacetKey(2, 'PEGI16')).toBe('idx:v2:f:age:PEGI16')
    expect(yearFacetKey(2, 2020)).toBe('idx:v2:f:year:2020')
    expect(playtimeFacetKey(2, 'SHORT')).toBe('idx:v2:f:playtime:SHORT')
    expect(localisationFacetKey(2, 'text')).toBe('idx:v2:f:loc:text')
    expect(localisationFacetKey(2, 'audio')).toBe('idx:v2:f:loc:audio')
    expect(freeFacetKey(2)).toBe('idx:v2:f:free')
    expect(madeInUkraineFacetKey(2)).toBe('idx:v2:f:ua')
    expect(pricedFacetKey(2)).toBe('idx:v2:f:priced')
    expect(sortKey(2, 'popularity')).toBe('idx:v2:s:popularity')
    expect(sortKey(2, 'discount')).toBe('idx:v2:s:discount')
    expect(metaKey(2)).toBe('idx:v2:meta')
  })

  it('keeps the pointer, the app ids and the job cursors outside the version prefix', () => {
    expect(CURRENT_VERSION_KEY).toBe('idx:current')
    expect(appIdKey(3328)).toBe('appid:3328')
    expect(cursorKey('prices')).toBe('job:cursor:prices')
  })

  it('derives the facet keys a game belongs to', () => {
    const game = FIXTURE_GAMES.find((entry) => entry.id === 38)!
    expect(facetKeysOf(1, game).sort()).toEqual(
      [
        'idx:v1:f:age:PEGI16',
        'idx:v1:f:genre:racing',
        'idx:v1:f:loc:audio',
        'idx:v1:f:loc:text',
        'idx:v1:f:mode:SINGLE',
        'idx:v1:f:platform:4',
        'idx:v1:f:playtime:MEDIUM',
        'idx:v1:f:store:steam',
        'idx:v1:f:ua',
        'idx:v1:f:year:2020',
      ].sort(),
    )
  })

  it('leaves a game out of the priced, free and year facets when it has no price or date', () => {
    const game = FIXTURE_GAMES.find((entry) => entry.id === 14)!
    const keys = facetKeysOf(1, game)
    expect(keys).not.toContain('idx:v1:f:priced')
    expect(keys).not.toContain('idx:v1:f:free')
    expect(keys.some((key) => key.startsWith('idx:v1:f:year:'))).toBe(false)
  })

  it('puts a priced game in the priced facet and a free game in both', () => {
    const free = FIXTURE_GAMES.find((entry) => entry.id === 28)!
    expect(facetKeysOf(1, free)).toContain('idx:v1:f:free')
    expect(facetKeysOf(1, free)).toContain('idx:v1:f:priced')
    const paid = FIXTURE_GAMES.find((entry) => entry.id === 27)!
    expect(facetKeysOf(1, paid)).toContain('idx:v1:f:priced')
    expect(facetKeysOf(1, paid)).not.toContain('idx:v1:f:free')
  })

  it('maps every catalog sort onto a sorted set and a direction', () => {
    expect(sortFieldOf('POPULARITY_DESC')).toBe('popularity')
    expect(sortFieldOf('RELEASED_ASC')).toBe('released')
    expect(sortFieldOf('NAME_ASC')).toBe('name')
    expect(sortFieldOf('PRICE_DESC')).toBe('price')
    expect(sortFieldOf('DISCOUNT_DESC')).toBe('discount')
    expect(sortDescendingOf('RELEASED_ASC')).toBe(false)
    expect(sortDescendingOf('NAME_ASC')).toBe(false)
    expect(sortDescendingOf('PRICE_ASC')).toBe(false)
    expect(sortDescendingOf('PRICE_DESC')).toBe(true)
    expect(sortDescendingOf('POPULARITY_DESC')).toBe(true)
  })
})
