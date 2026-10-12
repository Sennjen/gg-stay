import {
  asRecord,
  NO_CACHE,
  STORE_MAX_ATTEMPTS,
  STORE_MIN_INTERVAL_MS,
  type StoreUpstreamRuntime,
} from './storeUpstream'
import { createUpstreamFetch } from '../../server/upstream/createUpstreamFetch'

/**
 * The National Bank of Ukraine's official hryvnia rate of the US dollar, which is what a GOG
 * price is estimated in hryvnia with. It is an estimate's basis and nothing more: a visitor's
 * bank charges its own rate, the page says so, and no amount made with this one is ever stored.
 *
 * **The bank is asked for a day, and has to answer for that day.** Asked without a date, the
 * endpoint answers the newest rate the bank has set — which every afternoon is tomorrow's — so
 * the day a rate is "of" would depend on the hour of the run. Asked with `date=YYYYMMDD` it
 * answers the rate in force that day and repeats the day back, weekends and holidays included:
 * there is no day it answers nothing for. The job asks for the day it runs on, by the calendar
 * the bank keeps — Kyiv's — and takes the answer only when it names that very day.
 *
 * Established on 2026-10-12: `docs/specs/2026-10-12-other-store-prices-design.md`, "Verified".
 */

const EXCHANGE_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange'

/** The answer is a hundred bytes; the timeout is the one RAWG and Steam are given. */
const TIMEOUT_MS = 5_000

/** The ISO 4217 codes of the US dollar, both of which the bank states. */
const USD = 'USD'
const USD_NUMERIC = 840

/**
 * A rate outside this is not a rate of the dollar in hryvnia, whatever else it is — a rate quoted
 * for a hundred units, a percentage, a zero. The bounds are far from any rate there has been and
 * are not a forecast: they only keep an absurd number from being multiplied into a price.
 */
const MIN_PLAUSIBLE_RATE = 1
const MAX_PLAUSIBLE_RATE = 1_000

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The bank's answer about one day (`YYYY-MM-DD`), as it gave it. */
export type BankRateFetch = (date: string) => Promise<unknown>

/**
 * The bank's share of the shared transport. The answer is a JSON array, which the transport hands
 * over and keeps nowhere — and nothing here would be kept anyway. In fixture mode it is the one
 * recorded answer (`tests/fixtures/nbu/exchange.json`), whatever day was asked for.
 */
export function createBankRateFetch(runtime: StoreUpstreamRuntime): BankRateFetch {
  const fetchRate = createUpstreamFetch<{ date: string }>(
    {
      source: 'NBU',
      minIntervalMs: STORE_MIN_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
      maxAttempts: STORE_MAX_ATTEMPTS,
      buildUrl: ({ date }) =>
        `${EXCHANGE_URL}?valcode=${USD}&date=${date.replaceAll('-', '')}&json`,
      cacheKey: ({ date }) => `exchange/${date}`,
      fixtureName: () => 'exchange',
      ttlFor: () => 0,
    },
    { ...runtime, cache: NO_CACHE },
  )
  return (date) => fetchRate({ date })
}

/** The calendar day in Kyiv at an instant, as `YYYY-MM-DD`: the day the bank's rate is for. */
export function kyivDate(now: number): string {
  // `en-CA` writes a date as ISO does; the time zone does the rest, summer time included.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

/** `2026-10-12` as the bank writes a day, `12.10.2026`; `null` for anything that is not a day. */
function bankDay(date: string): string | null {
  const match = DAY.exec(date)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : null
}

/**
 * The hryvnia rate of one US dollar for `date`, or `null` when the answer does not say exactly
 * that: an array holding one entry for the dollar — by both of its codes — dated the day that was
 * asked for, with a rate that is a number and plausibly this rate. An empty array, an entry for
 * another day or another currency, two entries, a rate sent as a string: all of them `null`. The
 * caller then keeps the rate it had, which is always better than a number nobody can vouch for.
 */
export function parseUsdRate(body: unknown, date: string): number | null {
  const day = bankDay(date)
  if (day === null || !Array.isArray(body) || body.length !== 1) return null
  const entry = asRecord(body[0])
  if (!entry || entry.cc !== USD || entry.r030 !== USD_NUMERIC) return null
  if (entry.exchangedate !== day) return null
  const rate = entry.rate
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null
  return rate >= MIN_PLAUSIBLE_RATE && rate <= MAX_PLAUSIBLE_RATE ? rate : null
}
