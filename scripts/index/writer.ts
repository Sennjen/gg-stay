import type { JobIndex } from './deps'
import { createMemoryGameIndex } from '../../server/index/memoryIndex'
import { createUpstashCommands, createUpstashIndex } from '../../server/index/upstashIndex'

/**
 * Where the refresh job gets its index from: the Upstash adapter with the write token, or the
 * in-memory one for a dry run. The job never names a Redis command anywhere else — every stage is
 * written against the ports in `server/index/GameIndex.ts`.
 *
 * `INDEX_DRY_RUN=1` runs the whole job end to end on the in-memory adapter: real stages, real
 * validation, real job summary, nothing published anywhere. That is how the job is exercised
 * without credentials, in development and in a workflow run that only wants to see it work.
 */

/**
 * How long the write lock lives without a sign of life, and why this number.
 *
 * The job renews the lock between stages and between batches inside the long ones, so what this
 * has to cover is the longest gap between two renewals, not the length of a run:
 *
 * | gap                              | worst case                                    |
 * | -------------------------------- | --------------------------------------------- |
 * | the candidate walk, 20 pages     | 20 × 250 ms throttle + latency ≈ 15 s          |
 * | one app-id batch, 100 games      | 100 × 250 ms + latency ≈ 30 s                 |
 * | one price chunk, 100 app ids     | 1.5 s throttle + a 5 s timeout and one retry  |
 * | one language batch, 50 apps      | 50 at 40/min ≈ 75 s                           |
 * | one store-reference batch, 100   | 100 × 250 ms + latency ≈ 30 s                 |
 * | one page of GOG's catalog        | 1 s throttle + a 10 s timeout and one retry   |
 * | one Microsoft Store request      | 1 s throttle + a 15 s timeout and one retry   |
 * | one PlayStation Store request    | a 10 s pause + a 15 s timeout, no retry       |
 * | `writeVersion`                   | refreshes the lock itself as it goes          |
 *
 * So about 90 seconds at the worst, and thirty minutes is twenty times that — margin enough for a
 * stalled upstream, a slow runner or a garbage-collection pause, while still freeing the lock long
 * before the next six-hourly run arrives. The PlayStation Store's stage is the one that is longer
 * than the lock — forty minutes at the most — and is no exception to the rule: it renews after
 * every request, so its gap is the twenty-five seconds of its row. A run that dies therefore blocks nothing for more than
 * half an hour, and `force_unlock` is there for the operator who will not wait.
 */
export const INDEX_LOCK_TTL_SECONDS = 30 * 60

/**
 * How long a holder must have been silent before a forced run takes its lock. Five minutes: the
 * job renews at most once a minute and at least once a stage, and the workflow's concurrency group
 * runs one job at a time, so a holder that has said nothing for five minutes is an orphan of a job
 * that is already gone. It has to stay well under `INDEX_LOCK_TTL_SECONDS`, or forcing would only
 * become possible after a plain retry already worked — which is the whole point of the input.
 */
export const INDEX_FORCE_AFTER_MS = 5 * 60 * 1000

export interface WriterEnv {
  UPSTASH_REDIS_REST_URL?: string | undefined
  UPSTASH_REDIS_REST_TOKEN?: string | undefined
  INDEX_DRY_RUN?: string | undefined
}

export interface WriterFromEnv {
  writer: JobIndex
  dryRun: boolean
}

/**
 * `process.env` as the plain map of strings it is. Read as `NodeJS.ProcessEnv` it stops being
 * assignable to `WriterEnv` in any program where a package has added optional names of its own to
 * that interface — browserslist does, and it arrives with Nuxt's types — because the two then have
 * no name in common.
 */
const processEnv: Record<string, string | undefined> = process.env

export function createWriterFromEnv(env: WriterEnv = processEnv): WriterFromEnv {
  if (env.INDEX_DRY_RUN === '1') return { writer: createMemoryGameIndex(), dryRun: true }

  const url = env.UPSTASH_REDIS_REST_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required (or INDEX_DRY_RUN=1).',
    )
  }

  return {
    writer: createUpstashIndex(createUpstashCommands({ url, token }), {
      lockTtlSeconds: INDEX_LOCK_TTL_SECONDS,
      forceAfterMs: INDEX_FORCE_AFTER_MS,
    }),
    dryRun: false,
  }
}
