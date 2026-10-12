import type { UpstreamCache, UpstreamRuntime } from '../../server/upstream/createUpstreamFetch'

/**
 * What the job's transports to GOG, the Microsoft Store and the National Bank have in common.
 *
 * They are built from the shared factory (`server/upstream/createUpstreamFetch.ts`), like the
 * RAWG and Steam ones, so the pacing, the abort timeout, the one retry on a timeout or a 5xx and
 * the fixture mode are the factory's and not a copy of them. What is theirs is here: none of them
 * keeps an answer, and all of them are paced at a request a second.
 *
 * They live under `scripts/` on purpose. The site makes no request to any of these three hosts —
 * everything it shows from them was read by the job and is served from the index — and a
 * transport the server cannot import is a transport no resolver can come to call.
 */

/** What a store transport is given: the factory's runtime without a cache or a keep-alive. */
export type StoreUpstreamRuntime = Omit<UpstreamRuntime, 'cache' | 'keepAlive'>

/**
 * One request a second, to each of the three hosts, with no burst. None of them publishes a limit
 * for these endpoints, and none documents the endpoint for third parties at all; a request a
 * second is what a person paging through the store's own site makes, and a refresh is a few dozen
 * requests twice a day.
 */
export const STORE_MIN_INTERVAL_MS = 1_000

/** A first attempt and one retry, as every transport of this project makes. */
export const STORE_MAX_ATTEMPTS = 2

/**
 * A price is read to be published as what the store charges now, so no answer is ever kept: a
 * second walk in the same process, should there ever be one, asks again.
 */
export const NO_CACHE: UpstreamCache = {
  get: async () => null,
  set: async () => {},
}

/** A plain object, or `undefined` for anything else — an array included. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The whole percent a price is below its regular price, as both stores' own labels round it: 0
 * when there is no regular price to be below, and never negative.
 */
export function discountPercentOf(amount: number, regularAmount: number): number {
  if (regularAmount <= 0 || amount >= regularAmount) return 0
  return Math.round((1 - amount / regularAmount) * 100)
}
