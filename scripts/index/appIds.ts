import { assertWithinFailureBudget, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import type { RawgList, RawgStoreLink } from '../../server/rawg/types'
import { steamAppIdFromUrl } from '../../server/steam/steam'

/**
 * Stage 2: the RAWG id to Steam app id mapping, which every price and language read depends on.
 *
 * It costs one RAWG request per game and RAWG's free monthly quota would not survive 3 000 of
 * them a night, so the design resolves a game once and keeps the answer forever. "Forever"
 * includes the answer "this game has no Steam page": that is stored as an empty string, because
 * an absent key and a key holding "" have to be told apart — otherwise every store-less game
 * would be asked about again on every run.
 *
 * Resuming needs no cursor of its own. The mapping lives outside the version prefix and survives
 * publications, so `getAppIds` is the resume point: whatever a crashed attempt had written is
 * already known, and only the rest is asked for. Writes are batched (a REST round trip per game
 * would cost as much as the RAWG call it saves), which is the one thing a crash can lose — at
 * most `batchSize` resolutions, re-resolved on the next run.
 *
 * A first run makes about 2 400 sequential RAWG calls, so one of them timing out past its retry
 * is likely rather than exceptional. A failed game is counted and left unresolved — never written
 * as `''`, which would make the failure permanent — and the next run picks it up. Only a stage
 * failing beyond the run's tolerance ends the run.
 */

export const APP_ID_BATCH_SIZE = 100

/** The RAWG store id of Steam; `store_id` on a store link row. */
const STEAM_STORE_ID = 1

export interface AppIdsOptions {
  /** How many resolutions to accumulate before one `setAppIds` round trip. */
  batchSize?: number
}

export interface AppIdsResult {
  appIds: AppIdMap
  /** Games asked about in this run. */
  attempted: number
  /** Games RAWG would not answer for; they stay unresolved and are retried next run. */
  failures: number
}

/** RAWG id to Steam app id, the empty string meaning "this game has no Steam page". */
export type AppIdMap = Map<number, string>

export async function resolveAppIds(
  deps: JobDeps,
  games: IndexedGame[],
  options: AppIdsOptions = {},
): Promise<AppIdsResult> {
  const batchSize = options.batchSize ?? APP_ID_BATCH_SIZE
  const candidates = games.filter((game) => game.stores.includes('steam'))
  const known = await deps.writer.getAppIds(candidates.map((game) => game.id))

  const pending = candidates.filter((game) => !known.has(game.id))
  let batch: [number, string][] = []

  async function flush(): Promise<void> {
    if (batch.length === 0) return
    await deps.writer.setAppIds(batch)
    batch = []
    // The stage is the longest stretch of a first run; the lock needs a sign of life in it.
    await deps.writer.renewLock()
  }

  let failures = 0
  try {
    for (const game of pending) {
      try {
        // By slug rather than by id: RAWG accepts either, and the slug is what the recorded
        // fixtures are named after, so a fixture-mode run resolves app ids like a live one.
        const response = (await deps.rawg(`games/${game.slug}/stores`)) as RawgList<RawgStoreLink>
        const appId =
          (response.results ?? [])
            .filter((link) => link.store_id === STEAM_STORE_ID)
            .map((link) => steamAppIdFromUrl(link.url))
            .find((id): id is string => id !== null) ?? ''

        known.set(game.id, appId)
        batch.push([game.id, appId])
        if (batch.length >= batchSize) await flush()
      } catch {
        failures += 1
        deps.log(`app ids: ${game.slug} could not be resolved, leaving it for the next run`)
      }
    }
  } finally {
    // Whatever was resolved before the stage gave up is worth keeping: it is quota already spent.
    await flush()
  }
  assertWithinFailureBudget('app ids', failures, pending.length)

  const withPage = [...known.values()].filter((appId) => appId !== '').length
  deps.log(
    `app ids: ${pending.length - failures} resolved this run, ${failures} failed, ${withPage} of ${candidates.length} Steam candidates have a page`,
  )
  return { appIds: known, attempted: pending.length, failures }
}
