import { oneLine } from './deps'
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

/**
 * Characters a reader cannot see and a title has no use for. Every format character (`\p{Cf}`):
 * the zero-width ones, the direction marks and overrides, the soft hyphen, the tag characters. And
 * the four Hangul fillers, named because Unicode files them under letters (`Lo`), so no rule about
 * categories catches them: a "title" made of U+3164 alone would otherwise pass for one.
 */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu

/** What makes text a title: at least one letter or one digit, in any script. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * What a store calls a product, as an offer may carry it (`IndexedOffer.title`): plain text on
 * one line, or `null` when the store sent nothing that reads as a title.
 *
 * A title is a third party's string that ends up on a page, so nothing of it is trusted beyond
 * its being text. In this order: a lone surrogate is replaced, so the result is always
 * well-formed; the invisible characters are dropped (`INVISIBLE`); control characters, line
 * breaks and any run of whitespace become one space; the ends are trimmed; and what is left is cut
 * to `MAX_OFFER_TITLE_LENGTH` characters, between code points, and trimmed again. A result with
 * no letter and no digit in it — empty, or punctuation and symbols alone — is no title.
 *
 * That is all it does. Markup is not removed, because it is never interpreted: `<b>` is three
 * characters of text here, and stays harmless for exactly as long as a page prints a title as
 * text and never as HTML.
 */
export function storeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value
    .toWellFormed()
    .replace(INVISIBLE, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  const title = Array.from(text).slice(0, MAX_OFFER_TITLE_LENGTH).join('').trim()
  return LETTER_OR_DIGIT.test(title) ? title : null
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

/**
 * Why a read failed, as it may be written to the job's log: an error's message, or the thing
 * itself as text, on one line and no longer than a line (`oneLine`) — a reason is somebody
 * else's text as often as it is this job's.
 */
export function reasonOf(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : error)
}
