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
 * The production provider: Claude Haiku 5.5 through the official SDK, with structured outputs.
 *
 * The zod schema goes to the API as `output_config.format` (`zodOutputFormat`), so the model is
 * constrained to the shape. The answer is read with `messages.create` rather than
 * `messages.parse`: `parse` validates inside the SDK and throws on an answer cut off mid-JSON or a
 * reason one character too long — before the stop reason or the token usage can be read, so a
 * billed call would be reported as free and as the wrong failure. Here the stop reason and the
 * usage are read first, and the text is then parsed as JSON and read with the server's own
 * lenient rules (`readParse`/`readRerank`), which drop or cut what they do not accept instead of
 * failing. Thinking is switched off: this model thinks unless told not to, and neither the wait nor
 * the output tokens it would take from the ceilings below are worth it for a filter. No sampling
 * parameters: the model rejects them, so what keeps one query to one reading is the schema and the
 * answer cache.
 *
 * Every failure comes back typed (see `AskFailure`), never thrown, with the tokens it cost when the
 * API reported them; a call it never answered (a timeout, an error status) is counted as unpriced.
 * A client-side timeout may still be answered and billed by the API, and the one retry the client
 * allows may then bill a second time — the worst case of one counted call is two billed ones.
 */

export const ASK_MODEL = 'claude-haiku-5-5'
/**
 * Both ceilings were set for Haiku 4.5 (500 and 1 200) and grew by the 30 % more tokens this
 * model's tokenizer counts for the same text, so an answer has the room it had.
 */
export const PARSE_MAX_TOKENS = 650
/**
 * Eight reasons of at most 80 characters, in Cyrillic, were about 400–500 tokens as Haiku 4.5
 * counted them; the rest is headroom. Fewer output tokens are the one real lever on the rerank's
 * latency.
 */
export const RERANK_MAX_TOKENS = 1_600
export const MAX_RETRIES = 1
export { REQUEST_TIMEOUT_MS }

/**
 * Haiku 5.5 list prices, in US dollars per million tokens, for a prompt of up to 100 000 tokens.
 * These prompts are a few thousand; a longer one would be billed at five times as much.
 */
export const PRICE_PER_MILLION_TOKENS = { input: 0.1, output: 0.5 } as const

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
    unpricedCalls: 0,
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens * PRICE_PER_MILLION_TOKENS.input +
        outputTokens * PRICE_PER_MILLION_TOKENS.output) /
      1_000_000,
  }
}

const UNANSWERED: LlmUsage = { ...NO_USAGE, calls: 1, unpricedCalls: 1 }

/** Most specific first: every class below extends `APIError`, which extends `AnthropicError`. */
function failureOf(error: unknown): AskFailure {
  if (error instanceof Anthropic.APIUserAbortError) return 'timeout'
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout'
  if (error instanceof Anthropic.RateLimitError) return 'rate_limited'
  return 'api'
}

/** The answer's first text block as JSON; `null` when there is none or it is not JSON. */
function jsonOf(content: readonly Anthropic.ContentBlock[]): unknown {
  const text = content.find((block) => block.type === 'text')?.text
  if (text === undefined) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
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
      const response = await client.messages.create(
        {
          model: ASK_MODEL,
          max_tokens: request.maxTokens,
          thinking: { type: 'disabled' },
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
      const value = read(jsonOf(response.content))
      if (value === null) return { ok: false, failure: 'schema', usage }
      return { ok: true, value, usage }
    } catch (error) {
      return { ok: false, failure: failureOf(error), usage: UNANSWERED }
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
          user: rerankUserMessage(query, candidates, locale, rerankOptions?.interpretation),
          maxTokens: RERANK_MAX_TOKENS,
        },
        RERANK_FORMAT,
        readRerank,
        rerankOptions,
      ),
  }
}
