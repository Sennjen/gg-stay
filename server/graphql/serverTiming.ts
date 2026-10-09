import type { GameIndex } from '../index/GameIndex'
import type { SteamPriceFetch } from '../steam/steamPriceFetch'
import type { SharedRead } from '../upstream/createUpstreamFetch'
import type { GraphQLContext, ResolverCache } from './context'

/**
 * Where the time of one answer went, as a `Server-Timing` header: one entry for each upstream the
 * request called — RAWG, Steam, the index — one for the cache every instance shares, when the
 * request read it, and one for the whole.
 *
 *   rawg;dur=5012;desc="RAWG x3", index;dur=41;desc="Index x2", total;dur=5020
 *   index;dur=41;desc="Index x2", cache;dur=12;desc="Cache 3 of 3", total;dur=58
 *
 * The browser's network panel shows it under Timing, which is where a slow answer gets looked at.
 * `dur` is the upstream's slowest call in milliseconds, and the description says how many calls
 * there were: an answer waits for its slowest call, not for the sum, because the calls run side by
 * side.
 *
 * Four rules decide what a number means:
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
 *   asked (`onCached`), and such a call is left out altogether; so is a read of the index that
 *   sent its store nothing (`timedIndex`). Everything else is a call: an answer the upstream
 *   gave, a failure, a request another caller had already sent — and, in fixture mode, a
 *   recorded fixture and the seeded index, which are that mode's upstreams.
 * - **The shared cache is named for its reads, not for its answers.** `cache` is there only when
 *   the request read the cache the instances share (`server/upstream/layeredCache.ts`): `dur` is
 *   the slowest of those reads, and the description says how many of them found what then
 *   answered — `Cache 2 of 3`. An answer out of this instance's own memory is no read, and neither
 *   is one the shared cache was not asked for because it is being left alone. This is what tells a
 *   first open that another instance's work answered (`Cache 3 of 3`, and no `rawg` at all) from
 *   one that asked RAWG (`Cache 0 of 3`, and `RAWG x3`). The reads are the transports' and the
 *   price cache's own measurements, told the moment each read is over — before the upstream is
 *   asked — so a page that went out at its budget, with RAWG still out, names the cache it read
 *   all the same. A read that two calls of one request shared is one read, and is counted once.
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

/** The header's name for the cache every instance shares, after the upstreams it stands in for. */
const SHARED_CACHE = 'cache'

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
   * Counts one read of the shared cache this request made: how long it took, and whether what it
   * found answered. Told by whoever made the read — a transport (`onSharedRead`), the price cache —
   * and safe to call at any moment, and to hand over unbound. A read is known by the object it is
   * told as: told twice — by two calls that shared it — it is still one read.
   */
  sharedRead(read: SharedRead): void
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
  const sharedReads = new Set<SharedRead>()

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

    sharedRead(read) {
      sharedReads.add(read)
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
      if (sharedReads.size > 0) {
        const reads = [...sharedReads]
        const slowest = reads.reduce((longest, { ms }) => Math.max(longest, ms), 0)
        if (!Number.isFinite(slowest)) return null
        const hits = reads.filter(({ hit }) => hit === true).length
        metrics.push(
          `${SHARED_CACHE};dur=${Math.round(slowest)};desc="Cache ${hits} of ${reads.length}"`,
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
 *   `onCached`; what their caches read of the shared level reaches the timing through
 *   `onSharedRead`.
 * - `steamPrices` is the game page's live price read — see `timedSteamPrices`.
 * - `index` is the six reads of the index port — see `timedIndex`.
 * - `cache` is the resolvers' own cache, whose live prices are kept in the shared level too — see
 *   `timedCache`.
 */
export function timedContext(context: GraphQLContext, timing: ServerTiming): GraphQLContext {
  const { rawg, steam, steamPrices, index, cache } = context
  const onSharedRead = (read: SharedRead) => timing.sharedRead(read)
  return {
    ...context,
    rawg: (path, params, options) =>
      timing.measure('rawg', (onCached) =>
        rawg(path, params, { ...options, onCached, onSharedRead }),
      ),
    steam: (appId, options) =>
      timing.measure('steam', (onCached) => steam(appId, { ...options, onCached, onSharedRead })),
    steamPrices: timedSteamPrices(steamPrices, timing),
    index: timedIndex(index, timing),
    cache: timedCache(cache, timing),
  }
}

/**
 * The resolvers' cache, with what it reads of the shared level counted.
 *
 * Nothing else about it is timed. A read it answers from memory waited for nobody, and what a
 * resolver does on a miss — the live Steam price read — is a call of its own, counted where it is
 * made (`timedSteamPrices`). A read and a write are passed on exactly as they were made.
 */
function timedCache(cache: ResolverCache, timing: ServerTiming): ResolverCache {
  const onSharedRead = (read: SharedRead) => timing.sharedRead(read)
  return {
    get: <T>(key: string) => cache.get<T>(key, onSharedRead),
    set: (key, value, ttlSeconds) => cache.set(key, value, ttlSeconds),
  }
}

/**
 * The index, with its reads timed as calls to its store — the ones that were calls.
 *
 * A read of the port is not always a request. The resolvers' own caches and once-per-request
 * memos sit in front of the port and never reach it; behind it, the Upstash adapter answers a
 * slug it has already found from memory and refuses one it could not hold without asking, and
 * the circuit turns a read away while it is open (`server/index/index.ts`). None of those waited
 * for anybody, and a header that named them would say `Index x3` of a page that asked the store
 * twice. So when the index counts the requests it sends (`GameIndex.storeRequests`, passed on by
 * every layer around the adapter), the count is read before a read and after it, and a read that
 * left it where it was is left out, exactly as a cached RAWG answer is.
 *
 * The count is one for the whole index, not one per read, so a read that sent nothing looks as
 * if it had when another read sent a request before it settled. It is then named, with the
 * little time it took: the harmless way to be wrong, and the same one the circuit accepts. The
 * other way round is rarer still and is accepted too — a read that sent nothing of its own but
 * waited for a request another read had sent is left out, though it did wait.
 *
 * An index that does not count is taken at its word, and every read of it is a call: the seeded
 * in-memory index of fixture mode is that mode's upstream, like a recorded fixture. An index
 * that is not configured counts, and its count never moves.
 */
function timedIndex(index: GameIndex, timing: ServerTiming): GameIndex {
  /** The requests sent so far, when the index counts them and the count can be read. */
  const sent = (): number | undefined => {
    try {
      return index.storeRequests?.()
    } catch {
      return undefined
    }
  }

  const read = <T>(call: () => Promise<T>): Promise<T> =>
    timing.measure('index', (onCached) => {
      const before = sent()
      const answer = call()
      if (before !== undefined) {
        // Registered before the timing's own handler, so the read is known for what it was by
        // the time it is timed; and on a branch of its own, like that one.
        const tell = () => {
          if (sent() === before) onCached()
        }
        Promise.resolve(answer).then(tell, tell)
      }
      return answer
    })

  // Called as methods: an adapter may be a class, whose methods a spread would not copy.
  return {
    search: (query) => read(() => index.search(query)),
    getMany: (ids) => read(() => index.getMany(ids)),
    getOne: (id) => read(() => index.getOne(id)),
    idBySlug: (slug) => read(() => index.idBySlug(slug)),
    meta: () => read(() => index.meta()),
    allSlugs: () => read(() => index.allSlugs()),
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
