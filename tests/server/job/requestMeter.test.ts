import { describe, expect, it } from 'vitest'
import { createRequestMeter, REQUEST_LIMIT_MESSAGE } from '../../../scripts/index/requestMeter'

/**
 * The count of what a transport sends, and the limit a run sets on it. It is the whole of what
 * stands between a run and a quota it was not given, so the edges are pinned one by one.
 */
describe('createRequestMeter', () => {
  it('counts every request it is asked about, and has no limit until one is set', () => {
    const meter = createRequestMeter()
    expect(meter.issued()).toBe(0)
    expect(meter.limited()).toBe(false)
    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY)

    for (let request = 0; request < 250; request += 1) meter.take()

    expect(meter.issued()).toBe(250)
    expect(meter.refused()).toBe(0)
    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY)
  })

  it('lets through exactly as many requests as the limit, and refuses the next before it is counted', () => {
    const meter = createRequestMeter()
    meter.limitTo(3)
    expect(meter.limited()).toBe(true)
    expect(meter.remaining()).toBe(3)

    meter.take()
    meter.take()
    expect(meter.remaining()).toBe(1)
    meter.take()

    expect(meter.remaining()).toBe(0)
    expect(() => meter.take()).toThrow(REQUEST_LIMIT_MESSAGE)
    expect(() => meter.take()).toThrow(REQUEST_LIMIT_MESSAGE)
    // A refused request was not sent, so it is not among the sent ones.
    expect(meter.issued()).toBe(3)
    expect(meter.refused()).toBe(2)
    expect(meter.remaining()).toBe(0)
  })

  it('counts a limit from where it is set, not from the first request', () => {
    const meter = createRequestMeter()
    meter.take()
    meter.take()

    meter.limitTo(2)
    meter.take()
    meter.take()

    expect(() => meter.take()).toThrow()
    expect(meter.issued()).toBe(4)
  })

  it('lets nothing through under a limit of none', () => {
    const meter = createRequestMeter()
    meter.limitTo(0)

    expect(meter.remaining()).toBe(0)
    expect(() => meter.take()).toThrow()
    expect(meter.issued()).toBe(0)
  })

  it('can be tightened and never loosened', () => {
    const meter = createRequestMeter()
    meter.limitTo(5)
    meter.take()

    // Four are left. A second limit that would allow more changes nothing.
    meter.limitTo(100)
    expect(meter.remaining()).toBe(4)
    meter.limitTo(4)
    expect(meter.remaining()).toBe(4)
    // One that allows fewer is the limit from then on.
    meter.limitTo(1)
    expect(meter.remaining()).toBe(1)
    meter.take()
    expect(() => meter.take()).toThrow()
    expect(meter.issued()).toBe(2)
  })

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])(
    'refuses a limit of %s and leaves the one it had',
    (requests) => {
      const meter = createRequestMeter()
      meter.limitTo(2)

      expect(() => meter.limitTo(requests)).toThrow(/whole number of requests/)

      expect(meter.remaining()).toBe(2)
    },
  )
})
