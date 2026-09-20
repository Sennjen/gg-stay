import type { JobClock, JobDeps, JobIndex } from '../../../scripts/index/deps'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { parseSteamPrice } from '../../../server/steam/price'
import { parseUkrainianSupport } from '../../../server/steam/languages'
import type { SteamAppLanguages, SteamPriceFetch } from '../../../server/steam/steamPriceFetch'
import {
  JOB_STEAM_APPS,
  JOB_STEAM_PRICES,
  JOB_STORE_LINKS,
  jobGamesPage,
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
  pageCalls: () => RawgCall[]
  /** Makes the first later call matching `match` reject, the way a dropped run would see it. */
  failNext: (match: (call: RawgCall) => boolean) => void
}

export function createFakeRawg(): FakeRawg {
  const calls: RawgCall[] = []
  const failures: ((call: RawgCall) => boolean)[] = []

  const rawg: JobDeps['rawg'] = async (path, params) => {
    const flat = Object.fromEntries(
      Object.entries(params ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    )
    const call = { path, params: flat }
    calls.push(call)
    const failureIndex = failures.findIndex((match) => match(call))
    if (failureIndex !== -1) {
      failures.splice(failureIndex, 1)
      throw new Error(`RAWG upstream failure (${path})`)
    }
    if (path === 'games') return jobGamesPage(Number(flat.page ?? '1'))
    const storeMatch = /^games\/(\d+)\/stores$/.exec(path)
    if (storeMatch) {
      return JOB_STORE_LINKS[Number(storeMatch[1])] ?? { count: 0, next: null, results: [] }
    }
    throw new Error(`Unexpected RAWG path ${path}`)
  }

  return {
    rawg,
    calls,
    storeCalls: () => calls.filter((call) => call.path.endsWith('/stores')),
    pageCalls: () => calls.filter((call) => call.path === 'games'),
    failNext: (match) => void failures.push(match),
  }
}

export interface SteamLanguageCall {
  appId: string
  at: number
}

export interface FakeSteam {
  steam: SteamPriceFetch
  priceBatches: string[][]
  languageCalls: SteamLanguageCall[]
  failLanguagesOnce: (appId: string) => void
}

export function createFakeSteam(clock: JobClock): FakeSteam {
  const priceBatches: string[][] = []
  const languageCalls: SteamLanguageCall[] = []
  const failures = new Set<string>()

  const steam: SteamPriceFetch = {
    fetchPrices: async (appIds) => {
      priceBatches.push([...appIds])
      return new Map(appIds.map((id) => [id, parseSteamPrice(JOB_STEAM_PRICES[id])]))
    },
    fetchAppLanguages: async (appId): Promise<SteamAppLanguages> => {
      languageCalls.push({ appId, at: clock.now() })
      if (failures.has(appId)) {
        failures.delete(appId)
        throw new Error(`STEAM upstream failure (${appId})`)
      }
      const entry = JOB_STEAM_APPS[appId] as
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
    priceBatches,
    languageCalls,
    failLanguagesOnce: (appId: string) => void failures.add(appId),
  }
}

export interface JobHarness extends FakeRawg, FakeSteam {
  deps: JobDeps
  writer: JobIndex
  clock: FakeClock
  logs: string[]
}

export function createJobHarness(options: { start?: string; writer?: JobIndex } = {}): JobHarness {
  const clock = createFakeClock(options.start)
  const fakeRawg = createFakeRawg()
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
