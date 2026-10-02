import { describe, expect, it } from 'vitest'
import type { IndexedGame } from '../../../server/index/document'
import type { GraphQLContext } from '../../../server/graphql/context'
import { handleAsk, type AskHandlerDeps, type AskLogLine } from '../../../server/ask/handler'
import { createDailyCeiling, createRateLimiter } from '../../../server/ask/limits'
import type { LlmProvider } from '../../../server/ask/provider'
import { createRecordedProvider, type RecordedAnswers } from '../../../server/ask/recordedProvider'
import { createAnthropicProvider } from '../../../server/ask/anthropicProvider'
import recorded from '../../fixtures/ask/recorded.json' with { type: 'json' }
import published from '../../fixtures/index/published.json' with { type: 'json' }
import {
  createTestCache,
  fixtureRawg,
  fixtureSteam,
  noSteamPrices,
  publishTestIndex,
  TEST_INDEX_META,
  TEST_NOW,
  TEST_TODAY,
} from '../support/yoga'

/**
 * `POST /api/ask` as the route handler sees it, minus h3: validation, the per-IP limit, the daily
 * ceiling, the response cache and what is logged. The pipeline behind it is the real one, over the
 * fixture index and the recorded provider.
 */

const ANSWERS = recorded as RecordedAnswers
const GAMES = published.games as IndexedGame[]
const QUERY = 'атмосферний горор українською'
const IP = '203.0.113.7'

interface Harness {
  deps: AskHandlerDeps
  logs: AskLogLine[]
  calls: { parse: number; rerank: number }
  time: { advance: (ms: number) => void }
  publish: () => Promise<void>
}

function counting(provider: LlmProvider, calls: Harness['calls']): LlmProvider {
  return {
    name: provider.name,
    parse: (...args) => {
      calls.parse += 1
      return provider.parse(...args)
    },
    rerank: (...args) => {
      calls.rerank += 1
      return provider.rerank(...args)
    },
  }
}

async function harness(
  options: {
    ceiling?: number
    provider?: LlmProvider
    context?: () => Promise<GraphQLContext>
  } = {},
): Promise<Harness> {
  let at = Date.parse('2026-10-02T10:00:00.000Z')
  const now = () => at
  const index = await publishTestIndex(GAMES)
  const logs: AskLogLine[] = []
  const calls = { parse: 0, rerank: 0 }
  const store = new Map<string, unknown>()
  const deps: AskHandlerDeps = {
    limiter: createRateLimiter({ now }),
    ceiling: createDailyCeiling({ limit: options.ceiling ?? 500, now }),
    cache: {
      get: async <T>(key: string) => (store.get(key) as T | undefined) ?? null,
      set: async (key, value) => {
        store.set(key, value)
      },
    },
    context:
      options.context ??
      (async () => ({
        rawg: fixtureRawg,
        steam: fixtureSteam,
        today: TEST_TODAY,
        now: TEST_NOW,
        index,
        steamPrices: noSteamPrices,
        cache: createTestCache(),
      })),
    provider: counting(options.provider ?? createRecordedProvider(async () => ANSWERS), calls),
    log: (line) => logs.push(line),
    now,
  }
  return {
    deps,
    logs,
    calls,
    time: {
      advance: (ms) => {
        at += ms
      },
    },
    publish: async () => {
      await publishTestIndex(GAMES, TEST_INDEX_META, index)
    },
  }
}

const json = 'application/json'
const ask = (deps: AskHandlerDeps, body: unknown, ip = IP, contentType = json) =>
  handleAsk({ body, ip, contentType }, deps)

describe('POST /api/ask — validation', () => {
  it.each([
    ['no body', null],
    ['a string body', 'кооператив'],
    ['no query', { locale: 'uk' }],
    ['an empty query', { q: '', locale: 'uk' }],
    ['a blank query', { q: '   \n ', locale: 'uk' }],
    ['a query over 200 characters', { q: 'a'.repeat(201), locale: 'uk' }],
    ['a query that is not a string', { q: ['a'], locale: 'uk' }],
    ['no locale', { q: 'co-op' }],
    ['an unknown locale', { q: 'co-op', locale: 'de' }],
  ])('refuses %s with a 400', async (_label, body) => {
    const { deps, calls } = await harness()
    const response = await ask(deps, body)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'INVALID_REQUEST' })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(calls.parse).toBe(0)
  })

  it('refuses a body that is not JSON, which a cross-site form could send', async () => {
    const { deps } = await harness()
    const response = await ask(deps, { q: QUERY, locale: 'uk' }, IP, 'text/plain')
    expect(response.status).toBe(400)
  })

  it('accepts a JSON content type with parameters', async () => {
    const { deps } = await harness()
    const response = await ask(
      deps,
      { q: QUERY, locale: 'uk' },
      IP,
      'application/json; charset=utf-8',
    )
    expect(response.status).toBe(200)
  })

  it('measures the 200-character limit after trimming', async () => {
    const { deps } = await harness()
    const response = await ask(deps, { q: `  ${'a'.repeat(200)}  `, locale: 'uk' })
    expect(response.status).toBe(200)
  })
})

describe('POST /api/ask — answers', () => {
  it('answers a recorded query with a structured, uncacheable response', async () => {
    const { deps, calls } = await harness()
    const response = await ask(deps, { q: QUERY, locale: 'uk' })
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({
      mode: 'structured',
      interpretation: 'Атмосферні горори з українською локалізацією',
      filter: { ukrainianLocalisation: 'ANY' },
      catalogUrl: '/games?ukrainianLocalisation=ANY',
      items: [
        { card: { id: '13537' }, reason: 'Гнітюча атмосфера Сіті 17, українські субтитри' },
        { card: { id: '41494' } },
        { card: { id: '3328' } },
      ],
    })
    expect(calls).toEqual({ parse: 1, rerank: 1 })
  })

  it('answers the fallback for a query nobody recorded, never an error', async () => {
    const { deps } = await harness()
    const response = await ask(deps, { q: 'щось як Hades, але коротше', locale: 'uk' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ mode: 'fallback', interpretation: null })
  })

  it('answers the fallback without a key, and makes no request', async () => {
    const { deps } = await harness({ provider: createAnthropicProvider({ apiKey: '' }) })
    const response = await ask(deps, { q: QUERY, locale: 'uk' })
    expect(response.body).toMatchObject({ mode: 'fallback' })
  })

  it('answers an empty fallback when the request context cannot even be built', async () => {
    const { deps } = await harness({
      context: () => Promise.reject(new Error('no index')),
    })
    const response = await ask(deps, { q: QUERY, locale: 'en' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      mode: 'fallback',
      interpretation: null,
      filter: { search: QUERY },
      catalogUrl: expect.stringMatching(/^\/en\/games\?search=/),
      items: [],
    })
  })
})

describe('POST /api/ask — the per-IP limit', () => {
  it('refuses the eleventh request in a minute with a 429 and Retry-After', async () => {
    const { deps, calls } = await harness()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await ask(deps, { q: `q${attempt}`, locale: 'uk' })).status).toBe(200)
    }
    const refused = await ask(deps, { q: QUERY, locale: 'uk' })
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({ error: 'RATE_LIMITED' })
    expect(refused.headers['retry-after']).toBe('6')
    expect(refused.headers['cache-control']).toBe('no-store')
    expect(calls.parse).toBe(10)
  })

  it('counts every address on its own', async () => {
    const { deps } = await harness()
    for (let attempt = 0; attempt < 10; attempt += 1) await ask(deps, { q: 'x', locale: 'uk' })
    expect((await ask(deps, { q: 'x', locale: 'uk' })).status).toBe(429)
    expect((await ask(deps, { q: 'x', locale: 'uk' }, '198.51.100.1')).status).toBe(200)
  })

  it('does not count a request it refused as invalid', async () => {
    const { deps } = await harness()
    for (let attempt = 0; attempt < 20; attempt += 1) await ask(deps, { q: '' })
    expect((await ask(deps, { q: 'x', locale: 'uk' })).status).toBe(200)
  })
})

describe('POST /api/ask — the daily ceiling', () => {
  it('answers the fallback without calling the model once the ceiling is spent', async () => {
    const { deps, calls } = await harness({ ceiling: 2 })
    expect((await ask(deps, { q: QUERY, locale: 'uk' })).body).toMatchObject({
      mode: 'structured',
    })
    const spent = await ask(deps, { q: 'кооператив для двох на Switch до 500 грн', locale: 'uk' })
    expect(spent.status).toBe(200)
    expect(spent.body).toMatchObject({ mode: 'fallback' })
    expect(calls).toEqual({ parse: 1, rerank: 1 })
  })

  it('gives back the call a failed parse did not use', async () => {
    const { deps, calls } = await harness({ ceiling: 3 })
    // Unrecorded: one parse call, no rerank, so one of the two reserved calls comes back.
    await ask(deps, { q: 'unknown', locale: 'uk' })
    expect((await ask(deps, { q: QUERY, locale: 'uk' })).body).toMatchObject({
      mode: 'structured',
    })
    expect(calls).toEqual({ parse: 2, rerank: 1 })
  })

  it('starts again the next UTC day', async () => {
    const { deps, time } = await harness({ ceiling: 2 })
    await ask(deps, { q: QUERY, locale: 'uk' })
    time.advance(24 * 60 * 60 * 1000)
    expect(
      (await ask(deps, { q: 'something like The Witcher 3', locale: 'en' })).body,
    ).toMatchObject({ mode: 'structured' })
  })
})

describe('POST /api/ask — the response cache', () => {
  it('serves the same question again from the cache, whatever its case and spacing', async () => {
    const { deps, calls, logs } = await harness()
    const first = await ask(deps, { q: QUERY, locale: 'uk' })
    const second = await ask(deps, { q: `  ${QUERY.toUpperCase()} `, locale: 'uk' })
    expect(calls).toEqual({ parse: 1, rerank: 1 })
    const { tookMs: _first, ...firstAnswer } = first.body as Record<string, unknown>
    const { tookMs: _second, ...secondAnswer } = second.body as Record<string, unknown>
    expect(secondAnswer).toEqual(firstAnswer)
    expect(logs.map((line) => line.cache)).toEqual(['miss', 'hit'])
  })

  it('keeps the locales apart', async () => {
    const { deps, calls } = await harness()
    await ask(deps, { q: QUERY, locale: 'uk' })
    await ask(deps, { q: QUERY, locale: 'en' })
    expect(calls.parse).toBe(2)
  })

  it('misses after the index publishes a new version', async () => {
    const { deps, calls, publish } = await harness()
    await ask(deps, { q: QUERY, locale: 'uk' })
    await publish()
    await ask(deps, { q: QUERY, locale: 'uk' })
    expect(calls.parse).toBe(2)
  })

  it('never caches a fallback, so a failure does not stick for a day', async () => {
    const { deps, calls } = await harness()
    await ask(deps, { q: 'unknown', locale: 'uk' })
    await ask(deps, { q: 'unknown', locale: 'uk' })
    expect(calls.parse).toBe(2)
  })

  it('expires an entry after 24 hours', async () => {
    const { deps, calls, time } = await harness()
    await ask(deps, { q: QUERY, locale: 'uk' })
    time.advance(24 * 60 * 60 * 1000 + 1)
    await ask(deps, { q: QUERY, locale: 'uk' })
    expect(calls.parse).toBe(2)
  })
})

describe('POST /api/ask — logging', () => {
  it('logs counts, latency, tokens, cost and mode — never the address or the query', async () => {
    const { deps, logs } = await harness()
    await ask(deps, { q: QUERY, locale: 'uk' })
    await ask(deps, { q: 'unknown query', locale: 'uk' })
    for (let attempt = 0; attempt < 10; attempt += 1) await ask(deps, { q: 'x', locale: 'uk' })

    expect(logs[0]).toEqual({
      status: 200,
      mode: 'structured',
      cache: 'miss',
      provider: 'recorded',
      failure: null,
      tookMs: expect.any(Number),
      calls: 2,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      items: 3,
    })
    expect(logs[1]).toMatchObject({ status: 200, mode: 'fallback', failure: 'unrecorded' })
    expect(logs.at(-1)).toEqual({ status: 429 })
    const text = JSON.stringify(logs)
    expect(text).not.toContain(IP)
    expect(text).not.toContain('горор')
    expect(text).not.toContain('unknown query')
  })
})
