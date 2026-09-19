import type {
  SteamAppDetails,
  SteamAppDetailsResponse,
  SteamMovie,
  SteamPriceOverview,
} from './types'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function projectMovie(raw: unknown): SteamMovie | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const movie: SteamMovie = {}
  const highlight = asBoolean(record.highlight)
  if (highlight !== undefined) movie.highlight = highlight
  if (record.hls_h264 === null) movie.hls_h264 = null
  else {
    const hls = asString(record.hls_h264)
    if (hls !== undefined) movie.hls_h264 = hls
  }
  return movie
}

function projectMovies(raw: unknown): SteamMovie[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const movies = raw.map(projectMovie).filter((movie): movie is SteamMovie => movie !== undefined)
  return movies
}

function projectPriceOverview(raw: unknown): SteamPriceOverview | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const overview: SteamPriceOverview = {}
  const currency = asString(record.currency)
  if (currency !== undefined) overview.currency = currency
  const initial = asNumber(record.initial)
  if (initial !== undefined) overview.initial = initial
  const final = asNumber(record.final)
  if (final !== undefined) overview.final = final
  const discountPercent = asNumber(record.discount_percent)
  if (discountPercent !== undefined) overview.discount_percent = discountPercent
  const initialFormatted = asString(record.initial_formatted)
  if (initialFormatted !== undefined) overview.initial_formatted = initialFormatted
  const finalFormatted = asString(record.final_formatted)
  if (finalFormatted !== undefined) overview.final_formatted = finalFormatted
  return overview
}

function projectData(raw: unknown): SteamAppDetails['data'] {
  const record = asRecord(raw)
  if (!record) return undefined
  const data: NonNullable<SteamAppDetails['data']> = {}

  const movies = projectMovies(record.movies)
  if (movies !== undefined) data.movies = movies

  const shortDescription = asString(record.short_description)
  if (shortDescription !== undefined) data.short_description = shortDescription

  const aboutTheGame = asString(record.about_the_game)
  if (aboutTheGame !== undefined) data.about_the_game = aboutTheGame

  const supportedLanguages = asString(record.supported_languages)
  if (supportedLanguages !== undefined) data.supported_languages = supportedLanguages

  const priceOverview = projectPriceOverview(record.price_overview)
  if (priceOverview !== undefined) data.price_overview = priceOverview

  const isFree = asBoolean(record.is_free)
  if (isFree !== undefined) data.is_free = isFree

  return data
}

function projectEntry(raw: unknown): SteamAppDetails {
  const record = asRecord(raw)
  if (!record) return {}
  const entry: SteamAppDetails = {}

  const success = asBoolean(record.success)
  if (success !== undefined) entry.success = success

  const data = projectData(record.data)
  if (data !== undefined) entry.data = data

  return entry
}

/**
 * Projects a raw Steam `appdetails` response down to only the fields this app reads: the
 * trailer (`data.movies`, trimmed to what `pickTrailer` reads), the two description fields, and
 * the fields the upcoming price/localisation index will read (`supported_languages`,
 * `price_overview`, `is_free`) — included now so the cached shape does not need to change again
 * next week. The full Steam payload runs to tens of KB per game; this keeps what a 24h cache
 * entry actually stores small.
 *
 * Unknown fields are dropped silently. Missing or malformed fields become absent (never thrown):
 * this runs on parsed JSON from a third-party API, so every field's shape is treated as
 * untrusted input.
 */
export function projectAppDetails(raw: unknown): SteamAppDetailsResponse {
  const record = asRecord(raw)
  if (!record) return {}
  const result: SteamAppDetailsResponse = {}
  for (const [appId, entry] of Object.entries(record)) {
    result[appId] = projectEntry(entry)
  }
  return result
}
