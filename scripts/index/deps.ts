import type { GameIndex, GameIndexWriter } from '../../server/index/GameIndex'
import type { RawgFetch } from '../../server/rawg/rawgFetch'
import type { SteamPriceFetch } from '../../server/steam/steamPriceFetch'

/**
 * What every stage of the refresh job is given, and nothing more: two upstream transports, the
 * index, a clock and a log sink. Nothing in `scripts/index/` reads `process.env`, `Date.now()` or
 * the network directly — only `run.ts` builds these — so a stage runs the same on fixtures, on the
 * in-memory adapter and on a fake clock as it does against RAWG, Steam and Upstash.
 */

/**
 * The index as the job sees it: the writer port plus the reader, because two stages read the
 * published version — `languages` carries language information forward through `getMany`, and
 * `--mode=prices` reuses the published documents wholesale. Both adapters implement both ports on
 * one object (`MemoryGameIndex` does today; the Upstash adapter of PR 2 does the same).
 */
export type JobIndex = GameIndex & GameIndexWriter

export interface JobClock {
  /** Epoch milliseconds. */
  now: () => number
  sleep: (ms: number) => Promise<void>
}

/** Where a stage's progress goes. Never a secret, never a raw upstream payload. */
export type JobLog = (message: string) => void

export interface JobDeps {
  rawg: RawgFetch
  steam: SteamPriceFetch
  writer: JobIndex
  clock: JobClock
  log: JobLog
}

/** The ISO timestamp a stage stamps on the data it just wrote. */
export function isoNow(clock: JobClock): string {
  return new Date(clock.now()).toISOString()
}

/**
 * How much of a stage may fail item by item before the run is not worth publishing. A single
 * RAWG or Steam blip should not throw away an hour of work — the item is counted, logged and
 * left for the next run — but a stage that is failing wholesale is an upstream outage, and
 * publishing what it managed to collect would quietly damage the index.
 */
export const MAX_ITEM_FAILURE_RATIO = 0.05

/**
 * One failure is always tolerated, whatever the ratio says: a stage with twenty items would
 * otherwise end on a single timeout, which is the outcome this budget exists to avoid.
 */
export const MIN_TOLERATED_FAILURES = 1

export function assertWithinFailureBudget(
  stage: string,
  failures: number,
  attempted: number,
): void {
  const tolerated = Math.max(MIN_TOLERATED_FAILURES, attempted * MAX_ITEM_FAILURE_RATIO)
  if (attempted === 0 || failures <= tolerated) return
  throw new Error(
    `${stage}: ${failures} of ${attempted} items failed, over the ${Math.round(
      MAX_ITEM_FAILURE_RATIO * 100,
    )}% a run tolerates`,
  )
}
