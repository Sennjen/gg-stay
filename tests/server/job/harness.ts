import type { JobClock, JobDeps, JobIndex } from '../../../scripts/index/deps'
import { createRequestMeter, type RequestMeter } from '../../../scripts/index/requestMeter'
import { createJobRawg } from '../../../scripts/index/upstreams'
import { createMemoryGameIndex } from '../../../server/index/memoryIndex'
import { parseSteamPrice } from '../../../server/steam/price'
import { parseUkrainianSupport } from '../../../server/steam/languages'
import type { SteamAppLanguages, SteamPriceFetch } from '../../../server/steam/steamPriceFetch'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../../../server/rawg/rawgFetch'
import type { RawgGameListItem, RawgStoreLink } from '../../../server/rawg/types'
import {
  JOB_GAMES,
  JOB_STEAM_APPS,
  JOB_STEAM_PRICES,
  JOB_STORE_LINKS,
  jobGamesPage,
  jobStudioPage,
} from '../../fixtures/index/jobCatalog'
import {
  bankAnswer,
  gogCatalogPage,
  JOB_BANK_RATE,
  JOB_GOG_PRODUCTS,
  JOB_MICROSOFT_PRODUCTS,
  microsoftSearchAnswer,
} from '../../fixtures/index/jobStores'

/**
 * The refresh job's stages under test: the real in-memory index, a clock that only moves when the
 * job sleeps, and RAWG and Steam stand-ins that answer from `tests/fixtures/index/jobCatalog.ts`
 * — and GOG, Microsoft Store and National Bank stand-ins that answer from `jobStores.ts` beside
 * it — and count every call. Counting is the point — most of the job's rules ("never re-resolve an app
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

export interface FakeStores {
  gog: JobDeps['gog']
  microsoft: JobDeps['microsoft']
  microsoftCatalog: JobDeps['microsoftCatalog']
  bank: JobDeps['bank']
  /** GOG's catalog as the fake pages through it; a test may replace or edit the products. */
  gogCatalog: { products: unknown[]; pageSize: number }
  /** The pages of the catalog that were asked for, in order. */
  gogPages: number[]
  /** Makes every later request for this page of the catalog reject, as a GOG outage does. */
  failGogPage: (page: number) => void
  /** Makes the first later request for this page resolve with `body` instead of the page. */
  answerGogPageWith: (page: number, body: unknown) => void
  /** What the Microsoft Store has, by product id; an id it does not hold is left out of an answer. */
  microsoftProducts: Record<string, unknown>
  /** The batches of product ids that were asked about, in order. */
  microsoftBatches: string[][]
  /** Makes every later batch containing this product id reject. */
  failMicrosoftBatchWith: (id: string) => void
  /** Makes the first later batch resolve with `body` instead of the store's answer. */
  answerMicrosoftWith: (body: unknown) => void
  /**
   * What the Microsoft Store knows of a product with nothing filtered out, by product id
   * (`microsoftDetail`): its title, its group and its relations. Empty by default — a product
   * that is not here is one the store does not know.
   */
  microsoftDetails: Record<string, unknown>
  /** The batches of product ids that were asked about with nothing filtered out, in order. */
  microsoftDetailBatches: string[][]
  /** Makes every later unfiltered batch containing this product id reject with `error`. */
  failMicrosoftDetailsWith: (id: string, error?: Error) => void
  /**
   * What the store's search answers, by the name searched for (`microsoftSearchAnswer`). A name
   * that is not here is one the store sells nothing under.
   */
  microsoftSearches: Record<string, unknown>
  /** The names that were searched for, in order. */
  microsoftSearchNames: string[]
  /** Makes every later search for this name reject with `error`. */
  failMicrosoftSearchFor: (name: string, error?: Error) => void
  /** The rate the bank answers; a test may change it, or set what the bank answers instead. */
  bankState: { rate: number; down: boolean; answer: unknown }
  /** The days the bank was asked about, in order. */
  bankDays: string[]
}

/**
 * GOG, the Microsoft Store and the National Bank as the job's stages see them: each answers from
 * a small world a test may edit, records what it was asked, and can be made to fail.
 *
 * The Microsoft Store is three questions: what a batch of products costs (`microsoft`, as
 * `actionFilter=Purchase` answers), and the two a game without a price is asked about — what a
 * batch of products is related to, and what the store sells under a name (`microsoftCatalog`).
 */
export function createFakeStores(): FakeStores {
  const gogCatalog = { products: [...JOB_GOG_PRODUCTS] as unknown[], pageSize: 100 }
  const gogPages: number[] = []
  const gogFailures = new Set<number>()
  const gogAnswers = new Map<number, unknown>()
  const microsoftProducts: Record<string, unknown> = { ...JOB_MICROSOFT_PRODUCTS }
  const microsoftBatches: string[][] = []
  const microsoftFailures = new Set<string>()
  const microsoftAnswers: unknown[] = []
  const microsoftDetails: Record<string, unknown> = {}
  const microsoftDetailBatches: string[][] = []
  const microsoftDetailFailures = new Map<string, Error | undefined>()
  const microsoftSearches: Record<string, unknown> = {}
  const microsoftSearchNames: string[] = []
  const microsoftSearchFailures = new Map<string, Error | undefined>()
  const bankState = { rate: JOB_BANK_RATE, down: false, answer: undefined as unknown }
  const bankDays: string[] = []

  return {
    gog: async (page) => {
      gogPages.push(page)
      if (gogFailures.has(page)) throw new Error(`GOG upstream failure (page ${page})`)
      if (gogAnswers.has(page)) {
        const body = gogAnswers.get(page)
        gogAnswers.delete(page)
        return body
      }
      return gogCatalogPage(gogCatalog.products, page, gogCatalog.pageSize)
    },
    microsoft: async (ids) => {
      microsoftBatches.push([...ids])
      if (ids.some((id) => microsoftFailures.has(id))) {
        throw new Error('MICROSOFT upstream failure (batch)')
      }
      if (microsoftAnswers.length > 0) return microsoftAnswers.shift()
      // As `actionFilter=Purchase` answers: the products it has, and nothing about the rest.
      return {
        Products: ids.flatMap((id) => (id in microsoftProducts ? [microsoftProducts[id]] : [])),
      }
    },
    microsoftCatalog: {
      details: async (ids) => {
        microsoftDetailBatches.push([...ids])
        const failing = ids.find((id) => microsoftDetailFailures.has(id))
        if (failing !== undefined) {
          throw microsoftDetailFailures.get(failing) ?? new Error('MICROSOFT upstream failure')
        }
        // Without the filter: everything the store knows, and nothing about the rest.
        return {
          Products: ids.flatMap((id) => (id in microsoftDetails ? [microsoftDetails[id]] : [])),
        }
      },
      search: async (name) => {
        microsoftSearchNames.push(name)
        if (microsoftSearchFailures.has(name)) {
          throw microsoftSearchFailures.get(name) ?? new Error('MICROSOFT upstream failure')
        }
        return name in microsoftSearches ? microsoftSearches[name] : microsoftSearchAnswer()
      },
    },
    bank: async (date) => {
      bankDays.push(date)
      if (bankState.down) throw new Error('NBU upstream failure')
      return bankState.answer === undefined ? bankAnswer(date, bankState.rate) : bankState.answer
    },
    gogCatalog,
    gogPages,
    failGogPage: (page) => void gogFailures.add(page),
    answerGogPageWith: (page, body) => void gogAnswers.set(page, body),
    microsoftProducts,
    microsoftBatches,
    failMicrosoftBatchWith: (id) => void microsoftFailures.add(id),
    answerMicrosoftWith: (body) => void microsoftAnswers.push(body),
    microsoftDetails,
    microsoftDetailBatches,
    failMicrosoftDetailsWith: (id, error) => void microsoftDetailFailures.set(id, error),
    microsoftSearches,
    microsoftSearchNames,
    failMicrosoftSearchFor: (name, error) => void microsoftSearchFailures.set(name, error),
    bankState,
    bankDays,
  }
}

export interface JobHarness
  extends FakeRawg, FakeSteam, Omit<FakeStores, 'gog' | 'microsoft' | 'microsoftCatalog' | 'bank'> {
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
  const { gog, microsoft, microsoftCatalog, bank, ...fakeStores } = createFakeStores()
  const writer = options.writer ?? createMemoryGameIndex()
  const logs: string[] = []

  return {
    ...fakeRawg,
    ...fakeSteam,
    ...fakeStores,
    clock,
    writer,
    logs,
    deps: {
      rawg: fakeRawg.rawg,
      steam: fakeSteam.steam,
      gog,
      microsoft,
      microsoftCatalog,
      bank,
      writer,
      clock,
      log: (message) => void logs.push(message),
    },
  }
}

/** One request as it reached RAWG: the path under `/api/`, and the query without the key. */
export interface WireRequest {
  path: string
  params: Record<string, string>
  /** What `fetch` was told to do with a redirect, when it was told anything. */
  redirect: string | undefined
}

/** What RAWG answers one request with: a status and a body, or nothing before the timeout. */
export type WireAnswer = 'timeout' | { status: number; body?: unknown }

export interface RawgWire {
  /** RAWG behind `fetch`: a test installs it with `vi.stubGlobal('fetch', wire.fetch)`. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** Every request that reached RAWG, in order. A retry is a request like any other. */
  requests: WireRequest[]
  /** The requests for a page of the list, and those for a game's store links. */
  pageRequests: () => WireRequest[]
  lookupRequests: () => WireRequest[]
  /** The most-added order, page by page. A page that is not here does not exist (a 404). */
  pages: Map<number, RawgGameListItem[]>
  /** A game's store links by its slug; a game that is not here has none. */
  links: Map<string, RawgStoreLink[]>
  /** Has the next requests matching `match` answered with `answers`, one each, in order. */
  answerNext: (match: (request: WireRequest) => boolean, ...answers: WireAnswer[]) => void
  /** Called with every request before it is answered: how a test moves its clock under RAWG. */
  onRequest: ((request: WireRequest) => void) | null
}

/**
 * RAWG as the network sees it, for the rules that are statements about requests and not about
 * calls: how many were sent, in what order, and what a retry cost. It answers the two things the
 * job asks RAWG for — a page of the most-added order and a game's store links — from a small
 * world a test builds, and any request can be scripted to fail the way RAWG fails.
 *
 * The fake RAWG above stands in for the transport, and so never sees a retry. This stands in for
 * the network under the job's real transport (`createWireHarness`).
 */
export function createRawgWire(
  pages: Record<number, RawgGameListItem[]> = {},
  links: Record<string, RawgStoreLink[]> = {},
): RawgWire {
  const requests: WireRequest[] = []
  const scripted: { match: (request: WireRequest) => boolean; answers: WireAnswer[] }[] = []
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const wire: RawgWire = {
    requests,
    pageRequests: () => requests.filter((request) => request.path === 'games'),
    lookupRequests: () => requests.filter((request) => request.path.endsWith('/stores')),
    pages: new Map(Object.entries(pages).map(([page, games]) => [Number(page), games])),
    links: new Map(Object.entries(links)),
    answerNext: (match, ...answers) => void scripted.push({ match, answers }),
    onRequest: null,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.rawg.io')
        throw new Error(`Unexpected request to ${url.origin}`)
      const params = Object.fromEntries(url.searchParams)
      delete params.key
      const request: WireRequest = {
        path: url.pathname.replace(/^\/api\//, ''),
        params,
        redirect: init?.redirect,
      }
      requests.push(request)
      wire.onRequest?.(request)

      const script = scripted.find((entry) => entry.match(request))
      if (script) {
        const next = script.answers.shift()!
        if (script.answers.length === 0) scripted.splice(scripted.indexOf(script), 1)
        // What `AbortSignal.timeout` aborts a request with.
        if (next === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError')
        return answer(next.status, next.body ?? null)
      }

      if (request.path === 'games') {
        const page = Number(params.page ?? '1')
        const results = wire.pages.get(page)
        if (!results) return answer(404, { detail: 'Invalid page.' })
        const next = wire.pages.has(page + 1)
          ? `https://api.rawg.io/api/games?page=${page + 1}`
          : null
        return answer(200, { count: 1_000_000, next, previous: null, results })
      }
      const slug = /^games\/([^/]+)\/stores$/.exec(request.path)?.[1]
      if (slug === undefined) throw new Error(`Unexpected RAWG path ${request.path}`)
      const results = wire.links.get(slug) ?? []
      return answer(200, { count: results.length, next: null, previous: null, results })
    },
  }
  return wire
}

export interface WireHarness extends JobHarness {
  wire: RawgWire
  /** The meter the transport reports to, which is also `deps.rawgRequests`. */
  meter: RequestMeter
}

/**
 * The job harness with the transport `runCli` builds in place of the fake RAWG — `createJobRawg`,
 * with its limiter on the harness's clock, its retry, its cache and its request meter — over a
 * `RawgWire`. The test has to put the wire where the transport looks for the network:
 * `vi.stubGlobal('fetch', harness.wire.fetch)`.
 *
 * A second harness over the same `wire` and `writer` is a second run of the job: the same RAWG
 * and the same index, and a transport of its own with nothing in its cache.
 */
export function createWireHarness(
  options: {
    start?: string
    writer?: JobIndex
    wire?: RawgWire
    pages?: Record<number, RawgGameListItem[]>
    links?: Record<string, RawgStoreLink[]>
  } = {},
): WireHarness {
  const harness = createJobHarness({ start: options.start, writer: options.writer })
  const wire = options.wire ?? createRawgWire(options.pages, options.links)
  const meter = createRequestMeter()
  const rawg = createJobRawg({ apiKey: 'test-key', fixtures: false, clock: harness.clock, meter })
  return { ...harness, wire, meter, deps: { ...harness.deps, rawg, rawgRequests: meter } }
}
