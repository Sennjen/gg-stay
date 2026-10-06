import type { GraphQLContext } from './context'

/**
 * How a resolver waits for something it can answer without: for as long as it has decided to, and
 * not a moment longer. The catalog waits this way for RAWG before the index stands in for it
 * (`RAWG_HEDGE_MS` in `resolvers/games.ts`).
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
