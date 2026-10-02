import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import {
  parseSystemPrompt,
  parseUserMessage,
  RERANK_SYSTEM_PROMPT,
  rerankUserMessage,
} from './prompts'
import {
  NO_USAGE,
  REQUEST_TIMEOUT_MS,
  type AskFailure,
  type LlmCallOptions,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
} from './provider'
import { AskParseSchema, AskRerankSchema, readParse, readRerank } from './schemas'

/**
 * The production provider: Claude Haiku 4.5 through the official SDK, with structured outputs.
 *
 * `messages.parse` sends the zod schema as `output_config.format`, so the model is constrained to
 * the shape, and parses the answer against it; `readParse`/`readRerank` then read it a second time
 * with the server's own lenient rules. No thinking: Haiku 4.5 would need a budget for it, and the
 * latency is not worth it for a filter. Temperature 0, so the same query keeps the same reading.
 *
 * Every failure comes back typed (see `AskFailure`), never thrown. One caveat of `messages.parse`:
 * when an answer is cut off mid-JSON the SDK throws while parsing it, before the stop reason can
 * be read, so a truncated answer that had any text reports `schema`, not `max_tokens`.
 */

export const ASK_MODEL = 'claude-haiku-4-5'
export const PARSE_MAX_TOKENS = 500
export const RERANK_MAX_TOKENS = 900
export const MAX_RETRIES = 1
export { REQUEST_TIMEOUT_MS }

/** Haiku 4.5 list prices, in US dollars per million tokens. */
export const PRICE_PER_MILLION_TOKENS = { input: 1, output: 5 } as const

const PARSE_FORMAT = zodOutputFormat(AskParseSchema)
const RERANK_FORMAT = zodOutputFormat(AskRerankSchema)

export interface AnthropicProviderOptions {
  /** The server-only key. Empty means unavailable: every call fails without a request. */
  apiKey?: string
  /** A ready client, for tests that replace its transport. Takes precedence over `apiKey`. */
  client?: Anthropic
}

function usageOf(usage: { input_tokens: number; output_tokens: number }): LlmUsage {
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  return {
    calls: 1,
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens * PRICE_PER_MILLION_TOKENS.input +
        outputTokens * PRICE_PER_MILLION_TOKENS.output) /
      1_000_000,
  }
}

const ATTEMPTED: LlmUsage = { ...NO_USAGE, calls: 1 }

/** Most specific first: every class below extends `APIError`, which extends `AnthropicError`. */
function failureOf(error: unknown): AskFailure {
  if (error instanceof Anthropic.APIUserAbortError) return 'timeout'
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout'
  if (error instanceof Anthropic.RateLimitError) return 'rate_limited'
  if (error instanceof Anthropic.APIError) return 'api'
  // What remains is the SDK's own parsing of the answer: not JSON, or not the schema's shape.
  if (error instanceof Anthropic.AnthropicError) return 'schema'
  return 'api'
}

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const client =
    options.client ??
    (options.apiKey
      ? new Anthropic({
          apiKey: options.apiKey,
          maxRetries: MAX_RETRIES,
          timeout: REQUEST_TIMEOUT_MS,
        })
      : null)

  async function call<T>(
    request: { system: string; user: string; maxTokens: number },
    format: typeof PARSE_FORMAT | typeof RERANK_FORMAT,
    read: (value: unknown) => T | null,
    callOptions: LlmCallOptions = {},
  ): Promise<LlmResult<T>> {
    if (!client) return { ok: false, failure: 'unavailable', usage: NO_USAGE }
    try {
      const response = await client.messages.parse(
        {
          model: ASK_MODEL,
          max_tokens: request.maxTokens,
          temperature: 0,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: { format },
        },
        {
          timeout: callOptions.timeoutMs ?? REQUEST_TIMEOUT_MS,
          maxRetries: MAX_RETRIES,
          signal: callOptions.signal,
        },
      )
      const usage = usageOf(response.usage)
      if (response.stop_reason === 'refusal') return { ok: false, failure: 'refusal', usage }
      if (response.stop_reason === 'max_tokens') return { ok: false, failure: 'max_tokens', usage }
      if (response.parsed_output === null) return { ok: false, failure: 'schema', usage }
      const value = read(response.parsed_output)
      if (value === null) return { ok: false, failure: 'schema', usage }
      return { ok: true, value, usage }
    } catch (error) {
      return { ok: false, failure: failureOf(error), usage: ATTEMPTED }
    }
  }

  return {
    name: 'anthropic',
    parse: (query, locale, parseOptions) =>
      call(
        {
          system: parseSystemPrompt(parseOptions.genres),
          user: parseUserMessage(query, locale),
          maxTokens: PARSE_MAX_TOKENS,
        },
        PARSE_FORMAT,
        readParse,
        parseOptions,
      ),
    rerank: (query, candidates, locale, rerankOptions) =>
      call(
        {
          system: RERANK_SYSTEM_PROMPT,
          user: rerankUserMessage(query, candidates, locale),
          maxTokens: RERANK_MAX_TOKENS,
        },
        RERANK_FORMAT,
        readRerank,
        rerankOptions,
      ),
  }
}
