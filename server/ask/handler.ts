import * as z from 'zod'
import type { GraphQLContext } from '../graphql/context'
import { indexState } from '../graphql/indexPath'
import type { DailyAllowance, DailyCeiling, RateLimiter } from './limits'
import { normaliseQuery } from './normalise'
import {
  emptyFallback,
  runAsk,
  TOTAL_BUDGET_MS,
  type AskAnswer,
  type AskFallbackReason,
  type AskOutcome,
  type AskRequest,
  type AskStep,
  type AskTimings,
} from './pipeline'
import { NO_USAGE, type AskFailure, type LlmProvider, type LlmUsage } from './provider'
import { ASK_LOCALES } from './schemas'

/**
 * `POST /api/ask` without h3: the route (`server/api/ask.post.ts`) hands it the body, the client
 * address and the content type, and sends back whatever status, headers and body it returns.
 *
 * In order: the body is validated (400), the address is charged one request (429), the response
 * cache is asked (keyed by the normalised query, the locale and the index version; 24 h for a
 * sound answer, 10 minutes for a degraded one), the client's daily allowance of model-backed
 * answers and the instance's daily ceiling are asked for the two model calls a structured answer
 * needs, and only then does the pipeline run, under one deadline that started when the request
 * did. A client past either limit gets the fallback; cached answers cost it nothing. Every answer is `Cache-Control: no-store`: it is per-question, and a shared cache
 * in front of it would also hold the 429s. The log line carries counts, latency, tokens, cost and
 * mode — never the address and never the query.
 */

export const MAX_QUERY_LENGTH = 200
/** A body larger than this is refused unread: a 200-character question fits many times over. */
export const MAX_BODY_BYTES = 4_096
export const RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/**
 * How long a degraded answer is kept — one the index answered stale or not at all, with an
 * ignored filter, in RAWG's place because RAWG was slow, or without its ranking. Long enough to absorb a burst of the same question,
 * short enough that the answer improves once the index or the model does.
 */
export const DEGRADED_CACHE_TTL_MS = 10 * 60 * 1000
/** A structured answer costs at most two model calls: the parse and the rerank. */
export const CALLS_PER_ANSWER = 2
const CACHE_KEY_VERSION = 'ask-v7'

const AskBody = z.object({
  q: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(MAX_QUERY_LENGTH)),
  locale: z.enum(ASK_LOCALES),
})

/**
 * What the cache holds per question; `expiresAt` makes it a `boundedCache` entry as it is. The
 * key is the normalised query and the locale; the index version the answer was built on is kept
 * inside, and an entry from another version is a miss — so the key can be looked up before the
 * index state has been read, and a publication still invalidates every entry by itself.
 */
export interface CachedAsk {
  expiresAt: number
  version: number | null
  answer: Omit<AskAnswer, 'tookMs'>
}

export interface AskCache {
  get: (key: string) => Promise<CachedAsk | null>
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
      rerankFailure: AskFailure | null
      search: AskOutcome['search']
      degraded: boolean
      tookMs: number
      calls: number
      inputTokens: number
      outputTokens: number
      /** The parse's and the rerank's own output tokens; `null` for a call that was not made. */
      parseOutputTokens: number | null
      rerankOutputTokens: number | null
      /** `'unknown'` when a call was never answered, so its cost was never reported. */
      costUsd: number | 'unknown'
      items: number
      /** How long each step took, in ms (`AskStep`). */
      ms: AskTimings
    }

export interface AskHandlerDeps {
  limiter: RateLimiter
  /** Model-backed answers per client per day. */
  allowance: DailyAllowance
  ceiling: DailyCeiling
  cache: AskCache
  /** A fresh catalog context per request, exactly as the GraphQL endpoint builds one. */
  context: () => Promise<GraphQLContext>
  provider: LlmProvider
  log: (line: AskLogLine) => void
  now: () => number
}

export interface AskHttpResponse {
  status: 200 | 400 | 429
  headers: Record<string, string>
  body: unknown
}

export interface AskHttpRequest {
  body: unknown
  /** The client's key (`server/ask/clientIp.ts`), used for the limits and nothing else. */
  ip: string
  contentType: string | undefined
  /** The `content-length` header, when the client sent one. */
  contentLength: string | undefined
}

const NO_STORE = { 'cache-control': 'no-store' }

/** A provider that refuses every call, for a request a daily limit cannot cover. */
function exhausted(name: string, failure: 'ceiling' | 'quota'): LlmProvider {
  const refuse = async () => ({ ok: false as const, failure, usage: NO_USAGE })
  return { name, parse: refuse, rerank: refuse }
}

/** Refused unread when the client says the body is larger than any valid question. */
function tooLarge(contentLength: string | undefined): boolean {
  if (contentLength === undefined) return false
  const bytes = Number(contentLength)
  return !Number.isFinite(bytes) || bytes > MAX_BODY_BYTES
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
  const parsed =
    isJson(request.contentType) && !tooLarge(request.contentLength)
      ? AskBody.safeParse(request.body)
      : null
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
  // One deadline for the whole request, from here: building the context and reading the index
  // state count against it as much as the model does.
  const started = deps.now()
  const deadline = started + TOTAL_BUDGET_MS
  const answered = (
    answer: Omit<AskAnswer, 'tookMs'>,
    details: Partial<
      Pick<AskOutcome, 'rerankFailure' | 'search' | 'degraded' | 'timings' | 'outputTokens'>
    > & {
      cache: 'hit' | 'miss'
      failure: AskFallbackReason | null
      usage: LlmUsage
    },
  ): AskHttpResponse => {
    const tookMs = Math.max(0, deps.now() - started)
    deps.log({
      status: 200,
      mode: answer.mode,
      cache: details.cache,
      provider: deps.provider.name,
      failure: details.failure,
      rerankFailure: details.rerankFailure ?? null,
      search: details.search ?? null,
      degraded: details.degraded ?? false,
      tookMs,
      calls: details.usage.calls,
      inputTokens: details.usage.inputTokens,
      outputTokens: details.usage.outputTokens,
      parseOutputTokens: details.outputTokens?.parse ?? null,
      rerankOutputTokens: details.outputTokens?.rerank ?? null,
      costUsd: details.usage.unpricedCalls > 0 ? 'unknown' : details.usage.costUsd,
      items: answer.items.length,
      ms: { ...timings, ...details.timings },
    })
    return { status: 200, headers: NO_STORE, body: { ...answer, tookMs } }
  }

  const timings: AskTimings = {}
  const timed = <T>(step: AskStep, work: Promise<T>): Promise<T> => {
    const from = deps.now()
    return work.finally(() => {
      timings[step] = Math.max(0, deps.now() - from)
    })
  }

  let context: GraphQLContext
  try {
    context = await timed('context', deps.context())
  } catch {
    return answered(emptyFallback(ask), {
      cache: 'miss',
      failure: 'error',
      usage: NO_USAGE,
      degraded: true,
    })
  }

  // The index state is read from here on, beside everything else: the pipeline's parse does not
  // wait for it, and only a cache hit — to check the version it was stored under — or a cache
  // write needs it here. The pipeline reads the same promise (`indexState` keeps one per request).
  const state = timed('indexState', indexState(context))
  const key = `${CACHE_KEY_VERSION}:${ask.locale}:${normaliseQuery(ask.q)}`
  const cached = await timed(
    'cache',
    deps.cache.get(key).catch(() => null),
  )
  if (cached && cached.expiresAt > deps.now() && cached.version === (await state).version) {
    return answered(cached.answer, { cache: 'hit', failure: null, usage: NO_USAGE })
  }

  // The client's own allowance first, so a client past it does not reserve the instance's calls.
  const allowed = deps.allowance.available(request.ip)
  const reserved = allowed && deps.ceiling.reserve(CALLS_PER_ANSWER)
  const provider = reserved
    ? deps.provider
    : exhausted(deps.provider.name, allowed ? 'ceiling' : 'quota')
  const outcome = await runAsk(ask, { context, provider, deadline, now: deps.now })
  if (reserved) deps.ceiling.refund(CALLS_PER_ANSWER - outcome.usage.calls)
  if (outcome.usage.calls > 0) deps.allowance.use(request.ip)

  const { tookMs: _tookMs, ...answer } = outcome.answer
  // Only a structured answer is kept: a fallback is the result of a failure, and a failure must
  // not stick to a question. A degraded one is kept briefly, a sound one for a day.
  if (answer.mode === 'structured') {
    const ttl = outcome.degraded ? DEGRADED_CACHE_TTL_MS : RESPONSE_CACHE_TTL_MS
    const { version } = await state
    await deps.cache
      .set(key, { expiresAt: deps.now() + ttl, version, answer })
      .catch(() => undefined)
  }
  return answered(answer, { ...outcome, cache: 'miss' })
}
