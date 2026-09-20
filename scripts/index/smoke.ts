// Usage: UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… pnpm smoke:index
//
// The one test that talks to a real Redis. Everything else about the index runs against a fake
// that is faithful to the commands as they are documented — but `ZRANGESTORE … BYSCORE`, the
// weights of a `ZINTERSTORE` over plain sets and a `MULTI` sent through the REST transport are
// claims about a real server, and only a real server can settle them.
//
// It never runs in CI: it needs credentials, and it is wired to a manual workflow alone. It works
// under a key namespace of its own (`smoke:{timestamp}:`), so `idx:current` and every key the site
// reads are out of its reach, and it takes back everything it wrote before it ends.
//
// Every answer is compared with the in-memory adapter's answer to the same question. A mismatch
// prints the question and both answers, and the process exits non-zero. `compareAdapters` is
// exported so that the comparison itself is covered by the ordinary test suite, against the fake;
// what only a run with credentials can prove is the transport underneath it.
import { pathToFileURL } from 'node:url'
import type { GameIndex, GameIndexWriter, IndexQuery } from '../../server/index/GameIndex'
import type { IndexedGame } from '../../server/index/document'
import { createMemoryGameIndex } from '../../server/index/memoryIndex'
import type { UpstashClient } from '../../server/index/upstashIndex'
import {
  createUpstashClient,
  createUpstashCommandsOn,
  createUpstashIndex,
} from '../../server/index/upstashIndex'
import { FIXTURE_GAMES, FIXTURE_TODAY } from '../../tests/fixtures/index/games'

export type IndexAdapter = GameIndex & GameIndexWriter

const META = {
  updatedAt: '2026-09-20T06:30:00.000Z',
  pricesUpdatedAt: '2026-09-20T06:00:00.000Z',
  stats: { gamesIndexed: FIXTURE_GAMES.length, failures: 0 },
}

/** At least one query for every rule the shared contract states about a read. */
export const QUERIES: IndexQuery[] = [
  {},
  { genres: ['indie'] },
  { genres: ['indie', 'strategy'] },
  { genres: ['indie'], platforms: [7] },
  { genres: ['indie'], platforms: [18] },
  { genres: ['nothing-carries-this'] },
  { stores: ['gog', 'epic-games'] },
  { gameModes: ['LOCAL_COOP', 'MULTIPLAYER'] },
  { ageRating: ['PEGI3', 'PEGI7'] },
  { playtime: 'MEDIUM' },
  { madeInUkraine: true },
  { yearFrom: 2015, yearTo: 2018 },
  { yearTo: 2015 },
  { yearFrom: 2021 },
  { upcoming: true, today: FIXTURE_TODAY },
  { metacriticMin: 80 },
  { ratingMin: 4 },
  { ukrainianLocalisation: 'ANY' },
  { ukrainianLocalisation: 'TEXT' },
  { ukrainianLocalisation: 'AUDIO' },
  { free: true },
  { free: false },
  { priceMaxUah: 300 },
  { priceMaxUah: 100_000 },
  { onSaleMinPercent: 50 },
  { priceMaxUah: 300, onSaleMinPercent: 50, sort: 'DISCOUNT_DESC' },
  { sort: 'POPULARITY_DESC' },
  { sort: 'RATING_DESC' },
  { sort: 'METACRITIC_DESC' },
  { sort: 'RELEASED_ASC' },
  { sort: 'RELEASED_DESC' },
  { sort: 'NAME_ASC' },
  { sort: 'PRICE_ASC' },
  { sort: 'PRICE_DESC' },
  { genres: ['racing'], sort: 'METACRITIC_DESC' },
  { genres: ['racing'], sort: 'RELEASED_ASC' },
  { search: 'kite' },
  { search: 'KITE' },
  { search: 'ar', page: 2, pageSize: 2 },
  { genres: ['racing'], search: 'o' },
  { search: '   ' },
  { page: 2, pageSize: 20 },
  { page: 99, pageSize: 20 },
  { pageSize: 500 },
  { pageSize: 0 },
  { page: 0 },
]

/**
 * Both answers as one string. Object keys are sorted, because the two adapters build their
 * answers differently — one spreads a stored object, the other rebuilds it field by field — and
 * the order the fields happen to come out in is not something either of them owes its callers.
 */
const text = (value: unknown): string => {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, held]) => [key, ordered(held)]),
      )
    }
    return input
  }
  return JSON.stringify(ordered(value) ?? null)
}

/** What the comparison found, and which versions the live store was asked to hold. */
export interface SmokeResult {
  mismatches: string[]
  versions: number[]
}

/** Collects differences instead of throwing, so one wrong answer does not hide the rest. */
class Comparison {
  readonly mismatches: string[] = []

  same(what: string, actual: unknown, wanted: unknown): void {
    if (text(actual) === text(wanted)) return
    this.mismatches.push(`${what}\n  upstash:  ${text(actual)}\n  expected: ${text(wanted)}`)
  }
}

/** Whether a promise settled, without letting a rejection end the run. */
async function settle(work: Promise<unknown>): Promise<'resolved' | 'rejected'> {
  return work.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  )
}

async function publish(
  writer: GameIndexWriter,
  games: IndexedGame[],
  updatedAt: string = META.updatedAt,
): Promise<number> {
  const version = await writer.beginVersion()
  await writer.writeVersion(version, games)
  await writer.publish(version, { ...META, updatedAt, version, gameCount: games.length })
  return version
}

async function compareReads(
  found: Comparison,
  live: GameIndex,
  memory: IndexAdapter,
): Promise<void> {
  const shape = (result: Awaited<ReturnType<GameIndex['search']>>) => ({
    ids: result.ids,
    total: result.total,
    games: result.games.map((game) => game.id),
  })

  for (const query of QUERIES) {
    found.same(
      `search ${JSON.stringify(query)}`,
      shape(await live.search(query)),
      shape(await memory.search(query)),
    )
  }

  found.same('getOne(34)', await live.getOne(34), await memory.getOne(34))
  found.same('getOne(9999)', await live.getOne(9999), await memory.getOne(9999))
  found.same(
    'getMany([3, 9999, 7])',
    [...(await live.getMany([3, 9999, 7]))],
    [...(await memory.getMany([3, 9999, 7]))],
  )
  found.same('getMany([])', [...(await live.getMany([]))], [...(await memory.getMany([]))])
  found.same('meta()', await live.meta(), await memory.meta())
}

async function compareWrites(
  found: Comparison,
  live: IndexAdapter,
  memory: IndexAdapter,
  versions: number[],
): Promise<void> {
  const draft = await live.beginVersion()
  const memoryDraft = await memory.beginVersion()
  versions.push(draft)
  found.same(
    'a new version is not the published one',
    draft === (await live.currentVersion()),
    false,
  )

  await live.writeVersion(draft, FIXTURE_GAMES.slice(3, 6))
  await memory.writeVersion(memoryDraft, FIXTURE_GAMES.slice(3, 6))
  found.same(
    'an unpublished version is invisible',
    (await live.search({})).ids,
    (await memory.search({})).ids,
  )

  const swapped = '2026-09-21T06:30:00.000Z'
  await live.publish(draft, { ...META, version: draft, gameCount: 3, updatedAt: swapped })
  await memory.publish(memoryDraft, {
    ...META,
    version: memoryDraft,
    gameCount: 3,
    updatedAt: swapped,
  })
  found.same('the publish swapped', (await live.search({})).ids, (await memory.search({})).ids)
  found.same(
    'previousMeta after the swap',
    (await live.previousMeta())?.updatedAt,
    (await memory.previousMeta())?.updatedAt,
  )

  // Republishing the live version refreshes its metadata and touches nothing else.
  const refreshed = '2026-09-22T06:30:00.000Z'
  await live.publish(draft, { ...META, version: draft, gameCount: 3, updatedAt: refreshed })
  found.same('republished meta', (await live.meta())?.updatedAt, refreshed)
  found.same('republishing kept the documents', (await live.search({})).ids, [4, 5, 6])
  found.same('republishing kept the pointer', await live.currentVersion(), draft)

  found.same(
    'discarding the live version is refused',
    await settle(live.discardVersion(draft)),
    'rejected',
  )
  found.same(
    'rewriting the live version is refused',
    await settle(live.writeVersion(draft, FIXTURE_GAMES)),
    'rejected',
  )
  found.same('the live version survived both', (await live.search({})).ids, [4, 5, 6])

  // A discarded draft leaves nothing behind, and publishing it afterwards is refused.
  const discarded = await live.beginVersion()
  versions.push(discarded)
  await live.writeVersion(discarded, FIXTURE_GAMES.slice(8, 10))
  await live.discardVersion(discarded)
  found.same(
    'publishing a discarded version is refused',
    await settle(live.publish(discarded, { ...META, version: discarded, gameCount: 2 })),
    'rejected',
  )
  found.same('a discarded version is gone', (await live.search({})).ids, [4, 5, 6])

  // App ids and cursors live outside every version and survive a publication.
  const appIds: [number, string][] = [
    [3328, '292030'],
    [4200, ''],
  ]
  await live.setAppIds(appIds)
  await memory.setAppIds(appIds)
  found.same(
    'getAppIds',
    [...(await live.getAppIds([3328, 4200, 5000]))],
    [...(await memory.getAppIds([3328, 4200, 5000]))],
  )
  await live.setCursor('prices', '120')
  await memory.setCursor('prices', '120')
  found.same('getCursor', await live.getCursor('prices'), await memory.getCursor('prices'))
  await live.clearCursor('prices')
  await memory.clearCursor('prices')
  found.same('a cleared cursor', await live.getCursor('prices'), await memory.getCursor('prices'))
}

/**
 * Asks both adapters — which must both start empty — every question the contract answers, and
 * reports where they disagreed. `reader` is the same store seen through the token the site holds
 * when one is configured: the reads are compared through it, so a read path that writes fails here
 * rather than in production.
 */
export async function compareAdapters(
  live: IndexAdapter,
  memory: IndexAdapter,
  reader: GameIndex = live,
): Promise<SmokeResult> {
  const found = new Comparison()
  const versions: number[] = []

  found.same('nothing is published yet', await live.currentVersion(), null)
  found.same('an empty index answers nothing', (await live.search({})).total, 0)

  versions.push(await publish(live, FIXTURE_GAMES))
  await publish(memory, FIXTURE_GAMES)
  await compareReads(found, reader, memory)
  await compareWrites(found, live, memory, versions)

  return { mismatches: found.mismatches, versions }
}

const UNVERSIONED_FAMILIES = ['appid:', 'lang:', 'idx:lock', 'idx:draft'] as const

/** Every key under the namespace, read with SCAN — the one command the adapter deliberately lacks. */
async function namespaceKeys(client: UpstashClient, prefix: string): Promise<string[]> {
  const found: string[] = []
  let cursor = '0'
  do {
    const [next, keys] = await client.scan(cursor, { match: `${prefix}*`, count: 1_000 })
    cursor = String(next)
    found.push(...keys)
  } while (cursor !== '0')
  return found.sort()
}

async function main(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required')
    process.exit(1)
  }

  const prefix = `smoke:${Date.now()}:`
  console.log(`Running the index smoke test under the key namespace ${prefix}`)
  console.log(`${FIXTURE_GAMES.length} games, ${QUERIES.length} queries`)

  // One client for the adapter and for the SCAN the cleanup needs: `readYourWrites` sync tokens
  // are kept per client, so a second one could read a replica that has not seen these writes.
  const client = createUpstashClient({ url, token })
  const live = createUpstashIndex(createUpstashCommandsOn(client), { keyPrefix: prefix })

  // The site's token, when the owner has one: the reads are compared through it, so the whole
  // read path is proved to need no write permission at all.
  const readOnlyToken = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN
  const reader = readOnlyToken
    ? createUpstashIndex(
        createUpstashCommandsOn(createUpstashClient({ url, token: readOnlyToken })),
        {
          keyPrefix: prefix,
          currentVersionTtlMs: 0,
        },
      )
    : live
  console.log(
    readOnlyToken
      ? 'Reading through the read-only token as the site does'
      : 'No read-only token configured; reading through the write token',
  )
  const mismatches: string[] = []
  let versions: number[] = []

  try {
    const start = await namespaceKeys(client, prefix)
    if (start.length > 0) mismatches.push(`the namespace was not empty\n  ${text(start)}`)

    const result = await compareAdapters(live, createMemoryGameIndex(), reader)
    versions = result.versions
    mismatches.push(...result.mismatches)
  } finally {
    // Everything this run wrote, taken back through the registries it wrote them into — the same
    // mechanism `discardVersion` uses, applied to the published version as well.
    for (const version of versions) {
      const registry = `${prefix}idx:v${version}:keys`
      const keys = await client.smembers<string[]>(registry)
      if (keys.length > 0) await client.del(...keys.map((key) => `${prefix}${key}`), registry)
    }
    await client.del(
      `${prefix}idx:current`,
      `${prefix}idx:previous`,
      `${prefix}idx:sequence`,
      `${prefix}idx:versions`,
      `${prefix}idx:lock`,
    )

    // Keys that live outside any version — the permanent app-id and language records and the
    // writer's lock bookkeeping — have no registry, so they are found by name.
    const unversioned = (await namespaceKeys(client, prefix)).filter((key) =>
      UNVERSIONED_FAMILIES.some((family) => key.startsWith(`${prefix}${family}`)),
    )
    if (unversioned.length > 0) await client.del(...unversioned)

    const left = await namespaceKeys(client, prefix)
    if (left.length > 0) {
      // A read borrows nothing, so anything still here is a key the cleanup should have taken.
      mismatches.push(`keys survived the cleanup\n  ${text(left)}`)
      await client.del(...left)
    }
    const remaining = await namespaceKeys(client, prefix)
    if (remaining.length > 0) mismatches.push(`the namespace is not empty\n  ${text(remaining)}`)
  }

  if (mismatches.length > 0) {
    for (const mismatch of mismatches) console.error(`\nMISMATCH  ${mismatch}`)
    console.error(
      `\n${mismatches.length} mismatch(es): the real store does not behave as the fake claims.`,
    )
    process.exit(1)
  }
  console.log('\nThe Upstash adapter answered every question exactly as the memory adapter did.')
}

// Imported by a test, this module is only the comparison; run as a program, it is the smoke test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
