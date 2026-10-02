import type { CandidateCard } from './prompts'
import type { AskLocale, AskParse, AskRerank } from './schemas'

/**
 * The seam between `/api/ask` and whatever model answers it.
 *
 * Production uses the Anthropic adapter (`anthropicProvider.ts`); tests and fixture mode use the
 * recorded one (`recordedProvider.ts`). A provider never throws: every way a call can go wrong is
 * one of the `AskFailure` kinds, returned beside what the call cost, so the pipeline can fall back
 * and still account for the tokens a refused or truncated answer spent.
 */

export type AskFailure =
  /** No key is configured; no request was made. */
  | 'unavailable'
  /** The per-instance daily ceiling of model calls is spent; no request was made. */
  | 'ceiling'
  /** The model declined (`stop_reason: "refusal"`). */
  | 'refusal'
  /** The answer hit `max_tokens` before it was complete. */
  | 'max_tokens'
  /** The answer is missing, is not JSON, or does not have the shape the schema asks for. */
  | 'schema'
  /** The request outlived its own timeout or the request's overall budget. */
  | 'timeout'
  /** HTTP 429, after the one retry the client allows. */
  | 'rate_limited'
  /** Any other error the API or the connection produced. */
  | 'api'
  /** The recorded provider has no answer for this query. */
  | 'unrecorded'

export interface LlmUsage {
  /** Model calls attempted — the unit the daily ceiling counts. */
  calls: number
  inputTokens: number
  outputTokens: number
  /** What the calls with a reported usage cost. */
  costUsd: number
  /**
   * Calls whose usage the API never reported — a timeout, a dropped connection, an error status —
   * so their cost is unknown rather than zero: a request the client gave up on may still have been
   * answered, and billed, by the API.
   */
  unpricedCalls: number
}

export type LlmResult<T> =
  { ok: true; value: T; usage: LlmUsage } | { ok: false; failure: AskFailure; usage: LlmUsage }

export interface LlmCallOptions {
  /** Aborts the call when the request's overall budget runs out. */
  signal?: AbortSignal
  /** This call's own timeout; the adapter's default applies when it is not given. */
  timeoutMs?: number
}

export interface ParseOptions extends LlmCallOptions {
  /** The live taxonomy's genre slugs, which the parse prompt lists. */
  genres: readonly string[]
}

export interface LlmProvider {
  readonly name: string
  parse(query: string, locale: AskLocale, options: ParseOptions): Promise<LlmResult<AskParse>>
  rerank(
    query: string,
    candidates: readonly CandidateCard[],
    locale: AskLocale,
    options?: LlmCallOptions,
  ): Promise<LlmResult<AskRerank>>
}

/** How long one model call may take, at most, whichever provider makes it. */
export const REQUEST_TIMEOUT_MS = 8_000

export const NO_USAGE: LlmUsage = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
}

export function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    // Rounded to a millionth of a dollar, so a sum of float costs prints as the cost it is.
    costUsd: Math.round((left.costUsd + right.costUsd) * 1e6) / 1e6,
    unpricedCalls: left.unpricedCalls + right.unpricedCalls,
  }
}
