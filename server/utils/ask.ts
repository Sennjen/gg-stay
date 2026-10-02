import { createHash } from 'node:crypto'
import { createAnthropicProvider } from '../ask/anthropicProvider'
import type { AskHandlerDeps, CachedAsk } from '../ask/handler'
import { createDailyCeiling, createRateLimiter, DEFAULT_DAILY_LLM_CALLS } from '../ask/limits'
import { createRecordedProvider, type RecordedAnswers } from '../ask/recordedProvider'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'

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
 */

let instance: AskHandlerDeps | undefined

// unstorage reads `:` in a key as a namespace separator, and the cache key carries the query.
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** Env overrides arrive through destr, so the ceiling may be a number or a string. */
export function dailyCallLimit(raw: unknown): number {
  if (raw === '' || raw === null || raw === undefined) return DEFAULT_DAILY_LLM_CALLS
  const limit = Number(raw)
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_DAILY_LLM_CALLS
}

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
    ceiling: createDailyCeiling({ limit: dailyCallLimit(config.askDailyLlmCalls), now }),
    cache: { get: cache.get, set: cache.set },
    context: createGraphQLContext,
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
