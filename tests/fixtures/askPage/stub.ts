import {
  BROKEN_QUERY,
  EMPTY_ANSWER,
  EMPTY_QUERY,
  FALLBACK_ANSWER,
  FALLBACK_QUERY,
  RATE_LIMITED_QUERY,
  RETRY_AFTER_SECONDS,
  STRUCTURED_ANSWER,
  STRUCTURED_QUERY,
} from './answers'

/**
 * A stand-in for `POST /api/ask`, for the page's tests only: the component tests register it with
 * `registerEndpoint`. (The SSR suite runs against the real endpoint in fixture mode.) It
 * validates the body the way the endpoint promises to (400), answers the recorded queries and
 * anything else with the fallback answer, and gives two queries to the failure states.
 */

export interface StubResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

export function askStubResponse(body: unknown): StubResponse {
  const { q, locale } = (body ?? {}) as { q?: unknown; locale?: unknown }
  const query = typeof q === 'string' ? q.trim() : ''
  if (!query || query.length > 200 || (locale !== 'uk' && locale !== 'en')) {
    return { status: 400, body: { error: 'INVALID_REQUEST' } }
  }
  if (query === RATE_LIMITED_QUERY) {
    return {
      status: 429,
      headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
      body: { error: 'RATE_LIMITED' },
    }
  }
  if (query === BROKEN_QUERY) return { status: 500, body: { error: 'INTERNAL' } }
  if (query === STRUCTURED_QUERY) return { status: 200, body: STRUCTURED_ANSWER }
  if (query === EMPTY_QUERY) return { status: 200, body: EMPTY_ANSWER }
  if (query === FALLBACK_QUERY) return { status: 200, body: FALLBACK_ANSWER }
  return {
    status: 200,
    body: {
      ...FALLBACK_ANSWER,
      filter: { search: query },
      catalogUrl: `/games?search=${encodeURIComponent(query)}`,
    },
  }
}
