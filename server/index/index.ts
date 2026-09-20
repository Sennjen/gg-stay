import type { GameIndex, IndexQuery, IndexSearchResult } from './GameIndex'
import type { IndexMeta, IndexedGame } from './document'
import { createMemoryGameIndex } from './memoryIndex'
import { createUpstashCommands, createUpstashIndex } from './upstashIndex'

/**
 * Which index a request reads: Upstash when both credentials are configured, the in-memory
 * adapter seeded from the fixture in fixture mode, and an index that knows nothing otherwise —
 * see `createGameIndex` for why that last case is not the fixture.
 *
 * Whatever a page gets back, it is one of exactly two shapes, and the difference between them
 * matters:
 *
 * - **Configured to know nothing** (`unavailableGameIndex`) answers quietly: `meta()` is `null`,
 *   `getMany` and `getOne` find nothing, only `search` rejects. Nothing failed, so nothing is
 *   logged and no page reports the index as stale.
 * - **Something went wrong** — a rejection, or a call that passed its deadline —
 *   (`degradeOnFailure`) rejects from *every* method with `IndexUnavailableError`. A caller has to
 *   be able to tell "this index holds nothing" from "this index just let me down", because a
 *   request that has been let down once stops asking (`indexFailed` in
 *   `server/graphql/indexPath.ts`) and the process skips the index for half a minute
 *   (`withCircuit`). Every caller in the site catches; the design's rule is that no page fails
 *   because of the index, not that no call rejects.
 *
 * Three wrappers enforce that, innermost first: `withDeadline` turns a hang into a failure,
 * `withCircuit` stops paying for a store that is failing or merely slow, and `degradeOnFailure`
 * gives whatever comes out its one name.
 *
 * One instance per server process, and a failed attempt to build one is never remembered: a store
 * that was unreachable when the first request arrived may answer the next one.
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
 * The same index, with whatever the transport raised turned into one `IndexUnavailableError`.
 *
 * Every method rejects, including the three that could answer "nothing" instead. The difference
 * between "this index holds nothing" and "this index just failed" is one a caller has to be able
 * to see: a request that has been let down once stops asking for the rest of its life (see
 * `indexFailed` in `server/graphql/indexPath.ts`), and a quiet empty answer would hide that and
 * buy another deadline per call. An index that is *configured* to know nothing —
 * `unavailableGameIndex` — is the quiet one, and that is deliberate: nothing failed there.
 *
 * Every caller in the site already catches; the port's rule is that no page fails because of the
 * index, not that no call rejects.
 */
export function degradeOnFailure(
  index: GameIndex,
  onError: (error: unknown) => void = () => undefined,
): GameIndex {
  async function attempt<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      onError(error)
      if (error instanceof IndexUnavailableError) throw error
      throw new IndexUnavailableError('the store did not answer')
    }
  }
  return {
    search: (query: IndexQuery) => attempt(() => index.search(query)),
    getMany: (ids: number[]) => attempt(() => index.getMany(ids)),
    getOne: (id: number) => attempt(() => index.getOne(id)),
    meta: () => attempt(() => index.meta()),
  }
}

/**
 * How long any one index call may take before the site gives up on it. The index is an
 * enhancement and has to fit comfortably inside the 5 s budget the RAWG page it replaces would
 * have used, so it is deliberately short.
 */
export const DEFAULT_INDEX_TIMEOUT_MS = 1_500

/** How long the whole process skips the index after one call failed or timed out. */
export const CIRCUIT_OPEN_MS = 30_000

/**
 * Past this, a call that *succeeded* still counts against the index. The deadline catches a store
 * that has stopped answering; this catches one that answers, every time, too late to be worth
 * waiting for — which no failure count would ever notice.
 */
export const DEFAULT_INDEX_SLOW_MS = 700

/** How many consecutive slow answers open the circuit. A fast one puts the count back to zero. */
export const SLOW_STRIKES = 3

/** The timer pair, injected so a test can drive a deadline without waiting for one. */
export interface TimerFunctions {
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: TimerFunctions = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A deadline on every call. `degradeOnFailure` converts a *rejection*; a promise that never
 * settles is never converted, and every page awaits `meta()` before it does anything else — so
 * without this a store that accepts a connection and then goes quiet stalls the render until the
 * platform kills the function, on a page that was supposed to fall back to RAWG in milliseconds.
 * The REST client's own retries are turned off beside this (see `createGameIndex`), because a
 * backoff inside a budget this small can only spend it.
 */
export function withDeadline(
  index: GameIndex,
  options: { timeoutMs?: number; setTimer?: TimerFunctions } = {},
): GameIndex {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS
  const timers = options.setTimer ?? realTimers

  function race<T>(call: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const handle = timers.setTimeout(() => {
        if (settled) return
        settled = true
        reject(new IndexUnavailableError(`it did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        timers.clearTimeout(handle)
        action()
      }
      call().then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error as Error)),
      )
    })
  }

  return {
    search: (query) => race(() => index.search(query)),
    getMany: (ids) => race(() => index.getMany(ids)),
    getOne: (id) => race(() => index.getOne(id)),
    meta: () => race(() => index.meta()),
  }
}

/**
 * One failure — or three slow answers in a row — takes the index out of play for the whole
 * process for `CIRCUIT_OPEN_MS`, so a store that is down costs one deadline rather than one per
 * request, and one that is merely slow costs three answers rather than one on every request for
 * as long as it lasts. While the circuit is open the calls do not leave the process at all.
 *
 * The slow count is what a failure count cannot see. A store answering steadily at 1 400 ms never
 * rejects and never reaches its deadline, so nothing else here would ever notice it — and every
 * page would keep paying for an enhancement it is not getting in time. Three *consecutive* slow
 * answers, rather than three anywhere, is what keeps a single slow call during normal traffic
 * from closing the index: one fast answer puts the count back to zero.
 *
 * Deliberately tiny otherwise: no half-open state, no failure rate. The index is an enhancement,
 * the cost of skipping it for thirty seconds is a page without prices, and the cost of not
 * skipping it is paid by every visitor.
 */
export function withCircuit(
  index: GameIndex,
  options: {
    openMs?: number
    slowMs?: number
    strikes?: number
    now?: () => number
    onOpen?: (reason: 'failed' | 'slow') => void
  } = {},
): GameIndex {
  const openMs = options.openMs ?? CIRCUIT_OPEN_MS
  const slowMs = options.slowMs ?? DEFAULT_INDEX_SLOW_MS
  const strikeLimit = options.strikes ?? SLOW_STRIKES
  const now = options.now ?? (() => Date.now())
  let openedAt: number | null = null
  let strikes = 0

  const isOpen = () => openedAt !== null && now() - openedAt < openMs

  function open(reason: 'failed' | 'slow'): void {
    openedAt = now()
    strikes = 0
    options.onOpen?.(reason)
  }

  async function through<T>(call: () => Promise<T>): Promise<T> {
    if (isOpen()) {
      throw new IndexUnavailableError('it failed recently and is being skipped')
    }
    const startedAt = now()
    let value: T
    try {
      value = await call()
    } catch (error) {
      open('failed')
      throw error as Error
    }
    if (now() - startedAt <= slowMs) {
      strikes = 0
      return value
    }
    strikes += 1
    // The answer this call waited for is still served: it is already here, and throwing it away
    // would make the page worse for the sake of the one after it.
    if (strikes >= strikeLimit) open('slow')
    return value
  }

  return {
    search: (query) => through(() => index.search(query)),
    getMany: (ids) => through(() => index.getMany(ids)),
    getOne: (id) => through(() => index.getOne(id)),
    meta: () => through(() => index.meta()),
  }
}

export interface GameIndexSources {
  upstashRedisRestUrl: string
  upstashRedisRestToken: string
  /**
   * Fixture mode — the one switch every upstream in this project reads (`RAWG_FIXTURES=1`). It is
   * the ONLY configuration in which the seeded fixture index is used. See `createGameIndex`.
   */
  fixtures: boolean
  /** The published fixture a development server is seeded from, or `null` when there is none. */
  readFixture: () => Promise<PublishedFixture | null>
  /** When the fixture is published, so a development index does not report itself as stale. */
  seededAt?: () => string
  onError?: (error: unknown) => void
  /** How long a call may take before it counts as a failure; see `withDeadline`. */
  timeoutMs?: number
  /** How long a failure keeps the index out of play for this process; see `withCircuit`. */
  circuitOpenMs?: number
  /** Past this, an answer counts as slow even though it arrived; see `withCircuit`. */
  slowMs?: number
  /** Injected for the tests; the default races a real timer. */
  setTimer?: TimerFunctions
  /** Injected for the tests; the default reads the clock. */
  now?: () => number
}

/**
 * Which index a request reads.
 *
 * - Both Upstash credentials set: the Upstash adapter, whatever else is configured.
 * - Otherwise, **only in fixture mode**: the in-memory adapter seeded from the shipped fixture, so
 *   development and CI work without credentials.
 * - Otherwise: the explicit unavailable index, and one warning.
 *
 * The middle case is deliberately narrow. The fixture describes real, named games with plausible
 * commercial prices, and a deployment that lost an environment variable must not answer with them
 * — the design's failure behaviour for "not configured" is the same as for "unreachable": the
 * catalog runs on RAWG without prices. Outside fixture mode the seed asset is never even read.
 */
export async function createGameIndex(sources: GameIndexSources): Promise<GameIndex> {
  const report = sources.onError ?? ((error: unknown) => console.warn('[index]', error))
  try {
    const url = sources.upstashRedisRestUrl
    const token = sources.upstashRedisRestToken
    if (url && token) {
      // `retry: false`: a deadline of a second and a half leaves no room for a backoff, and a
      // retried slow request is a multiplied one. The refresh job keeps the client's default.
      const commands = createUpstashCommands({ url, token, retry: false })
      return guard(createUpstashIndex(commands), sources, report)
    }
    if (!sources.fixtures) {
      const reason = url || token ? 'only one credential is configured' : 'no credentials are set'
      report(new Error(`The game index is not configured: ${reason}. Serving no prices.`))
      return unavailableGameIndex(reason)
    }
    return guard(await seedFromFixture(sources), sources, report)
  } catch (error) {
    report(error)
    return unavailableGameIndex('it could not be built')
  }
}

/**
 * The three layers every index the site reads is wrapped in, innermost first: a deadline, so a
 * hang is a failure; a circuit, so a failure is not paid for again for half a minute; and the
 * degradation that turns whatever comes out into the one shape every caller handles.
 */
function guard(
  index: GameIndex,
  sources: GameIndexSources,
  report: (error: unknown) => void,
): GameIndex {
  const deadlined = withDeadline(index, {
    timeoutMs: sources.timeoutMs,
    setTimer: sources.setTimer,
  })
  return degradeOnFailure(
    withCircuit(deadlined, {
      openMs: sources.circuitOpenMs,
      slowMs: sources.slowMs,
      now: sources.now,
      onOpen: (reason) =>
        report(
          new Error(
            reason === 'slow'
              ? 'The game index answered too slowly too many times; skipping it for a while.'
              : 'The game index failed; skipping it for a while.',
          ),
        ),
    }),
    report,
  )
}

/**
 * The recorded timeline moved forward so that the run the fixture describes ends at `seededAt`.
 * A price the fixture recorded three hours before its run stays three hours old.
 */
function shiftPriceTimestamps(
  games: readonly IndexedGame[],
  recordedAt: string,
  seededAt: string,
): IndexedGame[] {
  const shift = Date.parse(seededAt) - Date.parse(recordedAt)
  if (!Number.isFinite(shift)) return [...games]
  return games.map((game) => {
    const recorded = game.priceUpdatedAt === null ? NaN : Date.parse(game.priceUpdatedAt)
    if (!Number.isFinite(recorded)) return game
    return { ...game, priceUpdatedAt: new Date(recorded + shift).toISOString() }
  })
}

async function seedFromFixture(sources: GameIndexSources): Promise<GameIndex> {
  const index = createMemoryGameIndex()
  const fixture = await sources.readFixture()
  if (!fixture) return index

  // The fixture is published as if it had just been built, so a development server does not
  // report the index as stale the week after the fixture was recorded, and does not ask Steam to
  // refresh every price it serves. Nothing reads these timestamps from a clock on the client, so
  // they cannot disagree with a hydrated page.
  const seededAt = (sources.seededAt ?? (() => new Date().toISOString()))()
  const recordedAt = fixture.meta.pricesUpdatedAt ?? fixture.meta.updatedAt
  const games = shiftPriceTimestamps(fixture.games, recordedAt, seededAt)

  const version = await index.beginVersion()
  await index.writeVersion(version, games)
  await index.publish(version, {
    ...fixture.meta,
    version,
    gameCount: games.length,
    updatedAt: seededAt,
    pricesUpdatedAt: seededAt,
  })
  return index
}

let instance: Promise<GameIndex> | undefined

export function useGameIndex(): Promise<GameIndex> {
  if (!instance) {
    const config = useRuntimeConfig()
    // Env overrides are parsed by destr, so "1" may arrive as the number 1 — the same reading
    // `useRawg`, `useSteam` and `useSteamPrices` do.
    const fixtures = String(config.rawgFixtures) === '1'
    instance = createGameIndex({
      upstashRedisRestUrl: String(config.upstashRedisRestUrl ?? ''),
      upstashRedisRestToken: String(config.upstashRedisRestToken ?? ''),
      fixtures,
      timeoutMs: Number(config.indexTimeoutMs) || undefined,
      slowMs: Number(config.indexSlowMs) || undefined,
      // Read only in fixture mode: outside it the asset is never touched, so nothing can serve
      // its prices by accident.
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
