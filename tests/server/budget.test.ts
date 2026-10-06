import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leaveRunning, outlasts } from '../../server/graphql/budget'
import type { GraphQLContext } from '../../server/graphql/context'

/**
 * The two things every resolver with a time budget does: wait for an answer no longer than it has
 * decided to, and leave what it stopped waiting for running without letting it fail loudly. The
 * resolvers' own suites show them at work; these pin the helpers themselves.
 */

/** Only `waitUntil` is read by what is under test here. */
const contextWith = (waitUntil?: GraphQLContext['waitUntil']) => ({ waitUntil }) as GraphQLContext

/** `value` after `ms` on the (fake) clock, or the rejection `value` is when it is an `Error`. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve, reject) =>
    setTimeout(() => (value instanceof Error ? reject(value) : resolve(value)), ms),
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('outlasts', () => {
  it('says no the moment the work is done, and leaves no timer behind', async () => {
    const late = outlasts(after(100, 'answer'), 2_500)
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a failure inside the budget as in time: it is an answer, and the caller’s to see', async () => {
    const work = after(100, new Error('RAWG said no'))
    const late = outlasts(work, 2_500)
    await vi.advanceTimersByTimeAsync(100)
    expect(await late).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await expect(work).rejects.toThrow('RAWG said no')
  })

  it('says yes once the budget is spent, however the work ends afterwards', async () => {
    const late = outlasts(after(7_000, 'answer'), 2_500)
    await vi.advanceTimersByTimeAsync(2_499)
    let answered = false
    void late.then(() => (answered = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(await late).toBe(true)
    // The work's own timer is all that is left; it finishes without changing the verdict.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(4_500)
    expect(await late).toBe(true)
  })
})

describe('leaveRunning', () => {
  it('hands the platform a promise that settles when the work does', async () => {
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
    leaveRunning(contextWith(waitUntil), after(7_000, 'a body for the cache'))

    expect(waitUntil).toHaveBeenCalledTimes(1)
    let settled = false
    void waitUntil.mock.calls[0]![0].then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(6_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('never hands over a rejection, and never lets one go unhandled, with a hook or without', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
      leaveRunning(contextWith(waitUntil), after(7_000, new Error('RAWG went away')))
      leaveRunning(contextWith(), after(7_000, new Error('RAWG went away')))
      await vi.advanceTimersByTimeAsync(7_000)

      await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
      // An unhandled rejection is reported on a later turn of the event loop than the one it
      // happened on, so a real macrotask has to pass before its absence means anything.
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
