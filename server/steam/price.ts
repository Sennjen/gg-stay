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
