import type { GraphQLContext } from './context'

/**
 * How a resolver waits for something it can answer without: for as long as it has decided to, and
 * not a moment longer. The catalog waits this way for RAWG before the index stands in for it
 * (`RAWG_HEDGE_MS` in `resolvers/games.ts`), and the game page for everything it asks for
 * (`resolvers/game.ts`).
 *
 * Nothing here cancels anything. A request a resolver stops waiting for keeps running, so that its
 * answer still reaches the cache it was headed for and the next reader gets it in milliseconds;
 * `leaveRunning` is what keeps the function alive for that long.
 */

/**
 * Whether `work` is still unsettled `ms` from now. Settling either way counts as in time — a RAWG
 * error inside the budget is the caller's to see, not a reason to look elsewhere — and clears the
 * timer at once, so a fast answer leaves nothing scheduled behind it.
 */
export function outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    const settle = () => {
      clearTimeout(timer)
      resolve(false)
    }
    work.then(settle, settle)
  })
}

/**
 * Leaves `work` running after its resolver has stopped waiting for it.
 *
 * On a platform that freezes a function once it has answered, `context.waitUntil` keeps it alive
 * until `work` has settled; without one the work is simply left to finish. Either way what is
 * handed over can no longer reject, so a failure nobody is waiting for any more can never surface
 * as an unhandled rejection — and the platform's own `waitUntil`, which does not catch, is never
 * given one.
 */
export function leaveRunning(context: GraphQLContext, work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined,
  )
  context.waitUntil?.(settled)
}

/** How a request ended. */
export type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }

/** How a request stands at this moment. */
export type Outcome<T> = Settled<T> | { status: 'pending' }

/**
 * A request its resolver may stop waiting for.
 *
 * `outcome()` says how the request stands right now, without waiting — which is what lets an
 * answer be put together from whatever has arrived by the time it is due. `settled` resolves when
 * the request ends, either way, and never rejects: it is what a resolver races a budget against.
 * A request is observed from the moment it is made, so its failure is handled whether or not
 * anyone ends up waiting for it.
 */
export interface Observed<T> {
  outcome(): Outcome<T>
  readonly settled: Promise<Settled<T>>
}

export function observe<T>(work: Promise<T>): Observed<T> {
  let outcome: Outcome<T> = { status: 'pending' }
  const settled = work.then(
    (value): Settled<T> => (outcome = { status: 'fulfilled', value }),
    (reason: unknown): Settled<T> => (outcome = { status: 'rejected', reason }),
  )
  return { outcome: () => outcome, settled }
}

/** What `observed` answered with, or `undefined` while it has not, and when it failed. */
export function valueOf<T>(observed: Observed<T>): T | undefined {
  const outcome = observed.outcome()
  return outcome.status === 'fulfilled' ? outcome.value : undefined
}

/**
 * Everything one answer is waiting on: the requests it has made and the budgets it is counting.
 *
 * An answer that is given inside a budget ends in more ways than it starts — with everything it
 * asked for, with part of it, with an error — and two things have to hold at every one of those
 * ends. Nothing that is still running may be dropped: whatever the answer did not wait for goes
 * to `leaveRunning`, so its response still reaches its cache. And no timer may stay scheduled
 * behind the answer. `release()` sees to both, which is why a resolver calls it in a `finally`
 * rather than at each of its exits.
 */
export interface Pending {
  /** Observes `work` (see `Observed`) and remembers it, so `release` can hand it over. */
  observe<T>(work: Promise<T>): Observed<T>
  /**
   * A promise that resolves `ms` from now. The clock starts with this call, not with whoever
   * awaits the result: a budget "counted from when the request began" is one created then.
   */
  budget(ms: number): Promise<void>
  /**
   * The answer is decided. Clears every timer still scheduled and hands every request still
   * running to `leaveRunning`. Safe to call more than once.
   */
  release(): void
  /**
   * Whether `release` has run. Nothing should be started for an answer that has already been
   * given; what is started anyway is handed straight over, and a budget asked for is already spent.
   */
  readonly released: boolean
}

export function trackPending(context: GraphQLContext): Pending {
  const requests: Observed<unknown>[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let released = false

  return {
    get released() {
      return released
    },

    observe<T>(work: Promise<T>): Observed<T> {
      const observed = observe(work)
      if (released) leaveRunning(context, observed.settled)
      else requests.push(observed)
      return observed
    },

    budget(ms: number): Promise<void> {
      if (released) return Promise.resolve()
      return new Promise((resolve) => {
        timers.add(setTimeout(resolve, ms))
      })
    },

    release(): void {
      if (released) return
      released = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const request of requests) {
        if (request.outcome().status === 'pending') leaveRunning(context, request.settled)
      }
    },
  }
}
