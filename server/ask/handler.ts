import * as z from 'zod'
import type { GraphQLContext } from '../graphql/context'
import { indexState } from '../graphql/indexPath'
import type { DailyCeiling, RateLimiter } from './limits'
import { normaliseQuery } from './normalise'
import {
  emptyFallback,
  runAsk,
  type AskAnswer,
  type AskFallbackReason,
  type AskRequest,
} from './pipeline'
import { NO_USAGE, type LlmProvider, type LlmUsage } from './provider'
import { ASK_LOCALES } from './schemas'

/**
 * `POST /api/ask` without h3: the route (`server/api/ask.post.ts`) hands it the body, the client
 * address and the content type, and sends back whatever status, headers and body it returns.
 *
 * In order: the body is validated (400), the address is charged one request (429), the response
 * cache is asked (24 h, keyed by the normalised query, the locale and the index version), the
 * daily ceiling is asked for the two model calls a structured answer needs, and only then does the
 * pipeline run. Every answer is `Cache-Control: no-store`: it is per-question, and a shared cache
 * in front of it would also hold the 429s. The log line carries counts, latency, tokens, cost and
 * mode — never the address and never the query.
 */

export const MAX_QUERY_LENGTH = 200
export const RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** A structured answer costs at most two model calls: the parse and the rerank. */
export const CALLS_PER_ANSWER = 2
const CACHE_KEY_VERSION = 'ask-v1'

const AskBody = z.object({
  q: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(MAX_QUERY_LENGTH)),
  locale: z.enum(ASK_LOCALES),
})

/** What the cache holds per question; `expiresAt` makes it a `boundedCache` entry as it is. */
export interface CachedAsk {
  expiresAt: number
  answer: Omit<AskAnswer, 'tookMs'>
}

export interface AskCache {
  get: <T>(key: string) => Promise<T | null>
  set: (key: string, value: CachedAsk) => Promise<void>
}

export type AskLogLine =
  | { status: 400 | 429 }
  | {
      status: 200
      mode: AskAnswer['mode']
      cache: 'hit' | 'miss'
      provider: string
      failure: AskFallbackReason | null
      tookMs: number
      calls: number
      inputTokens: number
      outputTokens: number
      costUsd: number
      items: number
    }

export interface AskHandlerDeps {
  limiter: RateLimiter
  ceiling: DailyCeiling
  cache: AskCache
  /** A fresh catalog context per request, exactly as the GraphQL endpoint builds one. */
  context: () => Promise<GraphQLContext>
  provider: LlmProvider
  log: (line: AskLogLine) => void
  now: () => number
  budgetMs?: number
}

export interface AskHttpResponse {
  status: 200 | 400 | 429
  headers: Record<string, string>
  body: unknown
}

export interface AskHttpRequest {
  body: unknown
  /** The client address, used for the rate limit and nothing else. */
  ip: string
  contentType: string | undefined
}

const NO_STORE = { 'cache-control': 'no-store' }

/** A provider that refuses every call, for a request the daily ceiling cannot cover. */
function exhausted(name: string): LlmProvider {
  const refuse = async () => ({ ok: false as const, failure: 'ceiling' as const, usage: NO_USAGE })
  return { name, parse: refuse, rerank: refuse }
}

/**
 * Only a JSON body is accepted. A page on another origin can make a browser send a form or a
 * `text/plain` body here without asking first; it cannot send `application/json` without a CORS
 * preflight, which this endpoint never answers — so another site cannot spend this one's budget
 * through its visitors' browsers.
 */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

export async function handleAsk(
  request: AskHttpRequest,
  deps: AskHandlerDeps,
): Promise<AskHttpResponse> {
  const parsed = isJson(request.contentType) ? AskBody.safeParse(request.body) : null
  if (!parsed?.success) {
    deps.log({ status: 400 })
    return { status: 400, headers: NO_STORE, body: { error: 'INVALID_REQUEST' } }
  }

  const decision = deps.limiter.take(request.ip)
  if (!decision.ok) {
    deps.log({ status: 429 })
    return {
      status: 429,
      headers: { ...NO_STORE, 'retry-after': String(decision.retryAfterSeconds) },
      body: { error: 'RATE_LIMITED' },
    }
  }

  const ask: AskRequest = { q: parsed.data.q, locale: parsed.data.locale }
  const started = deps.now()
  const answered = (
    answer: Omit<AskAnswer, 'tookMs'>,
    details: { cache: 'hit' | 'miss'; failure: AskFallbackReason | null; usage: LlmUsage },
  ): AskHttpResponse => {
    const tookMs = Math.max(0, deps.now() - started)
    deps.log({
      status: 200,
      mode: answer.mode,
      cache: details.cache,
      provider: deps.provider.name,
      failure: details.failure,
      tookMs,
      calls: details.usage.calls,
      inputTokens: details.usage.inputTokens,
      outputTokens: details.usage.outputTokens,
      costUsd: details.usage.costUsd,
      items: answer.items.length,
    })
    return { status: 200, headers: NO_STORE, body: { ...answer, tookMs } }
  }

  let context: GraphQLContext
  try {
    context = await deps.context()
  } catch {
    return answered(emptyFallback(ask), { cache: 'miss', failure: 'error', usage: NO_USAGE })
  }

  const version = (await indexState(context)).version
  const key = `${CACHE_KEY_VERSION}:${ask.locale}:${version ?? 'none'}:${normaliseQuery(ask.q)}`
  const cached = await deps.cache.get<CachedAsk>(key).catch(() => null)
  if (cached && cached.expiresAt > deps.now()) {
    return answered(cached.answer, { cache: 'hit', failure: null, usage: NO_USAGE })
  }

  const reserved = deps.ceiling.reserve(CALLS_PER_ANSWER)
  const provider = reserved ? deps.provider : exhausted(deps.provider.name)
  const outcome = await runAsk(ask, {
    context,
    provider,
    budgetMs: deps.budgetMs,
    now: deps.now,
  })
  if (reserved) deps.ceiling.refund(CALLS_PER_ANSWER - outcome.usage.calls)

  const { tookMs: _tookMs, ...answer } = outcome.answer
  // Only a structured answer is kept: a fallback is the result of a failure, and a failure must
  // not stick to a question for a day.
  if (answer.mode === 'structured') {
    await deps.cache
      .set(key, { expiresAt: deps.now() + RESPONSE_CACHE_TTL_MS, answer })
      .catch(() => undefined)
  }
  return answered(answer, { cache: 'miss', failure: outcome.failure, usage: outcome.usage })
}
