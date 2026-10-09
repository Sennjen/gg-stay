import { UpstreamError, type UpstreamSource } from './errors'

/**
 * The transport every third-party API in this app goes through: one request at a time per
 * `minIntervalMs`, an abort-signal timeout, one retry on a timeout or a 5xx, a read-through cache
 * with a per-request ttl, and the cached value served as a fallback when a refresh fails
 * (stale-if-error). RAWG and Steam had a near-verbatim copy of all of it each, which is how the
 * Steam transport ended up throwing errors that said "RAWG".
 *
 * A call for something another call is already fetching joins that request instead of sending a
 * second one — see `inFlight` below for exactly which calls count as the same. That makes one rule
 * for every caller: what a call resolves with is read-only, because the same object may be in
 * another caller's hands, and in the cache's.
 *
 * An answer may also be served for a while after its ttl has run out, while a new one is fetched
 * behind it — the stale window, see `staleFor`. It is a property of a request, like the ttl, and
 * of a runtime that can keep a refresh running after the answer has gone out (`keepAlive`).
 *
 * Everything that differs between the two is a parameter: the source name, the throttle interval,
 * how a request becomes a URL, a cache key, a fixture name, a ttl and a stale window, and an
 * optional projection applied before a payload is cached. Everything the caller must be able to
 * substitute in a test (fetch, fixtures, cache, clock, sleep, the log, the keep-alive) is injected,
 * which is what lets the transport tests drive throttling, retries and clock drift
 * deterministically without a mock library.
 */

/**
 * How long after it was stored an answer with a stale window may still be served while it is
 * refreshed: a week. RAWG's description of a game, its store links and its screenshots change
 * rarely and carry no price; a day-old copy shown at once is a better page than a fresh one a
 * visitor waits seconds for. Which requests have the window is each upstream's own rule
 * (`staleFor`), and Steam's have none. The design is in
 * `docs/specs/2026-10-09-shared-upstream-cache-design.md`.
 */
export const STALE_WHILE_REVALIDATE_SECONDS = 7 * 86_400

/**
 * How far ahead the limiter's next free slot may be for a refresh behind a stale answer still to
 * be started: two seconds. Past that the refresh is not started at all.
 *
 * A refresh is the one request in the limiter's line that nobody is waiting for, and the only
 * one that is optional: the entry it would replace can be served for days yet. But it takes a
 * slot like any request, and stale answers are handed over in milliseconds — so a walk over stale
 * pages (a crawler, two days after its last visit) would queue refreshes far faster than the
 * limiter lets them out, and every request a visitor is waiting for would stand behind them:
 * twelve stale game pages asked for at once put a cold page's first request nine seconds away.
 * Bounded like this, what stands in front of a visitor's request is two seconds of refreshes at
 * the most — inside the two and a half the game page gives RAWG before it answers from the index
 * — and no refresh outlives by much the answer that set it off. The entry stays as it is, and the
 * next view of it tries again.
 */
export const REFRESH_BACKLOG_LIMIT_MS = 2_000

export interface UpstreamCacheEntry {
  value: unknown
  expiresAt: number
  /**
   * When the upstream was asked for this body, on the clock `expiresAt` is counted on. The stale
   * window is measured from it, and a cache with a second level tells the newer of two entries by
   * it (`server/upstream/layeredCache.ts`).
   *
   * It is kept beside `expiresAt` rather than worked out from it, because the ttl that would have
   * to be subtracted is the writer's: a call may name its own (`ttlFor`), and an entry in a cache
   * that outlives a deployment may have been written under another build's. An entry without it —
   * one a cache was handed by something other than this transport — has no stale window: past
   * `expiresAt` it is expired, as every entry was before the window existed.
   */
  storedAt?: number
}

/**
 * A read the cache made beyond this instance's memory: of a level it shares with other instances.
 * The transport has no idea what that level is. It only passes the word on, to the caller that
 * measures what its calls cost (`onSharedRead`), because such a read is the one thing a cache does
 * that takes a request real time.
 */
export interface SharedRead {
  /** How long the read took, in milliseconds. */
  ms: number
  /**
   * Whether what it found answered the call by itself, and spared the upstream the request: a
   * fresh entry, or one handed over while it is refreshed. The cache says whether it took an entry
   * from there; the transport takes that back when the entry was too old to answer and the
   * upstream had to be asked — even if the upstream then failed and the entry stood in for it.
   */
  hit: boolean
}

/**
 * An answer has to be fresh for at least this long to be kept beyond the instance that fetched
 * it: a day.
 */
export const SHAREABLE_MIN_TTL_SECONDS = 86_400

/**
 * Whether an answer may be kept where other instances can read it: when it is fresh for a day or
 * longer, and nothing in its request was typed by a visitor. The one rule, for every upstream.
 *
 * The cache every instance shares is metered, and what it is for is the answers that are asked
 * for again: a game's own pages, the taxonomies, the landing's day-long lists, Steam's page about
 * an app. A ten-minute list is the largest body there is and is stale before another instance
 * has much chance to want it; and a request that carries what a visitor typed — a search term —
 * has a key space nobody bounds, each key of it read once and written once and almost never
 * asked for again. Both stay in the instance's memory alone, exactly as they always did
 * (`docs/specs/2026-10-09-shared-upstream-cache-design.md`, section 1).
 */
export function isShareable(ttlSeconds: number, typed: boolean): boolean {
  return !typed && ttlSeconds >= SHAREABLE_MIN_TTL_SECONDS
}

/** What the transport says of a read, for a cache with more to it than a map. A map ignores it. */
export interface CacheReadOptions {
  /** Whether the answer may be looked for beyond this instance's memory (`isShareable`). */
  shareable?: boolean
  /** Called, before `get` resolves, when the read did go beyond memory. */
  onSharedRead?: (read: SharedRead) => void
}

/** What the transport says of a write, for a cache with more to it than a map. A map ignores it. */
export interface CacheWriteOptions {
  /** Whether the entry may be kept beyond this instance's memory (`isShareable`). */
  shareable?: boolean
  /**
   * The stale window of the request the entry answers, which is how long past its freshness the
   * entry is still worth keeping.
   */
  staleSeconds?: number
}

/**
 * Where answers are kept. `get` resolves with whatever is held under the key, however old —
 * an entry past its `expiresAt` is the fallback for a refresh that fails — and `set` keeps an
 * entry for at least as long as it can still be served.
 */
export interface UpstreamCache {
  get: (key: string, options?: CacheReadOptions) => Promise<UpstreamCacheEntry | null>
  set: (key: string, entry: UpstreamCacheEntry, options?: CacheWriteOptions) => Promise<void>
}

export interface UpstreamRuntime {
  /** Serve the recorded fixture set instead of the network (see `RAWG_FIXTURES`). */
  fixtures: boolean
  fetchJson: (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  readFixture: (name: string) => Promise<unknown | null>
  cache: UpstreamCache
  now: () => number
  sleep: (ms: number) => Promise<void>
  /**
   * Where the line about an attempt that failed or was slow goes (see `SLOW_ATTEMPT_MS`).
   * `console.info` when omitted; a test passes its own, to read the lines or to keep them out of
   * its output.
   */
  log?: (line: string) => void
  /**
   * Keeps a refresh nobody is waiting for running after the answer has gone out — on a platform
   * that freezes a function once it has answered, the only thing that does. It is handed a promise
   * that never rejects.
   *
   * It is also the switch of the stale window. An answer served stale leaves work behind it, and a
   * runtime that has nowhere to put that work is never given a stale answer: without a keep-alive
   * the transport behaves exactly as it did before the window existed, whatever `staleFor` says.
   * That is every runtime but the deployed site's — the refresh job, the tests of everything built
   * on this transport, and a server anywhere but on the platform (`server/utils/rawg.ts`).
   */
  keepAlive?: (work: Promise<unknown>) => void
}

export interface UpstreamConfig<TRequest> {
  source: UpstreamSource
  /** Minimum spacing between two outgoing requests of this upstream, in ms. */
  minIntervalMs: number
  timeoutMs: number
  /** Total attempts per logical call, retries included. */
  maxAttempts: number
  buildUrl: (request: TRequest) => string
  cacheKey: (request: TRequest) => string
  fixtureName: (request: TRequest) => string
  /** Cache lifetime in seconds for this particular request. */
  ttlFor: (request: TRequest) => number
  /**
   * The stale window of this particular request, in seconds counted from the moment its answer
   * was stored; none when omitted, and none for a request it gives zero.
   *
   * Inside the ttl an answer is fresh, as ever. Past the ttl and inside the window it is still
   * handed over at once, and the upstream is asked behind the caller's back: one refresh a key at a
   * time, kept running by `keepAlive`, its attempts logged like any other, and the entry it brings
   * back replacing the old one. A refresh that fails changes nothing: the entry stays, and the
   * next call tries again. Past the window the entry is expired: the upstream is asked and waited
   * for, and the entry is only the fallback it has always been for a refresh that fails.
   *
   * It is the reader's rule, not the writer's: the window applied to an entry is the one this
   * build gives the request, so narrowing it takes effect on what is already stored.
   */
  staleFor?: (request: TRequest) => number
  /**
   * Whether this particular request carries something a visitor typed, such as a search term;
   * none does when omitted. Its answer is then kept in the instance's memory alone
   * (`isShareable`).
   */
  typed?: (request: TRequest) => boolean
  /** Narrows a payload before it is cached and returned; identity when omitted. */
  project?: (value: unknown) => unknown
  /** A tighter timeout or fewer attempts for one request than the upstream's defaults. */
  limitsFor?: (request: TRequest) => UpstreamLimits | undefined
}

export interface UpstreamLimits {
  timeoutMs?: number
  maxAttempts?: number
}

/**
 * One call to an upstream.
 *
 * `onCached` is for a caller that measures what its calls cost it — the collector behind the
 * `Server-Timing` header, `server/graphql/serverTiming.ts`. It is called, before the answer is
 * handed over, when a fresh cache entry answered and the upstream was not asked: the one case in
 * which a call waited for nobody. An answer the upstream gave is not that, and neither is a
 * request another caller had already sent, a stale entry that stood in for a failed refresh, or a
 * recorded fixture, which is the upstream of fixture mode. So a caller that is never told may
 * count every one of its calls as a call. An entry served inside its stale window is the cache's
 * answer too: the refresh behind it is nobody's wait.
 *
 * `onSharedRead` is for the same caller, and is called when the call's read of the cache went
 * beyond this instance's memory (`SharedRead`) — the moment that read is over and it is known
 * whether what it found answers, which is before the upstream is asked anything. So a caller that
 * stops waiting for a slow upstream has still been told of the read it paid for. Callers that
 * share a call are each told once, of the very same object: a collector that is told of one read
 * by two of its calls can tell that it was one.
 */
export type UpstreamFetch<TRequest> = (
  request: TRequest,
  onCached?: () => void,
  onSharedRead?: (read: SharedRead) => void,
) => Promise<unknown>

/** What one logical call ended with, and whether the cache alone supplied it. */
interface Loaded {
  value: unknown
  cached: boolean
}

/**
 * What a call learns on its way that is not its answer, and who has yet to hear of it: every
 * caller sharing the call is told, those that join after it is known as much as those that were
 * there before.
 */
interface Notes {
  /** The call's read of the shared cache, once it is over and known for what it was. */
  sharedRead?: SharedRead
  /** The callers that asked to be told of it, while it is not known yet. */
  listeners: ((read: SharedRead) => void)[]
}

/** A call that is still running, as the callers that share it hold it. */
interface Running {
  call: Promise<Loaded>
  notes: Notes
}

/**
 * How long an attempt may take before it is logged even though it succeeded. RAWG answers most
 * requests in well under a second; the ones that take two or more are the tail the game page's
 * time budget exists for, and one line each is the evidence for deciding later whether a second,
 * parallel attempt would have beaten them.
 */
export const SLOW_ATTEMPT_MS = 2_000

/** The most of a cache key's path a log line carries: a key is as long as its caller makes it. */
const MAX_LOGGED_PATH_LENGTH = 120

/**
 * What a log line may say about a request: the path of its cache key, and never the URL. The URL
 * carries the API key; a cache key never does, and its query string — which can hold a search term
 * a visitor typed — is left out too. Cut to a fixed length, so that a line stays a line whatever a
 * caller put in the key.
 */
function loggedPath(key: string): string {
  const path = key.split('?', 1)[0] ?? ''
  return path.length > MAX_LOGGED_PATH_LENGTH ? `${path.slice(0, MAX_LOGGED_PATH_LENGTH)}…` : path
}

/** How an attempt ended, in the transport's own words: `OK`, or the error's kind and status. */
function outcomeOf(error: UpstreamError | null): string {
  if (!error) return 'OK'
  return error.status === undefined ? error.kind : `${error.kind} (${error.status})`
}

/**
 * Whether a body may be kept. Every API behind this transport answers with a JSON object, so
 * anything else under a 200 — RAWG has been seen sending an empty body, which parses to `null` — is
 * a bad answer, not a result: it is handed to the caller once and forgotten. Cached, it would be
 * served back to the caller's own retry for the whole ttl, and later as a stale-if-error fallback.
 */
function isJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function createUpstreamFetch<TRequest>(
  config: UpstreamConfig<TRequest>,
  runtime: UpstreamRuntime,
): UpstreamFetch<TRequest> {
  const project = config.project ?? ((value: unknown) => value)
  // Read when a line is written, not when the transport is built, so the default follows whatever
  // `console.info` is at that moment.
  const log = runtime.log ?? ((line: string) => console.info(line))
  let nextSlot = 0

  /**
   * The calls that are still running, so that a second call for the same thing joins the first
   * instead of sending a request of its own.
   *
   * "The same thing" is the same cache key under the same limits. The key is what the cache
   * already treats as one answer; the limits are part of it because a caller that asked for one
   * four-second attempt must not be made to sit through another caller's two five-second ones.
   * Limits are compared as they take effect, so asking for the defaults by name is asking for the
   * defaults. The ttl is not compared: whoever writes a cache entry has always decided how long it
   * lives, and here that is the call that started the request.
   *
   * Without this, a page that stopped waiting for a slow answer and asked again a few seconds
   * later — which is what the game page does — would start a second slow request beside the
   * first, instead of collecting the first one's answer the moment it lands.
   *
   * Everyone who joins gets exactly what the first caller gets: the body, the stale entry it fell
   * back to, or its error. A failure is shared only with the callers that were already waiting for
   * it. The entry is removed before the outcome can be observed, so a call made after a failure
   * always sends a request of its own.
   *
   * An entry lasts as long as its call and no longer: the two cache calls, and at most
   * `maxAttempts` attempts, each waiting its turn at the limiter and each ended by its own abort
   * timeout however the upstream behaves. That bounds it in a process that keeps running. A
   * platform that freezes an instance in the middle of a call freezes the entry with it: it is
   * still there after the thaw, and a caller that joins it then gets a request answered, or timed
   * out, long after it was sent. So a request a caller stops waiting for should be handed to the
   * platform to finish (`leaveRunning` in `server/graphql/budget.ts`), as the game page and the
   * catalog do.
   *
   * "Exactly" means the same object, not a copy of it. A caller that joined holds the very value
   * the first caller holds, and so does a cache that keeps what it is handed — the refresh job's
   * map does, and so do the tests'; the site's storage serialises on the way in, which is that
   * storage's habit and not this transport's promise. So whatever a call resolves with must be
   * treated as read-only: map it, filter it, sort a copy of it. A body changed in place would
   * change under another request, and only when two of them happen to overlap, which no test
   * with a single caller will ever show. Nothing is frozen to enforce this. The mappers and the
   * job's stages that read these bodies build new objects from them, and a new reader has to do
   * the same.
   */
  const inFlight = new Map<string, Running>()

  /**
   * The keys being refreshed behind a stale answer, so that a key has one refresh at a time
   * however many callers are handed its stale entry meanwhile.
   *
   * It is `inFlight`'s idea — one request for one thing — kept apart from it on purpose. A call
   * found in `inFlight` is waited for, and nobody may wait for a refresh: a caller that came for
   * an answer the cache can still give is given it, and the refresh is none of its business. So a
   * refresh is known by its cache key alone, whatever limits the call that started it had, and
   * lasts exactly as long as an `inFlight` entry does: its attempts, each ended by its own abort
   * timeout, and the cache write.
   */
  const refreshing = new Set<string>()

  async function throttle(now: number): Promise<void> {
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + config.minIntervalMs
    if (slot > now) await runtime.sleep(slot - now)
  }

  /**
   * The line calls stand in for their turn at the limiter, in the order they were made.
   *
   * A call takes its place the moment it is made, before its cache is read, and gives it up when
   * the cache answers. A call the cache does not answer waits for its turn — for every call made
   * before it to have left the line or taken its slot — and only then takes its own. So requests
   * go out in the order their calls were made, whatever order the cache reads come back in.
   *
   * With a cache that is a map it changes nothing: the reads come back in the order they were
   * asked for. With a second level it is what keeps a promise callers rely on: the game page
   * asks for the game before its store links and its screenshots because the game is what the
   * page cannot be built without, and three reads of a shared cache return in any order they
   * like. The reads themselves are not queued — every call's is out at once — so the line is as
   * slow as its slowest read and no slower, and the cache bounds that.
   *
   * It holds only first attempts. A retry takes the next slot when it is ready for one, as it
   * always did; it was first in line once already.
   *
   * A place must be left, whatever becomes of its call: a place nobody leaves holds up every
   * request behind it for good. `leave` may be called more than once, and `load` and
   * `refreshInTurn` call it in a `finally`.
   */
  interface Place {
    /** Resolves when every call that took its place earlier has left the line. */
    readonly turn: Promise<void>
    leave: () => void
  }

  let endOfLine: Promise<void> = Promise.resolve()

  function takePlace(): Place {
    const turn = endOfLine
    let leave!: () => void
    const left = new Promise<void>((resolve) => {
      leave = resolve
    })
    endOfLine = turn.then(() => left)
    return { turn, leave }
  }

  /** One request as the upstream answered it: its body, or the `UpstreamError` it stands for. */
  async function send(url: string, timeoutMs: number): Promise<unknown> {
    let response: { status: number; body: unknown }
    try {
      response = await runtime.fetchJson(url, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      throw new UpstreamError(config.source, isTimeout(error) ? 'TIMEOUT' : 'ERROR')
    }
    if (response.status === 429) throw new UpstreamError(config.source, 'RATE_LIMITED', 429)
    if (response.status === 404) throw new UpstreamError(config.source, 'NOT_FOUND', 404)
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(config.source, 'ERROR', response.status)
    }
    return response.body
  }

  /**
   * One `console.info` line for an attempt worth knowing about: one that timed out, one that
   * failed, and one that took `SLOW_ATTEMPT_MS` or longer whatever came of it. It names the
   * source, the path of the cache key, which attempt it was, how long the upstream took, and how
   * it ended — see `loggedPath` for what is deliberately not in it.
   *
   * The time is the upstream's own: it is measured from the moment the request is sent, after the
   * limiter has let it through, because a line that included our own queue would say nothing
   * about how slow RAWG was. A 404 is an answer rather than a failure, here as in the cache rule
   * below, and is logged only when it was slow: anyone can ask for a game that does not exist,
   * and a line per miss would hand the log to whoever does.
   */
  function report(path: string, number: number, startedAt: number, error: UpstreamError | null) {
    const ms = Math.max(0, runtime.now() - startedAt)
    const failed = error !== null && error.kind !== 'NOT_FOUND'
    if (!failed && ms < SLOW_ATTEMPT_MS) return
    log(`[upstream] ${config.source} ${path} attempt ${number}: ${ms} ms, ${outcomeOf(error)}`)
  }

  async function attempt(
    url: string,
    now: number,
    timeoutMs: number,
    path: string,
    number: number,
  ): Promise<unknown> {
    await throttle(now)
    const startedAt = runtime.now()
    try {
      const body = await send(url, timeoutMs)
      report(path, number, startedAt, null)
      return body
    } catch (error) {
      // `send` raises nothing but `UpstreamError`; anything else would be a bug of ours, and is
      // passed on untouched rather than described.
      if (error instanceof UpstreamError) report(path, number, startedAt, error)
      throw error
    }
  }

  function isRetryable(error: unknown): boolean {
    if (!(error instanceof UpstreamError)) return false
    if (error.kind === 'TIMEOUT') return true
    return error.kind === 'ERROR' && (error.status === undefined || error.status >= 500)
  }

  async function fetchWithRetry(
    url: string,
    now: number,
    limits: Required<UpstreamLimits>,
    path: string,
  ): Promise<unknown> {
    let lastError: unknown
    for (let i = 0; i < limits.maxAttempts; i++) {
      // The first attempt reuses the `now` captured at the top of the logical call (below) so that
      // concurrent calls each reserve their throttle slot against a shared reference point. A retry
      // attempt, however, happens strictly after real time has passed (the failed fetch, its
      // timeout, etc.), so it must re-read the clock instead of reusing that stale value —
      // otherwise throttle() would wait out a slot that has already elapsed, needlessly slowing
      // down retries and dragging real throughput under the target rate.
      const attemptNow = i === 0 ? now : runtime.now()
      try {
        return await attempt(url, attemptNow, limits.timeoutMs, path, i + 1)
      } catch (error) {
        lastError = error
        if (!isRetryable(error)) break
      }
    }
    throw lastError
  }

  /** Whether this request's answer may be kept beyond the instance: the one rule, per request. */
  function shareableOf(request: TRequest): boolean {
    return isShareable(config.ttlFor(request), config.typed?.(request) ?? false)
  }

  /**
   * The request's stale window in milliseconds: none in a runtime that cannot keep a refresh
   * running behind an answer, and none for a window that is not a positive number.
   */
  function staleWindowMs(request: TRequest): number {
    if (!runtime.keepAlive) return 0
    const seconds = config.staleFor?.(request) ?? 0
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  }

  /**
   * Asks the upstream and keeps what it answered: the body as the caller gets it, timed from `now`.
   * A body that is not a JSON object is handed back and not kept (`isJsonObject`).
   */
  async function fetchAndStore(
    request: TRequest,
    key: string,
    now: number,
    limits: Required<UpstreamLimits>,
  ): Promise<unknown> {
    const body = await fetchWithRetry(config.buildUrl(request), now, limits, loggedPath(key))
    const value = project(body)
    if (isJsonObject(body)) {
      const entry = { value, expiresAt: now + config.ttlFor(request) * 1000, storedAt: now }
      await runtime.cache.set(key, entry, {
        shareable: shareableOf(request),
        staleSeconds: staleWindowMs(request) / 1000,
      })
    }
    return value
  }

  /**
   * Starts the refresh behind a stale answer, unless the key already has one, and hands it to the
   * runtime to keep running. Nothing of it reaches the caller that set it off: what is handed over
   * cannot reject, a failed attempt has already written its own line (`report`), and the entry
   * that was served stays where it is until a refresh brings a newer one. A refresh whose turn
   * comes while the limiter is backed up is dropped (`REFRESH_BACKLOG_LIMIT_MS`): the entry
   * stays, and the next call for it starts another.
   *
   * A 404 is no exception, though it is an answer rather than a failure: the game is gone, and its
   * entry goes on being served until the window closes on it. Taking it out would need a cache
   * that can forget, and this port has no such word.
   */
  function refresh(
    request: TRequest,
    key: string,
    clock: () => number,
    limits: Required<UpstreamLimits>,
  ): void {
    if (refreshing.has(key)) return
    // Registered before anything is awaited, like an `inFlight` entry; and `refreshInTurn` is an
    // async function, so nothing it does can run `done` before the key is in the set.
    refreshing.add(key)
    const done = () => void refreshing.delete(key)
    // At the end of the line: behind every call made before this answer was handed over, the ones
    // somebody is waiting for among them.
    const work = refreshInTurn(request, key, clock, limits, takePlace()).then(done, done)
    try {
      runtime.keepAlive?.(work)
    } catch {
      // A keep-alive that will not take the work leaves it running, which is all it would have
      // done off a platform that freezes; the answer it was started behind is not its to fail.
    }
  }

  /** The refresh itself: its turn in the line, then the request and the cache write. */
  async function refreshInTurn(
    request: TRequest,
    key: string,
    clock: () => number,
    limits: Required<UpstreamLimits>,
    place: Place,
  ): Promise<void> {
    try {
      await place.turn
      // Not while the limiter is backed up: this is the one request nobody is waiting for, and
      // the entry it is for goes on being served (`REFRESH_BACKLOG_LIMIT_MS`).
      if (nextSlot - runtime.now() > REFRESH_BACKLOG_LIMIT_MS) return
      // The slot is taken by the time `fetchAndStore` hands back its promise, as in `load`.
      const fetching = fetchAndStore(request, key, clock(), limits)
      place.leave()
      await fetching
    } finally {
      place.leave()
    }
  }

  /**
   * One logical call, from the cache read to the cache write. `cached` is true for the answers
   * nobody was asked for: a fresh entry, and an entry inside its stale window, which is handed
   * over while the upstream is asked behind it. A stale entry that stands in for a failed refresh
   * is not that — the upstream was asked first, and whoever called waited for it to fail.
   */
  async function load(
    request: TRequest,
    key: string,
    now: number,
    limits: Required<UpstreamLimits>,
    notes: Notes,
  ): Promise<Loaded> {
    // Taken before anything is awaited: this call's place in the limiter's line is where it was
    // made, not where its cache read happens to come back.
    const place = takePlace()
    try {
      const reported: { read?: SharedRead } = {}
      const entry = await runtime.cache.get(key, {
        shareable: shareableOf(request),
        onSharedRead: (read) => {
          reported.read = read
        },
      })
      // An entry an older build cached from a bad body is no entry at all.
      const cached = entry && isJsonObject(entry.value) ? entry : null
      const fresh = cached !== null && cached.expiresAt > now
      const staleWindow = staleWindowMs(request)
      const stale =
        !fresh &&
        cached?.storedAt !== undefined &&
        staleWindow > 0 &&
        now < cached.storedAt + staleWindow

      // Said now, before anyone is asked or waited for: the read is over, and whether what it
      // found answers is known. An entry too old to answer by itself answered nothing.
      if (reported.read) {
        noted(notes, { ms: reported.read.ms, hit: reported.read.hit && (fresh || stale) })
      }
      if (cached && fresh) return { value: cached.value, cached: true }

      // A read that went beyond memory took real time, so the request that follows it is timed,
      // and given its slot at the limiter, from the clock as it stands when its turn comes — for
      // the reason a retry is (`fetchWithRetry`): a slot reserved against a moment already past
      // would let this request out too soon after the one before it. A read of memory alone took
      // none, and keeps the moment the call was made, which is what keeps concurrent calls in
      // step with each other.
      const clock = () => (notes.sharedRead ? runtime.now() : now)

      if (cached && stale) {
        refresh(request, key, clock, limits)
        return { value: cached.value, cached: true }
      }

      try {
        await place.turn
        // `fetchAndStore` runs as far as the limiter before it first waits for anything, so this
        // call's slot is taken by the time its promise is in hand — and the line can move on
        // while the request is out.
        const fetching = fetchAndStore(request, key, clock(), limits)
        place.leave()
        return { value: await fetching, cached: false }
      } catch (error) {
        // A 404 is an answer, not a failure: serving a stale body for a game that no longer exists
        // would be worse than the error.
        const notFound = error instanceof UpstreamError && error.kind === 'NOT_FOUND'
        if (cached && !notFound) return { value: cached.value, cached: false }
        throw error
      }
    } finally {
      // The cache answered, the request has its slot, or the call failed before either: in every
      // case the calls behind this one need wait for it no longer.
      place.leave()
    }
  }

  /** Tells a listener, whose own failure is no part of the call it is told about. */
  function tell(listener: () => void): void {
    try {
      listener()
    } catch {
      // Nothing of the listener's reaches the caller.
    }
  }

  /** Tells one caller of the call's shared read: now if it is known, or the moment it is. */
  function listen(notes: Notes, onSharedRead?: (read: SharedRead) => void): void {
    if (!onSharedRead) return
    const read = notes.sharedRead
    if (read) tell(() => onSharedRead(read))
    else notes.listeners.push(onSharedRead)
  }

  /** The call's shared read is known for what it was: every caller waiting to hear is told. */
  function noted(notes: Notes, read: SharedRead): void {
    notes.sharedRead = read
    for (const listener of notes.listeners.splice(0)) tell(() => listener(read))
  }

  /**
   * What `call` ended with, for one of the callers waiting on it — who is told first, when the
   * cache alone supplied it, so the caller knows what its call was by the time it has the answer.
   * Callers that share a call share that word as they share its answer: each of them is told.
   *
   * Telling is no part of the call. Whoever listens is measuring it, and a listener that throws
   * has failed at its own work: the answer is handed over all the same.
   */
  async function answerOf(call: Promise<Loaded>, onCached?: () => void): Promise<unknown> {
    const { value, cached } = await call
    if (cached && onCached) tell(onCached)
    return value
  }

  return async function upstreamFetch(
    request: TRequest,
    onCached?: () => void,
    onSharedRead?: (read: SharedRead) => void,
  ): Promise<unknown> {
    // Capture `now` synchronously, before the first await, so concurrent calls (e.g.
    // Promise.all(...)) all reserve throttle slots against the same reference point instead of one
    // call's simulated sleep (in tests) or real elapsed time (in production) skewing another
    // in-flight call's notion of "now". This is purely about keeping slot assignment deterministic
    // across concurrent siblings — it is not a workaround for any production rate-limit bug.
    const now = runtime.now()

    if (runtime.fixtures) {
      const fixture = await runtime.readFixture(config.fixtureName(request))
      if (fixture === null) throw new UpstreamError(config.source, 'NOT_FOUND', 404)
      return project(fixture)
    }

    const key = config.cacheKey(request)
    const asked = config.limitsFor?.(request)
    const limits = {
      timeoutMs: asked?.timeoutMs ?? config.timeoutMs,
      maxAttempts: asked?.maxAttempts ?? config.maxAttempts,
    }
    // Looked up and registered before anything is awaited: two calls made in the same turn of the
    // event loop must find each other, and they would not if either had already yielded.
    const sharedBy = `${limits.timeoutMs}/${limits.maxAttempts} ${key}`
    const running = inFlight.get(sharedBy)
    if (running) {
      listen(running.notes, onSharedRead)
      return answerOf(running.call, onCached)
    }

    // `load` is an async function, so nothing it does can run this `finally` before the entry is
    // set; and the promise callers hold is the one that settles after the entry is gone.
    const notes: Notes = { listeners: [] }
    listen(notes, onSharedRead)
    const call = load(request, key, now, limits, notes).finally(() => inFlight.delete(sharedBy))
    inFlight.set(sharedBy, { call, notes })
    return answerOf(call, onCached)
  }
}
