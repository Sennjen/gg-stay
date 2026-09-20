import type { JobIndex } from './deps'
import { createMemoryGameIndex } from '../../server/index/memoryIndex'

/**
 * Where the refresh job gets its index from.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * PR 2 PLUGS THE UPSTASH ADAPTER IN HERE, and nowhere else in `scripts/`.
 *
 * Replace the `throw` below with
 *
 *     return createUpstashGameIndex({ url, token })
 *
 * from `server/index/upstashIndex.ts`. Nothing else in the job changes: every stage is written
 * against the ports in `server/index/GameIndex.ts`, so the adapter is the only thing that knows
 * about Redis.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Until then `INDEX_DRY_RUN=1` runs the whole job end to end on the in-memory adapter: real
 * stages, real validation, real job summary, nothing published anywhere. That is how the job is
 * exercised today.
 */

export const UPSTASH_ADAPTER_MISSING =
  'Upstash adapter not available yet. Run with INDEX_DRY_RUN=1 to exercise the job on the in-memory index.'

export interface WriterEnv {
  UPSTASH_REDIS_REST_URL?: string | undefined
  UPSTASH_REDIS_REST_TOKEN?: string | undefined
  INDEX_DRY_RUN?: string | undefined
}

export interface WriterFromEnv {
  writer: JobIndex
  dryRun: boolean
}

export function createWriterFromEnv(env: WriterEnv = process.env): WriterFromEnv {
  if (env.INDEX_DRY_RUN === '1') return { writer: createMemoryGameIndex(), dryRun: true }

  const url = env.UPSTASH_REDIS_REST_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required (or INDEX_DRY_RUN=1).',
    )
  }

  throw new Error(UPSTASH_ADAPTER_MISSING)
}
