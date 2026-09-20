import { describe, expect, it, vi } from 'vitest'
import type { GameIndex } from '../../../server/index/GameIndex'
import type { PublishedFixture } from '../../../server/index/index'
import {
  createGameIndex,
  degradeOnFailure,
  IndexUnavailableError,
  unavailableGameIndex,
} from '../../../server/index/index'
import published from '../../fixtures/index/published.json' with { type: 'json' }

/**
 * The factory the site reads the index through. Its whole job is that a page never fails because
 * of it: an unreachable store, a missing fixture or a broken one all come out as the same
 * unavailable index, and the resolver that falls back to RAWG has one error type to catch.
 */

const fixture = published as unknown as PublishedFixture

const sources = (overrides: Partial<Parameters<typeof createGameIndex>[0]> = {}) => ({
  upstashRedisRestUrl: '',
  upstashRedisRestToken: '',
  readFixture: async () => fixture,
  seededAt: () => '2026-09-20T07:00:00.000Z',
  onError: () => undefined,
  ...overrides,
})

describe('createGameIndex', () => {
  it('seeds the in-memory index from the fixture when there are no credentials', async () => {
    const index = await createGameIndex(sources())
    expect((await index.search({ ukrainianLocalisation: 'AUDIO' })).ids).toEqual([34, 35, 38])
    expect((await index.meta())?.gameCount).toBe(fixture.games.length)
    // Published as if it had just been built, so a development server is never stale.
    expect((await index.meta())?.updatedAt).toBe('2026-09-20T07:00:00.000Z')
  })

  it('answers an empty index rather than failing when there is no fixture', async () => {
    const index = await createGameIndex(sources({ readFixture: async () => null }))
    expect(await index.search({})).toEqual({ ids: [], total: 0, games: [] })
    expect(await index.meta()).toBeNull()
  })

  it('reports an unavailable index instead of throwing when it cannot be built', async () => {
    const onError = vi.fn()
    const index = await createGameIndex(
      sources({
        readFixture: () => Promise.reject(new Error('the asset store is broken')),
        onError,
      }),
    )
    expect(onError).toHaveBeenCalledOnce()
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    expect(await index.meta()).toBeNull()
    expect(await index.getMany([1, 2])).toEqual(new Map())
    expect(await index.getOne(1)).toBeNull()
  })
})

describe('an unavailable index', () => {
  it('says so in one shape', async () => {
    const index = unavailableGameIndex('nothing is configured')
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    await expect(index.search({})).rejects.toThrow(/nothing is configured/)
    expect(await index.meta()).toBeNull()
    expect(await index.getMany([1])).toEqual(new Map())
    expect(await index.getOne(1)).toBeNull()
  })
})

describe('degradeOnFailure', () => {
  const broken: GameIndex = {
    search: () => Promise.reject(new Error('ECONNRESET')),
    getMany: () => Promise.reject(new Error('ECONNRESET')),
    getOne: () => Promise.reject(new Error('ECONNRESET')),
    meta: () => Promise.reject(new Error('ECONNRESET')),
  }

  it('turns a store that stopped answering into the unavailable shape', async () => {
    const onError = vi.fn()
    const index = degradeOnFailure(broken, onError)
    await expect(index.search({})).rejects.toBeInstanceOf(IndexUnavailableError)
    expect(await index.getMany([1])).toEqual(new Map())
    expect(await index.getOne(1)).toBeNull()
    expect(await index.meta()).toBeNull()
    expect(onError).toHaveBeenCalledTimes(4)
  })

  it('passes a working index through untouched', async () => {
    const index = degradeOnFailure(await createGameIndex(sources()))
    expect((await index.search({ genres: ['indie'] })).ids).toEqual([2, 3, 5])
    expect((await index.getOne(1))?.name).toBe('Alpha Quest')
  })
})
