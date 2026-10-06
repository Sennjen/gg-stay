import type { SteamPriceFetch } from '../steam/steamPriceFetch'
import type { GraphQLContext } from './context'

/**
 * Where the time of one answer went, as a `Server-Timing` header: one entry for each upstream the
 * request called — RAWG, Steam, the index — and one for the whole.
 *
 *   rawg;dur=5012;desc="RAWG x3", index;dur=41;desc="Index x2", total;dur=5020
 *
 * The browser's network panel shows it under Timing, which is where a slow answer gets looked at.
 * `dur` is the upstream's slowest call in milliseconds, and the description says how many calls
 * there were: an answer waits for its slowest call, not for the sum, because the calls run side by
 * side.
 *
 * Three rules decide what a number means:
 *
 * - **It is what the request waited.** A call is timed from the moment a resolver made it to the
 *   moment it settled, so the limiter's queue and the transport's retry are in it — they are time
 *   the visitor spent too. The transport's own line about an attempt (`createUpstreamFetch`) times
 *   the upstream alone; this is the other number. Two requests that share one upstream request
 *   each report how long they waited themselves.
 * - **A call the answer stopped waiting for counts up to the answer.** The game page goes out
 *   after its budget whether RAWG has answered or not (`resolvers/game.ts`); the header is written
 *   at that moment, and a call that is still out has cost the answer exactly the time until then.
 * - **A cached answer is not a call.** The transport says when the cache answered and nobody was
 *   asked (`onCached`), and such a call is left out altogether. Everything else is a call: an
 *   answer the upstream gave, a failure, a request another caller had already sent — and, in
 *   fixture mode, a recorded fixture and the seeded index, which are that mode's upstreams.
 *
 * The header is made of fixed names and numbers and of nothing that came with the request: no URL,
 * no key, no query, no slug. And it is an extra: nothing here can fail a call or an answer — when
 * the clock cannot be read there is simply no header.
 */

export const SERVER_TIMING_HEADER = 'Server-Timing'

/** The upstreams an answer can have waited for, in the order the header names them. */
const UPSTREAMS = ['rawg', 'steam', 'index'] as const

export type TimedUpstream = (typeof UPSTREAMS)[number]

/** How the network panel labels each of them, before the number of calls. */
const LABELS: Record<TimedUpstream, string> = { rawg: 'RAWG', steam: 'Steam', index: 'Index' }

interface TimedCall {
  upstream: TimedUpstream
  startedAt: number
  /** Unset while the call is still out. */
  endedAt?: number
  /** The cache answered and the upstream was not asked: not a call at all. */
  cached: boolean
}

export interface ServerTiming {
  /**
   * Makes one call to `upstream` and times it. `call` is handed what the transport calls when the
   * cache answered instead (`onCached`); a caller with no cache to speak of ignores it.
   *
   * The promise returned is the very one `call` returned, so whoever awaits it sees exactly what
   * it would have seen without the measuring — the same value or the same failure, at the same
   * moment. A `call` that throws before returning one has asked nobody, and is not counted.
   */
  measure<T>(upstream: TimedUpstream, call: (onCached: () => void) => Promise<T>): Promise<T>
  /**
   * The header's value as things stand at this moment, or `null` when there is nothing true to
   * say — which is only when the clock could not be read.
   */
  header(): string | null
}

/**
 * The timing of one request, counted from this call. `now` is a millisecond clock that only moves
 * forward (`performance.now` when omitted); a test passes its own.
 */
export function createServerTiming(now: () => number = () => performance.now()): ServerTiming {
  /** The clock, or `NaN` — a time that spoils every duration it enters — when it cannot be read. */
  const read = (): number => {
    try {
      return now()
    } catch {
      return Number.NaN
    }
  }

  const startedAt = read()
  const calls: TimedCall[] = []

  return {
    measure(upstream, call) {
      const timed: TimedCall = { upstream, startedAt: read(), cached: false }
      const answer = call(() => {
        timed.cached = true
      })
      calls.push(timed)
      const settle = () => {
        timed.endedAt = read()
      }
      // On a branch of its own: it handles the failure for itself, and the caller's promise is
      // left exactly as the upstream made it.
      Promise.resolve(answer).then(settle, settle)
      return answer
    },

    header() {
      const at = read()
      const metrics: string[] = []
      for (const upstream of UPSTREAMS) {
        const asked = calls.filter((call) => call.upstream === upstream && !call.cached)
        if (asked.length === 0) continue
        const slowest = asked.reduce(
          (longest, call) => Math.max(longest, (call.endedAt ?? at) - call.startedAt),
          0,
        )
        if (!Number.isFinite(slowest)) return null
        metrics.push(
          `${upstream};dur=${Math.round(slowest)};desc="${LABELS[upstream]} x${asked.length}"`,
        )
      }
      const total = Math.max(0, at - startedAt)
      if (!Number.isFinite(total)) return null
      metrics.push(`total;dur=${Math.round(total)}`)
      return metrics.join(', ')
    },
  }
}

/**
 * Puts the header on an answer that is about to go out. An answer without it is still the answer,
 * so nothing that goes wrong here — a clock, or headers that will not be written to — is allowed
 * to reach whoever is sending it.
 */
export function writeServerTiming(headers: Pick<Headers, 'set'>, timing: ServerTiming): void {
  try {
    const value = timing.header()
    if (value !== null) headers.set(SERVER_TIMING_HEADER, value)
  } catch {
    // Nothing to do, and nothing to say: the header is for whoever reads the network panel.
  }
}

/**
 * The same context, with every upstream call a resolver makes through it timed.
 *
 * This is the seam the header is measured at, and deliberately not the transport: what a resolver
 * awaits is what the request waited, queue and retry included. Built once per request and before
 * anything reads the index, like `askContext` (`server/ask/pipeline.ts`), so the request's index
 * state — which is kept per context object — is one.
 *
 * - `rawg` and `steam` are the cached transports, and are told apart from their caches through
 *   `onCached`.
 * - `steamPrices` is the game page's live price read — see `timedSteamPrices`.
 * - Every read of the index is a call. The resolvers' own caches and once-per-request memos sit in
 *   front of the port, so what reaches it is what was asked. A read the circuit refuses
 *   (`server/index/index.ts`) shows as a call that took no time, which is what it cost.
 */
export function timedContext(context: GraphQLContext, timing: ServerTiming): GraphQLContext {
  const { rawg, steam, steamPrices, index } = context
  return {
    ...context,
    rawg: (path, params, options) =>
      timing.measure('rawg', (onCached) => rawg(path, params, { ...options, onCached })),
    steam: (appId, options) =>
      timing.measure('steam', (onCached) => steam(appId, { ...options, onCached })),
    steamPrices: timedSteamPrices(steamPrices, timing),
    // Called as methods: an adapter may be a class, whose methods a spread would not copy.
    index: {
      search: (query) => timing.measure('index', () => index.search(query)),
      getMany: (ids) => timing.measure('index', () => index.getMany(ids)),
      getOne: (id) => timing.measure('index', () => index.getOne(id)),
      idBySlug: (slug) => timing.measure('index', () => index.idBySlug(slug)),
      meta: () => timing.measure('index', () => index.meta()),
      allSlugs: () => timing.measure('index', () => index.allSlugs()),
    },
  }
}

/**
 * The Steam price port, with its reads timed as calls to Steam.
 *
 * The reads are taken from the port as it is rather than from a list kept here, so that one added
 * to it is timed from the day it is added, and cannot be handed to resolvers unmeasured — or not
 * at all. That is right for this port because none of its price reads has a cache to answer from
 * (`steamPriceFetch.ts`): every call asks Steam, so every call is a call. The resolver's own
 * memory of a price sits in front of the port and is not an upstream.
 *
 * The one exception is named: `fetchAppLanguages` belongs to the refresh job and no resolver calls
 * it. It reads through the cached per-app transport without a way to say that the cache answered,
 * so it is handed on unmeasured rather than counted wrongly.
 */
function timedSteamPrices(steamPrices: SteamPriceFetch, timing: ServerTiming): SteamPriceFetch {
  const timed = { ...steamPrices }
  for (const [name, read] of Object.entries(steamPrices) as [string, unknown][]) {
    if (name === 'fetchAppLanguages' || typeof read !== 'function') continue
    Object.assign(timed, {
      [name]: (...args: unknown[]) =>
        timing.measure('steam', () => read.apply(steamPrices, args) as Promise<unknown>),
    })
  }
  return timed
}
