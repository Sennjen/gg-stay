import { describe, expect, it } from 'vitest'
import { createDailyCeiling, createRateLimiter, dailyCallLimit } from '../../../server/ask/limits'

function clock(start = Date.parse('2026-10-02T10:00:00.000Z')) {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

describe('the per-IP token bucket', () => {
  it('lets ten requests through in a burst and refuses the eleventh', () => {
    const time = clock()
    const limiter = createRateLimiter({ now: time.now })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.take('203.0.113.7')).toEqual({ ok: true })
    }
    expect(limiter.take('203.0.113.7')).toEqual({ ok: false, retryAfterSeconds: 6 })
  })

  it('refills one request every six seconds', () => {
    const time = clock()
    const limiter = createRateLimiter({ now: time.now })
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.take('a')
    time.advance(5_000)
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 })
    time.advance(1_000)
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a').ok).toBe(false)
    time.advance(60_000)
    for (let attempt = 0; attempt < 10; attempt += 1) expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
  })

  it('keeps every address in its own bucket', () => {
    const limiter = createRateLimiter({ now: clock().now })
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.take('a')
    expect(limiter.take('a').ok).toBe(false)
    expect(limiter.take('b').ok).toBe(true)
  })

  it('forgets the least recently seen address past its size, so it cannot grow without bound', () => {
    const limiter = createRateLimiter({ now: clock().now, maxKeys: 2 })
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.take('a')
    limiter.take('b')
    limiter.take('c')
    expect(limiter.size()).toBe(2)
    // `a` was evicted with its empty bucket; it starts again with a full one.
    expect(limiter.take('a').ok).toBe(true)
  })
})

describe('the daily ceiling of model calls', () => {
  it('reserves calls until the ceiling and refuses a reservation it cannot cover', () => {
    const ceiling = createDailyCeiling({ limit: 5, now: clock().now })
    expect(ceiling.reserve(2)).toBe(true)
    expect(ceiling.reserve(2)).toBe(true)
    expect(ceiling.reserve(2)).toBe(false)
    expect(ceiling.remaining()).toBe(1)
  })

  it('gives back the calls a request reserved and did not make', () => {
    const ceiling = createDailyCeiling({ limit: 2, now: clock().now })
    expect(ceiling.reserve(2)).toBe(true)
    ceiling.refund(1)
    expect(ceiling.remaining()).toBe(1)
    ceiling.refund(5)
    expect(ceiling.remaining()).toBe(2)
  })

  it('starts again at midnight UTC', () => {
    const time = clock(Date.parse('2026-10-02T23:59:00.000Z'))
    const ceiling = createDailyCeiling({ limit: 2, now: time.now })
    expect(ceiling.reserve(2)).toBe(true)
    expect(ceiling.reserve(1)).toBe(false)
    time.advance(60_000)
    expect(ceiling.reserve(2)).toBe(true)
  })

  it('treats a ceiling of zero as "no model calls at all"', () => {
    const ceiling = createDailyCeiling({ limit: 0, now: clock().now })
    expect(ceiling.reserve(1)).toBe(false)
  })
})

describe('the configured ceiling', () => {
  it.each([
    ['', 500],
    [undefined, 500],
    ['250', 250],
    [250, 250],
    [0, 0],
    ['0', 0],
    ['-5', 500],
    ['lots', 500],
    [12.7, 12],
  ])('reads %j as %i', (raw, expected) => {
    expect(dailyCallLimit(raw)).toBe(expected)
  })
})
