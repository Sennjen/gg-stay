import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { createAnthropicProvider } from '../../../server/ask/anthropicProvider'
import type { CandidateCard } from '../../../server/ask/prompts'

/**
 * The Anthropic adapter against the real SDK client with its transport replaced: every request
 * the SDK would send is captured, and every answer is one the Messages API could give. Nothing
 * here reaches the network, and no key is real.
 */

interface Captured {
  url: string
  body: Record<string, unknown>
  headers: Headers
}

type Reply = (request: Captured, init: RequestInit) => Response | Promise<Response>

function message(text: string | null, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: text === null ? [] : [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1_000, output_tokens: 100 },
    ...overrides,
  })
}

function apiError(status: number, type: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { type: 'error', error: { type, message: 'test' } },
    { status, headers: { 'retry-after-ms': '1', ...headers } },
  )
}

function clientReplying(...replies: Reply[]) {
  const requests: Captured[] = []
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const captured: Captured = {
      url: String(input),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    }
    requests.push(captured)
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!
    return reply(captured, init)
  }
  const client = new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 1 })
  return { client, requests }
}

/** A transport that answers only when the request is aborted, the way a hung connection does. */
const hang: Reply = (_request, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    )
  })

const PARSE_ANSWER = {
  platforms: ['NINTENDO'],
  genres: [],
  tags: [],
  gameModes: ['LOCAL_COOP'],
  ageRating: [],
  playtime: null,
  yearFrom: null,
  yearTo: null,
  metacriticMin: null,
  ratingMin: null,
  priceMaxUah: 500,
  free: null,
  onSaleMinPercent: null,
  ukrainianLocalisation: null,
  madeInUkraine: null,
  sort: null,
  searchText: null,
  similarTo: null,
  interpretation: 'Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
}

const CANDIDATE: CandidateCard = {
  id: '3328',
  name: 'The Witcher 3: Wild Hunt',
  year: 2015,
  genres: ['action'],
  tags: [],
  modes: ['SINGLE'],
  priceUah: 675,
  discountPercent: 0,
  free: false,
  ukrainian: 'audio',
  hours: 43,
}

const QUERY = 'кооператив для двох на Switch до 500 грн'

describe('the Anthropic provider', () => {
  it('sends the parse request the design fixes and returns the parsed answer with its cost', async () => {
    const { client, requests } = clientReplying(() => message(JSON.stringify(PARSE_ANSWER)))
    const provider = createAnthropicProvider({ client })

    const result = await provider.parse(QUERY, 'uk', { genres: ['indie', 'action'] })

    expect(result).toEqual({
      ok: true,
      value: PARSE_ANSWER,
      usage: { calls: 1, inputTokens: 1_000, outputTokens: 100, costUsd: 0.0015, unpricedCalls: 0 },
    })
    expect(requests).toHaveLength(1)
    const body = requests[0]!.body
    expect(requests[0]!.url).toMatch(/\/v1\/messages$/)
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.max_tokens).toBe(500)
    expect(body.temperature).toBe(0)
    expect(body).not.toHaveProperty('thinking')
    expect(body.system).toContain('action, indie')
    expect(body.messages).toEqual([{ role: 'user', content: expect.stringContaining(QUERY) }])
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } })
    expect(requests[0]!.headers.get('x-api-key')).toBe('test-key')
  })

  it('sends the rerank request with its own token ceiling and the candidate cards', async () => {
    const answer = { items: [{ id: '3328', reason: 'Велика RPG з українською озвучкою' }] }
    const { client, requests } = clientReplying(() => message(JSON.stringify(answer)))
    const provider = createAnthropicProvider({ client })

    const result = await provider.rerank(QUERY, [CANDIDATE], 'uk')

    expect(result).toMatchObject({ ok: true, value: answer })
    const body = requests[0]!.body
    expect(body.max_tokens).toBe(1_600)
    expect(body.temperature).toBe(0)
    expect(JSON.stringify(body.messages)).toContain('3328 | The Witcher 3: Wild Hunt')
  })

  it('reports a refusal as a typed failure and still accounts for the tokens', async () => {
    const { client } = clientReplying(() =>
      message(null, { stop_reason: 'refusal', usage: { input_tokens: 800, output_tokens: 2 } }),
    )
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toEqual({
      ok: false,
      failure: 'refusal',
      usage: { calls: 1, inputTokens: 800, outputTokens: 2, costUsd: 0.00081, unpricedCalls: 0 },
    })
  })

  it('reports an answer cut off by max_tokens as a typed failure', async () => {
    const { client } = clientReplying(() => message(null, { stop_reason: 'max_tokens' }))
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toMatchObject({ ok: false, failure: 'max_tokens' })
  })

  it('reports truncated JSON as max_tokens, with the tokens it cost', async () => {
    const { client } = clientReplying(() =>
      message('{"platforms": ["NINT', {
        stop_reason: 'max_tokens',
        usage: { input_tokens: 2_000, output_tokens: 500 },
      }),
    )
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toEqual({
      ok: false,
      failure: 'max_tokens',
      usage: { calls: 1, inputTokens: 2_000, outputTokens: 500, costUsd: 0.0045, unpricedCalls: 0 },
    })
  })

  it('reports a refusal that left partial text as a refusal, with the tokens it cost', async () => {
    const { client } = clientReplying(() => message('{"items": [', { stop_reason: 'refusal' }))
    const result = await createAnthropicProvider({ client }).rerank(QUERY, [CANDIDATE], 'uk')
    expect(result).toMatchObject({ ok: false, failure: 'refusal', usage: { inputTokens: 1_000 } })
  })

  it('reports text that is not JSON as a schema failure, with the tokens it cost', async () => {
    const { client } = clientReplying(() => message('Sorry, I cannot do that.'))
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toMatchObject({
      ok: false,
      failure: 'schema',
      usage: { inputTokens: 1_000, outputTokens: 100, unpricedCalls: 0 },
    })
  })

  it('reads an over-long reason leniently instead of failing the rerank', async () => {
    const answer = { items: [{ id: '3328', reason: 'д'.repeat(300) }] }
    const { client } = clientReplying(() => message(JSON.stringify(answer)))
    const result = await createAnthropicProvider({ client }).rerank(QUERY, [CANDIDATE], 'uk')
    expect(result).toMatchObject({ ok: true, value: answer })
  })

  it('tells the model the 100-character reason limit through the schema', async () => {
    const { client, requests } = clientReplying(() => message(JSON.stringify({ items: [] })))
    await createAnthropicProvider({ client }).rerank(QUERY, [CANDIDATE], 'uk')
    expect(JSON.stringify(requests[0]!.body.output_config)).toContain('maxLength: 100')
  })

  it('reports a missing parsed output as a schema failure', async () => {
    const { client } = clientReplying(() => message(null))
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toEqual({
      ok: false,
      failure: 'schema',
      usage: { calls: 1, inputTokens: 1_000, outputTokens: 100, costUsd: 0.0015, unpricedCalls: 0 },
    })
  })

  it('reports an answer that does not match the schema as a schema failure', async () => {
    const { client } = clientReplying(() => message(JSON.stringify({ hello: 'world' })))
    const result = await createAnthropicProvider({ client }).rerank(QUERY, [CANDIDATE], 'uk')
    expect(result).toMatchObject({ ok: false, failure: 'schema' })
  })

  it('reports a 429 as rate limited after the one retry the design allows, cost unknown', async () => {
    const { client, requests } = clientReplying(() => apiError(429, 'rate_limit_error'))
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toEqual({
      ok: false,
      failure: 'rate_limited',
      usage: { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 1 },
    })
    expect(requests).toHaveLength(2)
  })

  it('recovers when the one retry succeeds', async () => {
    const { client, requests } = clientReplying(
      () => apiError(529, 'overloaded_error'),
      () => message(JSON.stringify(PARSE_ANSWER)),
    )
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result.ok).toBe(true)
    expect(requests).toHaveLength(2)
  })

  it.each([
    [401, 'authentication_error'],
    [400, 'invalid_request_error'],
    [500, 'api_error'],
  ])('reports HTTP %i as an API failure', async (status, type) => {
    const { client } = clientReplying(() => apiError(status, type))
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', { genres: [] })
    expect(result).toMatchObject({ ok: false, failure: 'api' })
  })

  it('reports a request past its timeout as a timeout, after exactly one retry', async () => {
    const { client, requests } = clientReplying(hang)
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', {
      genres: [],
      timeoutMs: 20,
    })
    // A client-side timeout may still be billed by the API, so its cost is unknown, not zero.
    expect(result).toMatchObject({ ok: false, failure: 'timeout', usage: { unpricedCalls: 1 } })
    expect(requests).toHaveLength(2)
  })

  it('reports a request the pipeline aborted as a timeout, without retrying it', async () => {
    const { client, requests } = clientReplying(hang)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const result = await createAnthropicProvider({ client }).parse(QUERY, 'uk', {
      genres: [],
      signal: controller.signal,
    })
    expect(result).toMatchObject({ ok: false, failure: 'timeout' })
    expect(requests).toHaveLength(1)
  })

  it('is unavailable without a key, and never builds a client', async () => {
    const provider = createAnthropicProvider({ apiKey: '' })
    expect(await provider.parse(QUERY, 'uk', { genres: [] })).toMatchObject({
      ok: false,
      failure: 'unavailable',
      usage: { calls: 0, unpricedCalls: 0 },
    })
  })
})
