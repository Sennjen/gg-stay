import type { GameIndex, IndexQuery } from '../../../server/index/GameIndex'
import type { IndexMeta, IndexedGame } from '../../../server/index/document'
import { createMemoryGameIndex, type MemoryGameIndex } from '../../../server/index/memoryIndex'
import type { GraphQLContext, ResolverCache } from '../../../server/graphql/context'
import { createYogaApp } from '../../../server/graphql/yoga'
import type { RawgFetch } from '../../../server/rawg/rawgFetch'
import type { SteamFetch } from '../../../server/steam/steamFetch'
import type { SteamPrice } from '../../../server/steam/price'
import type { SteamPriceFetch } from '../../../server/steam/steamPriceFetch'
import { UpstreamError } from '../../../server/upstream/errors'
import games from '../../fixtures/rawg/games.json'
import detail from '../../fixtures/rawg/game-the-witcher-3-wild-hunt.json'
import stores from '../../fixtures/rawg/game-the-witcher-3-wild-hunt-stores.json'
import screenshots from '../../fixtures/rawg/game-the-witcher-3-wild-hunt-screenshots.json'
import movies from '../../fixtures/rawg/game-3328-movies.json'
import genres from '../../fixtures/rawg/genres.json'
import platforms from '../../fixtures/rawg/platforms.json'
import developers from '../../fixtures/rawg/developers.json'
import steamAppdetails from '../../fixtures/steam/appdetails-292030.json'
import stardewDetail from '../../fixtures/rawg/game-stardew-valley.json'
import stardewStores from '../../fixtures/rawg/game-stardew-valley-stores.json'
import stardewSteamAppdetails from '../../fixtures/steam/appdetails-413150.json'

/**
 * The BFF under test, driven through real GraphQL operations against yoga. Everything the
 * resolvers reach — RAWG, Steam, the index, the result cache and the clock — is a fixture or an
 * in-memory double here, so a suite never touches the network and never reads a real clock.
 */

export const fixtureRawg: RawgFetch = async (path) => {
  if (path === 'games') return games
  if (path === 'games/the-witcher-3-wild-hunt') return detail
  if (path === 'games/the-witcher-3-wild-hunt/stores') return stores
  if (path === 'games/the-witcher-3-wild-hunt/screenshots') return screenshots
  if (path === 'games/3328/movies') return movies
  if (path === 'games/stardew-valley') return stardewDetail
  if (path === 'games/stardew-valley/stores') return stardewStores
  if (path === 'genres') return genres
  if (path === 'platforms') return platforms
  if (path === 'developers') return developers
  throw new UpstreamError('RAWG', 'NOT_FOUND', 404)
}

// The fixture-mode e2e app (tests/e2e/ssr.test.ts) exercises the Steam trailer path for the
// featured game (The Witcher 3, RAWG movies fixture emptied out on purpose): its Steam store link
// resolves to app id 292030. This mock mirrors that fixture so contract tests cover the same path.
// App id 413150 (Stardew Valley) is the localized-description English-fallback fixture: Steam
// silently serves English text even with `cc=ua&l=ukrainian`, because the publisher never
// translated that store page.
export const fixtureSteam: SteamFetch = async (appId) => {
  if (appId === '292030') return steamAppdetails
  if (appId === '413150') return stardewSteamAppdetails
  throw new UpstreamError('STEAM', 'NOT_FOUND', 404)
}

const notExpected = (what: string) => () => {
  throw new Error(`the Steam ${what} transport was not expected to be called`)
}

/** A Steam price transport that answers nothing, for the paths that must not call one. */
export const noSteamPrices: SteamPriceFetch = {
  fetchPrices: notExpected('price'),
  fetchAppLanguages: notExpected('language'),
}

/**
 * The live price path the game page uses. It calls `fetchPrices`, never `fetchAppLanguages` — the
 * former is the uncached read, and a test that let the latter answer would hide that.
 */
export function steamPricesReturning(
  price: (appId: string) => Promise<SteamPrice | null> | SteamPrice | null,
): SteamPriceFetch & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetchAppLanguages: notExpected('language'),
    fetchPrices: async (appIds) => {
      const answers = new Map<string, SteamPrice | null>()
      for (const appId of appIds) {
        calls.push(appId)
        answers.set(appId, await price(appId))
      }
      return answers
    },
  }
}

/** A cache with no memory at all: every read misses, every write is dropped. */
export const noCache: ResolverCache = {
  get: async () => null,
  set: async () => {},
}

export interface CountingCache extends ResolverCache {
  readonly entries: Map<string, unknown>
  readonly reads: string[]
  readonly writes: [key: string, ttlSeconds: number][]
}

export function createTestCache(): CountingCache {
  const entries = new Map<string, unknown>()
  const reads: string[] = []
  const writes: [string, number][] = []
  return {
    entries,
    reads,
    writes,
    get: async <T>(key: string) => {
      reads.push(key)
      return (entries.get(key) as T | undefined) ?? null
    },
    set: async (key, value, ttlSeconds) => {
      writes.push([key, ttlSeconds])
      entries.set(key, value)
    },
  }
}

export interface CountingIndex extends GameIndex {
  readonly calls: { search: IndexQuery[]; getMany: number[][]; getOne: number[]; meta: number }
}

/** The same index, with every call recorded, so a test can pin "exactly one `getMany`". */
export function countCalls(index: GameIndex): CountingIndex {
  const calls: CountingIndex['calls'] = { search: [], getMany: [], getOne: [], meta: 0 }
  return {
    calls,
    search: (query) => {
      calls.search.push(query)
      return index.search(query)
    },
    getMany: (ids) => {
      calls.getMany.push(ids)
      return index.getMany(ids)
    },
    getOne: (id) => {
      calls.getOne.push(id)
      return index.getOne(id)
    },
    meta: () => {
      calls.meta += 1
      return index.meta()
    },
  }
}

export const TEST_INDEX_META: Omit<IndexMeta, 'version' | 'gameCount'> = {
  updatedAt: '2026-09-18T06:30:00.000Z',
  pricesUpdatedAt: '2026-09-18T06:00:00.000Z',
}

/** A published in-memory index holding exactly `documents`. The writer side stays reachable, so
 *  a test can publish a second version over the same store. */
export async function publishTestIndex(
  documents: readonly IndexedGame[],
  meta: Omit<IndexMeta, 'version' | 'gameCount'> = TEST_INDEX_META,
  into: MemoryGameIndex = createMemoryGameIndex(),
): Promise<MemoryGameIndex> {
  const version = await into.beginVersion()
  await into.writeVersion(version, [...documents])
  await into.publish(version, { ...meta, version, gameCount: documents.length })
  return into
}

/**
 * The same index with one method replaced. Spreading the adapter would not do it: it is a class,
 * so its methods live on the prototype and a spread copies none of them — the result would fail
 * on the first call for the wrong reason.
 */
export function overriding(index: GameIndex, overrides: Partial<GameIndex>): GameIndex {
  return {
    search: (query) => (overrides.search ?? index.search.bind(index))(query),
    getMany: (ids) => (overrides.getMany ?? index.getMany.bind(index))(ids),
    getOne: (id) => (overrides.getOne ?? index.getOne.bind(index))(id),
    meta: () => (overrides.meta ?? index.meta.bind(index))(),
  }
}

export const TEST_TODAY = '2026-09-18'
export const TEST_NOW = '2026-09-18T09:00:00.000Z'

export type TestContext = Partial<GraphQLContext>

export interface QueryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads ad-hoc shapes
  data?: Record<string, any>
  errors?: { message: string; extensions?: { code?: string } }[]
}

export async function runQuery(
  context: TestContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<QueryResult> {
  const yoga = createYogaApp(() => ({
    rawg: fixtureRawg,
    steam: fixtureSteam,
    today: TEST_TODAY,
    now: TEST_NOW,
    index: context.index ?? unpublishedIndex,
    steamPrices: noSteamPrices,
    cache: noCache,
    ...context,
  }))
  const response = await yoga.fetch('http://test/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as QueryResult
}

/** An index that was built but never published: the shape a fresh deployment starts in. */
const unpublishedIndex: GameIndex = createMemoryGameIndex()
