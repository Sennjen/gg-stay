import { describe, expect, it } from 'vitest'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { compareAdapters, QUERIES } from '../../../scripts/index/smoke'
import { createFakeRedis } from './fakeRedis'

/**
 * The live smoke test needs credentials and runs by hand, so its comparison is exercised here
 * against the fake instead: if the two adapters disagree about anything it asks, that is a bug
 * now, and if they agree here, a mismatch on a real run is a claim about the store rather than
 * about this script.
 */

describe('the live smoke comparison', () => {
  it('finds no difference between the two adapters', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis, { keyPrefix: 'smoke:0:' })
    const { mismatches, versions } = await compareAdapters(live, createMemoryGameIndex())
    expect(mismatches).toEqual([])
    expect(versions.length).toBeGreaterThan(1)
  })

  it('reports a difference rather than throwing when one adapter is wrong', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis, { keyPrefix: 'smoke:0:' })
    const memory = createMemoryGameIndex()
    // A memory adapter that drops the first id of every page is what a real mismatch looks like.
    const search = memory.search.bind(memory)
    memory.search = async (query) => {
      const result = await search(query)
      return { ...result, ids: result.ids.slice(1) }
    }
    const { mismatches } = await compareAdapters(live, memory)
    expect(mismatches.length).toBeGreaterThan(0)
    expect(mismatches[0]).toContain('search')
  })

  it('asks something about every rule the contract states', () => {
    const asked = JSON.stringify(QUERIES)
    for (const rule of [
      'genres',
      'platforms',
      'stores',
      'gameModes',
      'ageRating',
      'playtime',
      'madeInUkraine',
      'yearFrom',
      'upcoming',
      'metacriticMin',
      'ratingMin',
      'ukrainianLocalisation',
      'free',
      'priceMaxUah',
      'onSaleMinPercent',
      'search',
      'page',
      'pageSize',
      'PRICE_ASC',
      'NAME_ASC',
      'RELEASED_DESC',
      'DISCOUNT_DESC',
    ]) {
      expect(asked).toContain(rule)
    }
  })
})
