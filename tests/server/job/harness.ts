import type { JobClock, JobDeps, JobIndex } from '../../../scripts/index/deps'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { parseSteamPrice } from '../../../server/steam/price'
import { parseUkrainianSupport } from '../../../server/steam/languages'
import type { SteamAppLanguages, SteamPriceFetch } from '../../../server/steam/steamPriceFetch'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../../../server/rawg/rawgFetch'
import type { RawgGameListItem } from '../../../server/rawg/types'
import {
  JOB_GAMES,
  JOB_STEAM_APPS,
  JOB_STEAM_PRICES,
  JOB_STORE_LINKS,
  jobGamesPage,
  jobStudioPage,
} from '../../fixtures/index/jobCatalog'

/**
 * The refresh job's stages under test: the real in-memory index, a clock that only moves when the
 * job sleeps, and RAWG and Steam stand-ins that answer from `tests/fixtures/index/jobCatalog.ts`
 * and count every call. Counting is the point — most of the job's rules ("never re-resolve an app
 * id", "at most forty language requests a minute", "resume without repeating a page") are
 * statements about which upstream requests happen, not about the data that comes back.
 */

export interface FakeClock extends JobClock {
  advance: (ms: number) => void
}

export function createFakeClock(start = '2026-09-20T03:00:00.000Z'): FakeClock {
  let now = Date.parse(start)
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

export interface RawgCall {
  path: string
  params: Record<string, string>
}

export interface FakeRawg {
  rawg: JobDeps['rawg']
  calls: RawgCall[]
  /** The paths of `games/{id}/stores` calls, which the app-id rules are counted in. */
  storeCalls: () => RawgCall[]
  /** The popularity walk's `games` calls. */
  pageCalls: () => RawgCall[]
  /** The studios stage's `games?developers=<slug>` calls. */
  studioCalls: () => RawgCall[]
  /**
   * Makes the first later call matching `match` reject, the way a dropped run would see it — with
   * `error` when given, e.g. the transport's `NOT_FOUND` for a slug RAWG does not know.
   */
  failNext: (match: (call: RawgCall) => boolean, error?: Error) => void
  /** Makes the first later call matching `match` resolve with `body` instead of the real page. */
  answerNextWith: (match: (call: RawgCall) => boolean, body: unknown) => void
}

/**
 * `studios` is what `games?developers=<slug>` lists per slug (`JOB_STUDIO_GAMES` in the studio
 * tests); a slug it does not name has no games, so a test that is not about the studios stage
 * sees the stage find nothing.
 */
export function createFakeRawg(studios: Record<string, RawgGameListItem[]> = {}): FakeRawg {
  const calls: RawgCall[] = []
  const failures: { match: (call: RawgCall) => boolean; error?: Error }[] = []
  const answers: { match: (call: RawgCall) => boolean; body: unknown }[] = []

  const rawg: JobDeps['rawg'] = async (path, params) => {
    const flat = Object.fromEntries(
      Object.entries(params ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    )
    const call = { path, params: flat }
    calls.push(call)
    const failureIndex = failures.findIndex((failure) => failure.match(call))
    if (failureIndex !== -1) {
      const [failure] = failures.splice(failureIndex, 1)
      throw failure!.error ?? new Error(`RAWG upstream failure (${path})`)
    }
    const answerIndex = answers.findIndex((answer) => answer.match(call))
    if (answerIndex !== -1) return answers.splice(answerIndex, 1)[0]!.body
    if (path === 'games' && flat.developers) {
      return jobStudioPage(studios, flat.developers, Number(flat.page ?? '1'))
    }
    if (path === 'games') return jobGamesPage(Number(flat.page ?? '1'))
    const storeMatch = /^games\/([a-z0-9-]+)\/stores$/.exec(path)
    if (storeMatch) {
      const game = [...JOB_GAMES, ...Object.values(studios).flat()].find(
        (entry) => entry.slug === storeMatch[1],
      )
      return (game?.id && JOB_STORE_LINKS[game.id]) ?? { count: 0, next: null, results: [] }
    }
    throw new Error(`Unexpected RAWG path ${path}`)
  }

  return {
    rawg,
    calls,
    storeCalls: () => calls.filter((call) => call.path.endsWith('/stores')),
    pageCalls: () => calls.filter((call) => call.path === 'games' && !call.params.developers),
    studioCalls: () => calls.filter((call) => call.path === 'games' && !!call.params.developers),
    failNext: (match, error) => void failures.push({ match, error }),
    answerNextWith: (match, body) => void answers.push({ match, body }),
  }
}

/**
 * The real RAWG transport (`createRawgFetch`, with the job's kind of in-memory cache) in front of a
 * scripted network: each request takes the next body from `bodies`, all under a 200. The fake RAWG
 * above answers the stages directly and so cannot show what the transport's cache does to a
 * stage's retry; this can.
 */
export function createTransportRawg(bodies: unknown[]): { rawg: RawgFetch; urls: string[] } {
  const urls: string[] = []
  const cache = new Map<string, CacheEntry>()
  let now = Date.parse('2026-09-20T03:00:00.000Z')
  const rawg = createRawgFetch({
    apiKey: 'test-key',
    fixtures: false,
    fetchJson: async (url) => {
      urls.push(url)
      return { status: 200, body: bodies.shift() ?? null }
    },
    readFixture: async () => null,
    cache: {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, entry) => void cache.set(key, entry),
    },
    now: () => now,
    sleep: async (ms) => void (now += ms),
  })
  return { rawg, urls }
}

export interface SteamLanguageCall {
  appId: string
  at: number
}

export interface FakeSteam {
  steam: SteamPriceFetch
  /** The `appdetails` price entries the fake answers from; a test may edit them mid-run. */
  steamPrices: Record<string, unknown>
  /** The unfiltered `appdetails` entries, likewise editable. */
  steamApps: Record<string, unknown>
  priceBatches: string[][]
  languageCalls: SteamLanguageCall[]
  failLanguagesOnce: (appId: string) => void
  /** Makes every later price chunk containing `appId` reject, as a soft Steam outage does. */
  failPriceChunkWith: (appId: string) => void
}

export function createFakeSteam(clock: JobClock): FakeSteam {
  const priceBatches: string[][] = []
  const languageCalls: SteamLanguageCall[] = []
  const failures = new Set<string>()
  const chunkFailures = new Set<string>()
  const steamPrices: Record<string, unknown> = { ...JOB_STEAM_PRICES }
  const steamApps: Record<string, unknown> = { ...JOB_STEAM_APPS }

  const steam: SteamPriceFetch = {
    fetchPrices: async (appIds) => {
      priceBatches.push([...appIds])
      if (appIds.some((id) => chunkFailures.has(id))) {
        throw new Error('STEAM upstream failure (price chunk)')
      }
      return new Map(appIds.map((id) => [id, parseSteamPrice(steamPrices[id])]))
    },
    // The game page's read of one app. The job prices in batches and never asks this way.
    fetchPrice: async () => {
      throw new Error("the refresh job was not expected to read one app's price")
    },
    fetchAppLanguages: async (appId): Promise<SteamAppLanguages> => {
      languageCalls.push({ appId, at: clock.now() })
      if (failures.has(appId)) {
        failures.delete(appId)
        throw new Error(`STEAM upstream failure (${appId})`)
      }
      const entry = steamApps[appId] as
        { data?: { is_free?: boolean; supported_languages?: string } } | undefined
      const isFree = entry?.data?.is_free === true
      return {
        ukrainian: parseUkrainianSupport(entry?.data?.supported_languages, isFree),
        isFree,
        price: parseSteamPrice(entry),
      }
    },
  }

  return {
    steam,
    steamPrices,
    steamApps,
    priceBatches,
    languageCalls,
    failLanguagesOnce: (appId: string) => void failures.add(appId),
    failPriceChunkWith: (appId: string) => void chunkFailures.add(appId),
  }
}

export interface JobHarness extends FakeRawg, FakeSteam {
  deps: JobDeps
  writer: JobIndex
  clock: FakeClock
  logs: string[]
}

export function createJobHarness(
  options: {
    start?: string
    writer?: JobIndex
    studios?: Record<string, RawgGameListItem[]>
  } = {},
): JobHarness {
  const clock = createFakeClock(options.start)
  const fakeRawg = createFakeRawg(options.studios)
  const fakeSteam = createFakeSteam(clock)
  const writer = options.writer ?? createMemoryGameIndex()
  const logs: string[] = []

  return {
    ...fakeRawg,
    ...fakeSteam,
    clock,
    writer,
    logs,
    deps: {
      rawg: fakeRawg.rawg,
      steam: fakeSteam.steam,
      writer,
      clock,
      log: (message) => void logs.push(message),
    },
  }
}
