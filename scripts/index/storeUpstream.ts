import { MAX_OFFER_TITLE_LENGTH } from '../../server/index/document'
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

/** Characters that change how text is laid out and are no part of a title: zero-width, bidi. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g

/**
 * What a store calls a product, as an offer may carry it (`IndexedOffer.title`): plain text on
 * one line, or `null` when the store sent no text at all.
 *
 * A title is a third party's string that ends up on a page, so nothing of it is trusted beyond
 * its being text: control characters and line breaks become spaces, runs of whitespace collapse,
 * the characters that only steer layout — zero-width ones, direction overrides — are dropped, and
 * what is left is trimmed and cut to `MAX_OFFER_TITLE_LENGTH` characters. The cut is made between
 * code points and a lone surrogate is replaced, so the result is always well-formed text. It is
 * never interpreted as markup here or anywhere: a page prints it as text.
 */
export function storeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .toWellFormed()
    .replace(INVISIBLE, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  const title = Array.from(text).slice(0, MAX_OFFER_TITLE_LENGTH).join('').trim()
  return title === '' ? null : title
}

/**
 * The whole percent a price is below its regular price, as both stores' own labels round it — and
 * never a number that says something the two amounts do not:
 *
 * - 0 when the price is the regular price, or there is no regular price to be below;
 * - 100 only when the price is zero: a game given away for a while;
 * - between 1 and 99 for everything in between, however the division rounds. One cent off two
 *   dollars is not "−100 %", and a price a cent under a thousand is still a discount of 1 %, or a
 *   page would strike the regular price through beside no discount at all.
 */
export function discountPercentOf(amount: number, regularAmount: number): number {
  if (regularAmount <= 0 || amount >= regularAmount) return 0
  if (amount <= 0) return 100
  return Math.min(99, Math.max(1, Math.round((1 - amount / regularAmount) * 100)))
}

/** The longest a store's or an upstream's own words are quoted in a log line or the summary. */
const MAX_REASON_LENGTH = 200

/**
 * Why a read failed, as it may be written to the job's log: on one line, and no longer than a
 * line. The log is standard output on a GitHub runner, where a line that begins with `::` is a
 * command to the runner; a reason is somebody else's text as often as it is this job's, so every
 * control character and line break in it becomes a space before it is printed anywhere.
 */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()
  return Array.from(line).slice(0, MAX_REASON_LENGTH).join('')
}
