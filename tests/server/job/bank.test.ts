import { describe, expect, it } from 'vitest'
import { createBankRateFetch, kyivDate, parseUsdRate } from '../../../scripts/index/bank'
import { bankAnswer } from '../../fixtures/index/jobStores'
import recorded from '../../fixtures/nbu/exchange.json' with { type: 'json' }

/**
 * The National Bank's dollar rate as the job reads it. `tests/fixtures/nbu/exchange.json` is the
 * answer recorded on 12.10.2026 at 17:06 Kyiv time to a request that named no day — and it is
 * dated the 13th: by the afternoon the newest rate the bank has set is tomorrow's. That is why
 * the job names the day it wants, and why the day in an answer is checked.
 */

describe('parseUsdRate', () => {
  it('reads the recorded rate for the day the answer names', () => {
    expect(parseUsdRate(recorded, '2026-10-13')).toBe(44.9567)
  })

  it('reads none from an answer about another day, tomorrow included', () => {
    // The day the recording was made: the answer is the bank's, and not for that day.
    expect(parseUsdRate(recorded, '2026-10-12')).toBeNull()
    expect(parseUsdRate(recorded, '2026-10-14')).toBeNull()
    expect(parseUsdRate(recorded, '2025-10-13')).toBeNull()
  })

  it('reads a weekend’s and a holiday’s rate like any other day’s', () => {
    // What the bank answered for Saturday 10.10.2026 and for 01.01.2026.
    expect(parseUsdRate(bankAnswer('2026-10-10', 44.8526), '2026-10-10')).toBe(44.8526)
    expect(
      parseUsdRate([{ ...bankAnswer('2026-01-01', 42.3532)[0], special: null }], '2026-01-01'),
    ).toBe(42.3532)
  })

  const entry = bankAnswer('2026-10-12')[0]!

  it.each([
    ['nothing', null],
    ['an object, not a list', entry],
    ['an empty list — a day the bank has set no rate for', []],
    ['two entries', [entry, entry]],
    ['a list of something else', ['44.9567']],
    ['text', 'Service Unavailable'],
    ['another currency', [{ ...entry, cc: 'EUR', r030: 978 }]],
    ['the dollar under another numeric code', [{ ...entry, r030: 978 }]],
    ['a currency in lower case', [{ ...entry, cc: 'usd' }]],
    ['a rate that is text', [{ ...entry, rate: '44.9567' }]],
    ['a rate that is missing', [{ ...entry, rate: undefined }]],
    ['a rate of zero', [{ ...entry, rate: 0 }]],
    ['a negative rate', [{ ...entry, rate: -44.9567 }]],
    ['a rate that is not a number', [{ ...entry, rate: Number.NaN }]],
    ['a rate for a hundred dollars, or something as absurd', [{ ...entry, rate: 4495.67 }]],
    ['a rate under one hryvnia', [{ ...entry, rate: 0.449567 }]],
    ['a day written the other way round', [{ ...entry, exchangedate: '2026-10-12' }]],
    ['no day', [{ ...entry, exchangedate: undefined }]],
  ])('reads no rate from %s', (_what, body) => {
    expect(parseUsdRate(body, '2026-10-12')).toBeNull()
  })

  it('reads none for a day that is not a day', () => {
    expect(parseUsdRate(bankAnswer('2026-10-12'), '12.10.2026')).toBeNull()
    expect(parseUsdRate(bankAnswer('2026-10-12'), '')).toBeNull()
  })
})

describe('kyivDate', () => {
  it('is the calendar day in Kyiv, which is ahead of UTC', () => {
    expect(kyivDate(Date.parse('2026-10-12T12:15:00.000Z'))).toBe('2026-10-12')
    // 00:15 UTC is 03:15 in Kyiv in summer: the same day.
    expect(kyivDate(Date.parse('2026-10-12T00:15:00.000Z'))).toBe('2026-10-12')
    // 21:30 UTC is half past midnight in Kyiv in summer: already tomorrow.
    expect(kyivDate(Date.parse('2026-10-12T21:30:00.000Z'))).toBe('2026-10-13')
  })

  it('follows winter time', () => {
    // In winter Kyiv is two hours ahead, not three: 21:30 UTC is still the same evening.
    expect(kyivDate(Date.parse('2026-12-31T21:30:00.000Z'))).toBe('2026-12-31')
    expect(kyivDate(Date.parse('2026-12-31T22:00:00.000Z'))).toBe('2027-01-01')
  })
})

describe('createBankRateFetch', () => {
  function transport(fixtures = false) {
    const urls: string[] = []
    const fetchRate = createBankRateFetch({
      fixtures,
      fetchJson: async (url) => {
        urls.push(url)
        return { status: 200, body: bankAnswer('2026-10-12') }
      },
      readFixture: async (name) => (name === 'exchange' ? recorded : null),
      now: () => 0,
      sleep: async () => {},
      log: () => {},
    })
    return { fetchRate, urls }
  }

  it('asks for the dollar on one named day', async () => {
    const { fetchRate, urls } = transport()

    expect(await fetchRate('2026-10-12')).toEqual(bankAnswer('2026-10-12'))
    expect(urls).toEqual([
      'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&date=20261012&json',
    ])
  })

  it('asks again every time: a rate is never kept by the transport', async () => {
    const { fetchRate, urls } = transport()

    await fetchRate('2026-10-12')
    await fetchRate('2026-10-12')

    expect(urls).toHaveLength(2)
  })

  it('serves the recorded answer in fixture mode, and asks the network nothing', async () => {
    const { fetchRate, urls } = transport(true)

    expect(await fetchRate('2026-10-12')).toBe(recorded)
    expect(urls).toHaveLength(0)
  })
})
