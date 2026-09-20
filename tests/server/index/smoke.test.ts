import { describe, expect, it } from 'vitest'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { createUpstashIndex } from '../../../server/index/upstashIndex'
import { compareAdapters } from '../../../scripts/index/smoke'
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
    const live = createUpstashIndex(redis, { keyPrefix: 'smoke:0:', runId: 'the-run' })
    const { mismatches, versions } = await compareAdapters(live, createMemoryGameIndex())
    expect(mismatches).toEqual([])
    expect(versions.length).toBeGreaterThan(1)
  })

  it('finds no difference when the reads go through a read-only token', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis, { keyPrefix: 'smoke:0:', runId: 'the-run' })
    const reader = createUpstashIndex(redis.readOnly(), {
      keyPrefix: 'smoke:0:',
      currentVersionTtlMs: 0,
    })
    const { mismatches } = await compareAdapters(live, createMemoryGameIndex(), reader)
    expect(mismatches).toEqual([])
  })

  it('reports a difference rather than throwing when one adapter is wrong', async () => {
    const redis = createFakeRedis()
    const live = createUpstashIndex(redis, { keyPrefix: 'smoke:0:', runId: 'the-run' })
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
})
