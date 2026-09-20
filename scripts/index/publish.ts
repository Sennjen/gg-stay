import { isoNow, type JobDeps } from './deps'
import type { IndexMeta, IndexedGame } from '../../server/index/document'

/**
 * Stage 5: validation, then the blue/green swap.
 *
 * A run writes into a version nobody reads and only then moves `idx:current`, so a half-finished
 * run is invisible rather than damaging. Two checks stand between a draft and that pointer, both
 * from the design:
 *
 * - a run that ends with fewer than half the games the published version has is a truncated run,
 *   not a shrinking catalog;
 * - a run with no priced games at all, where the published version had some, means Steam was
 *   unreachable — and a catalog with prices silently gone is worse than yesterday's catalog;
 * - a run that priced less than three quarters of what the published version prices, which is the
 *   shape a partial Steam outage actually takes. Real price churn between two runs six hours
 *   apart is a handful of games, so anything below that is upstream trouble, and the cost of a
 *   false alarm is one red run served entirely from the previous version.
 *
 * Either way the draft is discarded and the caller exits non-zero, which is what makes GitHub
 * notify the owner. Nothing is written into the published version in the meantime, and a write
 * that throws half way discards the draft too, so no version is ever left orphaned holding the
 * writer's lock.
 *
 * `previousMeta()` is deliberately not read here: every check compares against the version that
 * is live right now (`meta()`), not against the one it replaced.
 */

/** A run must keep at least this share of the published version's games. */
export const MIN_GAME_RATIO = 0.5

/** And at least this share of its priced games. */
export const MIN_PRICED_RATIO = 0.75

export interface PublishInput {
  version: number
  games: IndexedGame[]
  /** When the prices in `games` were read; `null` when this run refreshed none. */
  pricesUpdatedAt: string | null
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
}

export interface PublishOutcome {
  published: boolean
  /** The meta of the version this run built, published or not. */
  meta: IndexMeta
  /** Why the run was refused, in English, for the log and the job summary. */
  reason: string | null
  previous: IndexMeta | null
}

export function countIndexed(games: IndexedGame[]) {
  return {
    gameCount: games.length,
    pricedCount: games.filter((game) => game.priceUah !== null).length,
    textCount: games.filter((game) => game.localisation?.text).length,
    audioCount: games.filter((game) => game.localisation?.audio).length,
  }
}

export async function publishVersion(deps: JobDeps, input: PublishInput): Promise<PublishOutcome> {
  const counts = countIndexed(input.games)
  const previous = await deps.writer.meta()

  const meta: IndexMeta = {
    version: input.version,
    updatedAt: isoNow(deps.clock),
    pricesUpdatedAt: input.pricesUpdatedAt,
    gameCount: counts.gameCount,
    stats: {
      gamesIndexed: counts.gameCount,
      pricesFetched: input.pricesFetched,
      languagesFetched: input.languagesFetched,
      failures: input.failures,
      durationMs: input.durationMs,
      pricedCount: counts.pricedCount,
      textCount: counts.textCount,
      audioCount: counts.audioCount,
    },
  }

  const floor = previous ? previous.gameCount * MIN_GAME_RATIO : 0
  const previouslyPriced = previous?.stats?.pricedCount ?? 0

  let reason: string | null = null
  if (previous && counts.gameCount < floor) {
    reason = `the run indexed ${counts.gameCount} games, fewer than half of the published ${previous.gameCount}`
  } else if (previous && previouslyPriced > 0 && counts.pricedCount === 0) {
    reason = `the run priced no games while the published version prices ${previouslyPriced}`
  } else if (
    previous &&
    previouslyPriced > 0 &&
    counts.pricedCount < previouslyPriced * MIN_PRICED_RATIO
  ) {
    reason = `the run priced ${counts.pricedCount} games, against ${previouslyPriced} in the published version`
  }

  if (reason) {
    await deps.writer.discardVersion(input.version)
    deps.log(`publish: refused, ${reason}`)
    return { published: false, meta, reason, previous }
  }

  try {
    await deps.writer.writeVersion(input.version, input.games)
    await deps.writer.publish(input.version, meta)
  } catch (error) {
    // The largest write the job makes. If it breaks half way, the draft's keys and the writer's
    // lock must not outlive the run.
    await deps.writer.discardVersion(input.version).catch(() => {})
    throw error
  }
  deps.log(
    `publish: version ${input.version} with ${counts.gameCount} games, ${counts.pricedCount} priced`,
  )
  return { published: true, meta, reason: null, previous }
}
