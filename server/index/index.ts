import type { GameIndex } from './GameIndex'
import type { IndexMeta, IndexedGame } from './document'
import { createMemoryGameIndex } from './memoryIndex'
import { createUpstashCommands, createUpstashIndex } from './upstashIndex'

/**
 * Which index a request reads: Upstash when both credentials are configured, and otherwise the
 * in-memory adapter seeded from the fixture, so development and CI work without credentials and
 * a missing secret degrades to "this deployment knows no prices" rather than to a broken page.
 *
 * One instance per server process. The Upstash adapter holds only its REST client and a 60 s
 * memory of the published version; the in-memory one holds the whole fixture, which is why it is
 * seeded once and not per request.
 */

interface PublishedFixture {
  meta: IndexMeta
  games: IndexedGame[]
}

let instance: Promise<GameIndex> | undefined

export function useGameIndex(): Promise<GameIndex> {
  instance ??= createGameIndex()
  return instance
}

async function createGameIndex(): Promise<GameIndex> {
  const config = useRuntimeConfig()
  const url = String(config.upstashRedisRestUrl ?? '')
  const token = String(config.upstashRedisRestToken ?? '')
  if (url && token) return createUpstashIndex(createUpstashCommands({ url, token }))
  return seedFromFixture()
}

async function seedFromFixture(): Promise<GameIndex> {
  const index = createMemoryGameIndex()
  const fixture =
    await useStorage('assets:index-fixtures').getItem<PublishedFixture>('published.json')
  if (!fixture) return index

  const version = await index.beginVersion()
  await index.writeVersion(version, fixture.games)
  // The fixture is published as if it had just been built, so a development server does not
  // report the index as stale the week after the fixture was recorded. Nothing renders this
  // timestamp on the client, so it cannot disagree with a hydrated page.
  const seededAt = new Date().toISOString()
  await index.publish(version, {
    ...fixture.meta,
    version,
    gameCount: fixture.games.length,
    updatedAt: seededAt,
    pricesUpdatedAt: seededAt,
  })
  return index
}
