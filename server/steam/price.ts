export interface SteamPrice {
  priceUah: number
  regularPriceUah: number
  discountPercent: number
  isFree: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Kopecks to whole hryvnia, rounding half up (`134900` -> `1349`, `1250` -> `13`). */
function kopecksToUah(kopecks: number): number {
  return Math.floor((kopecks + 50) / 100)
}

/**
 * Parses one app's `appdetails` entry into a price, whether the entry came from the batched
 * `filters=price_overview` call or the unfiltered per-app call (both share the same shape for the
 * fields read here).
 *
 * - `success: false`, or a missing/malformed `data`, -> `null`.
 * - `data: []` — how a free game and a not-for-sale game both come back under
 *   `filters=price_overview` — is indistinguishable from here, so it is also `null`; the caller
 *   resolves the free case separately from the unfiltered per-app call's `is_free`.
 * - `data.is_free === true` -> a zeroed, free price, regardless of `price_overview`.
 * - A missing or malformed `price_overview`, or a currency other than `UAH`, -> `null`. Currency
 *   is never converted.
 */
export function parseSteamPrice(entry: unknown): SteamPrice | null {
  const record = asRecord(entry)
  if (!record) return null
  if (record.success === false) return null

  const rawData = record.data
  if (Array.isArray(rawData)) return null
  const data = asRecord(rawData)
  if (!data) return null

  if (data.is_free === true) {
    return { priceUah: 0, regularPriceUah: 0, discountPercent: 0, isFree: true }
  }

  const overview = asRecord(data.price_overview)
  if (!overview) return null

  const currency = asString(overview.currency)
  if (currency !== 'UAH') return null

  const initial = asNumber(overview.initial)
  const final = asNumber(overview.final)
  const discountPercent = asNumber(overview.discount_percent)
  if (initial === undefined || final === undefined || discountPercent === undefined) return null

  return {
    priceUah: kopecksToUah(final),
    regularPriceUah: kopecksToUah(initial),
    discountPercent,
    isFree: false,
  }
}

/**
 * What one app's `appdetails` entry says about its price, for a reader that has to tell "Steam has
 * no price for this app" from "this is not an answer" — which `parseSteamPrice` deliberately does
 * not: both are `null` there.
 *
 * - `price`: Steam gave one, exactly when `parseSteamPrice` does.
 * - `none`: Steam answered for this app, and the answer is that it has no price to show. That is
 *   `success: false` — an app Steam will not describe to this region: delisted, regionless, or
 *   unknown to it — and `success: true` over data that carries no price: the empty list it sends
 *   under `filters=price_overview` for a free game and for one that is not for sale, or an object
 *   without a `price_overview`.
 * - `unreadable`: anything else. No entry at all, an entry that is not an object, one that says
 *   neither `success: true` nor `success: false`, a `success: true` whose data is neither a list
 *   nor an object, and a `price_overview` that is there but is not a hryvnia price this app can
 *   read. Steam said something, or nothing, and none of it is "this app has no price".
 *
 * The line between the last two is drawn on the cautious side on purpose. What a caller does with
 * `none` is remember it; what it does with `unreadable` is ask again.
 */
export type SteamPriceReading =
  { kind: 'price'; price: SteamPrice } | { kind: 'none' } | { kind: 'unreadable' }

export function readSteamPrice(entry: unknown): SteamPriceReading {
  const price = parseSteamPrice(entry)
  if (price) return { kind: 'price', price }

  const record = asRecord(entry)
  if (!record) return { kind: 'unreadable' }
  if (record.success === false) return { kind: 'none' }
  if (record.success !== true) return { kind: 'unreadable' }

  if (Array.isArray(record.data)) return { kind: 'none' }
  const data = asRecord(record.data)
  if (!data) return { kind: 'unreadable' }
  return data.price_overview === undefined ? { kind: 'none' } : { kind: 'unreadable' }
}
