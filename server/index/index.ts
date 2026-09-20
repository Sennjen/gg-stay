import type { GameIndex, IndexQuery, IndexSearchResult } from './GameIndex'
import type { IndexMeta, IndexedGame } from './document'
import { createMemoryGameIndex } from './memoryIndex'
import { createUpstashCommands, createUpstashIndex } from './upstashIndex'

/**
 * Which index a request reads: Upstash when both credentials are configured, and otherwise the
 * in-memory adapter seeded from the fixture, so development and CI work without credentials.
 *
 * Nothing here ever throws at the caller. The design's failure behaviour is that the catalog runs
 * on RAWG without prices when the index is unreachable and that no page fails, so an index that
 * cannot answer says so in one way, always: `meta()` is `null`, `getMany` and `getOne` find
 * nothing, and `search` rejects with `IndexUnavailableError` — one error type for a resolver to
 * catch and fall back on, rather than whatever the transport happened to raise.
 *
 * One instance per server process, and a failed attempt is never remembered: a store that was
 * unreachable when the first request arrived may answer the next one.
 */

export interface PublishedFixture {
  meta: IndexMeta
  games: IndexedGame[]
}

/** The index cannot answer. The catalog falls back to RAWG; no page fails because of it. */
export class IndexUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`The game index is unavailable: ${reason}`)
    this.name = 'IndexUnavailableError'
  }
}

/** An index that knows nothing and says so, in the one shape every caller handles. */
export function unavailableGameIndex(reason: string): GameIndex {
  return {
    search: (): Promise<IndexSearchResult> => Promise.reject(new IndexUnavailableError(reason)),
    getMany: async (): Promise<Map<number, IndexedGame>> => new Map(),
    getOne: async (): Promise<IndexedGame | null> => null,
    meta: async (): Promise<IndexMeta | null> => null,
  }
}

/**
 * The same index, with a store that stops answering turned into the unavailable shape rather than
 * into whatever the REST client raised.
 */
export function degradeOnFailure(
  index: GameIndex,
  onError: (error: unknown) => void = () => undefined,
): GameIndex {
  const report = (error: unknown): void => {
    onError(error)
  }
  return {
    search: async (query: IndexQuery) => {
      try {
        return await index.search(query)
      } catch (error) {
        report(error)
        throw new IndexUnavailableError('the store did not answer')
      }
    },
    getMany: async (ids: number[]) => {
      try {
        return await index.getMany(ids)
      } catch (error) {
        report(error)
        return new Map<number, IndexedGame>()
      }
    },
    getOne: async (id: number) => {
      try {
        return await index.getOne(id)
      } catch (error) {
        report(error)
        return null
      }
    },
    meta: async () => {
      try {
        return await index.meta()
      } catch (error) {
        report(error)
        return null
      }
    },
  }
}

export interface GameIndexSources {
  upstashRedisRestUrl: string
  upstashRedisRestToken: string
  /** The published fixture a development server is seeded from, or `null` when there is none. */
  readFixture: () => Promise<PublishedFixture | null>
  /** When the fixture is published, so a development index does not report itself as stale. */
  seededAt?: () => string
  onError?: (error: unknown) => void
}

export async function createGameIndex(sources: GameIndexSources): Promise<GameIndex> {
  const report = sources.onError ?? ((error: unknown) => console.warn('[index]', error))
  try {
    const url = sources.upstashRedisRestUrl
    const token = sources.upstashRedisRestToken
    if (url && token) {
      return degradeOnFailure(createUpstashIndex(createUpstashCommands({ url, token })), report)
    }
    return degradeOnFailure(await seedFromFixture(sources), report)
  } catch (error) {
    report(error)
    return unavailableGameIndex('it could not be built')
  }
}

async function seedFromFixture(sources: GameIndexSources): Promise<GameIndex> {
  const index = createMemoryGameIndex()
  const fixture = await sources.readFixture()
  if (!fixture) return index

  const version = await index.beginVersion()
  await index.writeVersion(version, fixture.games)
  // The fixture is published as if it had just been built, so a development server does not
  // report the index as stale the week after the fixture was recorded. Nothing renders this
  // timestamp on the client, so it cannot disagree with a hydrated page.
  const seededAt = (sources.seededAt ?? (() => new Date().toISOString()))()
  await index.publish(version, {
    ...fixture.meta,
    version,
    gameCount: fixture.games.length,
    updatedAt: seededAt,
    pricesUpdatedAt: seededAt,
  })
  return index
}

let instance: Promise<GameIndex> | undefined

export function useGameIndex(): Promise<GameIndex> {
  if (!instance) {
    const config = useRuntimeConfig()
    instance = createGameIndex({
      upstashRedisRestUrl: String(config.upstashRedisRestUrl ?? ''),
      upstashRedisRestToken: String(config.upstashRedisRestToken ?? ''),
      readFixture: () =>
        useStorage('assets:index-fixtures').getItem<PublishedFixture>('published.json'),
    })
    // A rejection must never be the answer for the life of the process: the next caller tries
    // again. `createGameIndex` catches its own failures, so this is the last line of defence.
    instance.catch(() => {
      instance = undefined
    })
  }
  return instance
}
