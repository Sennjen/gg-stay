import { createHash } from 'node:crypto'
import { createBoundedCache, MAX_CACHE_ENTRIES } from '../utils/boundedCache'
import { createAnthropicProvider } from './anthropicProvider'
import type { AskHandlerDeps, CachedAsk } from './handler'
import {
  createDailyAllowance,
  createDailyCeiling,
  createRateLimiter,
  dailyCallLimit,
} from './limits'
import { askContext } from './pipeline'
import { createRecordedProvider, type RecordedAnswers } from './recordedProvider'

/**
 * What `/api/ask` runs on, built once per server process: the limits and the response cache are
 * per instance by design (there is no shared counter — the site cannot write to Redis).
 *
 * - Fixture mode (`RAWG_FIXTURES=1`) answers from the recorded provider, so development and CI
 *   never call the Anthropic API and an unrecorded query shows the fallback.
 * - Otherwise the Anthropic provider, with the server-only `ANTHROPIC_API_KEY`; without one every
 *   request is answered by the fallback, never with an error.
 * - `ASK_DAILY_LLM_CALLS` overrides the per-instance daily ceiling of model calls (default 500;
 *   0 turns the model off).
 *
 * This file is deliberately not in `server/utils`. Nitro auto-imports that directory through one
 * module the server entry loads at start, so everything a util imports is read and evaluated on
 * every cold start, whatever the request. From there this file took the Anthropic SDK, zod and the
 * whole ask pipeline with it — 286 files and 1.7 MB that only `POST /api/ask` needs. Imported by
 * the route alone, they load with the route's own chunk, on the first question an instance gets.
 * See "Cold start" in docs/perf/README.md.
 */

let instance: AskHandlerDeps | undefined

// unstorage reads `:` in a key as a namespace separator, and the cache key carries the query.
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useAsk(): AskHandlerDeps {
  if (instance) return instance
  const config = useRuntimeConfig()
  const now = () => Date.now()
  const fixtures = String(config.rawgFixtures) === '1'

  const cache = createBoundedCache<CachedAsk>({
    storage: useStorage('cache:ask'),
    maxEntries: MAX_CACHE_ENTRIES,
    now,
    hashKey,
  })

  instance = {
    limiter: createRateLimiter({ now }),
    allowance: createDailyAllowance({ now }),
    ceiling: createDailyCeiling({ limit: dailyCallLimit(config.askDailyLlmCalls), now }),
    cache: { get: cache.get, set: cache.set },
    context: async () => askContext(await createGraphQLContext()),
    provider: fixtures
      ? createRecordedProvider(() =>
          useStorage('assets:ask-fixtures').getItem<RecordedAnswers>('recorded.json'),
        )
      : createAnthropicProvider({ apiKey: String(config.anthropicApiKey ?? '') }),
    // Counts, latency, tokens, cost and mode only: never the address, never the query.
    log: (line) => console.info(`[ask] ${JSON.stringify(line)}`),
    now,
  }
  return instance
}
