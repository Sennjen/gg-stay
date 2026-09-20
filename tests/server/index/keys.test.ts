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
  namesKey,
  orderKey,
  platformFacetKey,
  playtimeFacetKey,
  rangeKey,
  storeFacetKey,
  tempKey,
  versionPrefix,
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
    expect(playtimeFacetKey(2, 'SHORT')).toBe('idx:v2:f:playtime:SHORT')
    expect(localisationFacetKey(2, 'text')).toBe('idx:v2:f:loc:text')
    expect(localisationFacetKey(2, 'audio')).toBe('idx:v2:f:loc:audio')
    expect(freeFacetKey(2)).toBe('idx:v2:f:free')
    expect(madeInUkraineFacetKey(2)).toBe('idx:v2:f:ua')
    expect(metaKey(2)).toBe('idx:v2:meta')
    expect(namesKey(2)).toBe('idx:v2:names')
  })

  it('gives every sort its own order set and every trimmed value its own range set', () => {
    expect(orderKey(2, 'POPULARITY_DESC')).toBe('idx:v2:o:POPULARITY_DESC')
    expect(orderKey(2, 'PRICE_ASC')).toBe('idx:v2:o:PRICE_ASC')
    expect(orderKey(2, 'RELEASED_DESC')).toBe('idx:v2:o:RELEASED_DESC')
    expect(rangeKey(2, 'price')).toBe('idx:v2:r:price')
    expect(rangeKey(2, 'released')).toBe('idx:v2:r:released')
    expect(rangeKey(2, 'rating')).toBe('idx:v2:r:rating')
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
      ].sort(),
    )
  })

  it('writes no per-year facet: the year range is trimmed on the release range set', () => {
    for (const game of FIXTURE_GAMES) {
      for (const key of facetKeysOf(1, game)) expect(key).not.toContain(':f:year:')
    }
  })

  it('puts only a free game in the free facet', () => {
    const unpriced = FIXTURE_GAMES.find((entry) => entry.id === 14)!
    expect(facetKeysOf(1, unpriced)).not.toContain('idx:v1:f:free')
    const free = FIXTURE_GAMES.find((entry) => entry.id === 28)!
    expect(facetKeysOf(1, free)).toContain('idx:v1:f:free')
    const paid = FIXTURE_GAMES.find((entry) => entry.id === 27)!
    expect(facetKeysOf(1, paid)).not.toContain('idx:v1:f:free')
  })

  it('writes no "has a price" facet: the price and discount range sets hold those games', () => {
    for (const game of FIXTURE_GAMES) {
      for (const key of facetKeysOf(1, game)) expect(key).not.toContain(':f:priced')
    }
  })

  it('names a temporary key per request, outside the version prefix', () => {
    expect(tempKey(2, 'a1b2c3', 'facet0')).toBe('idx:tmp:v2:a1b2c3:facet0')
    expect(tempKey(2, 'a1b2c3', 'facet0')).not.toContain(versionPrefix(2))
    expect(tempKey(2, 'd4e5f6', 'facet0')).not.toBe(tempKey(2, 'a1b2c3', 'facet0'))
  })
})
