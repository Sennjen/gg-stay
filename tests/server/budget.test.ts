import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leaveRunning, observe, outlasts, trackPending, valueOf } from '../../server/graphql/budget'
import type { GraphQLContext } from '../../server/graphql/context'

/**
 * The things every resolver with a time budget does: wait for an answer no longer than it has
 * decided to, leave what it stopped waiting for running without letting it fail loudly, and — when
 * it waits for several things against several budgets — keep track of all of them, so that every
 * way out of it clears the timers and hands over what is still running. The resolvers' own suites
 * show them at work; these pin the helpers themselves.
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

describe('observe', () => {
  it('says pending until the work answers, and then what it answered', async () => {
    const observed = observe(after(100, 'answer'))
    expect(observed.outcome()).toEqual({ status: 'pending' })
    expect(valueOf(observed)).toBeUndefined()

    await vi.advanceTimersByTimeAsync(100)
    expect(observed.outcome()).toEqual({ status: 'fulfilled', value: 'answer' })
    expect(valueOf(observed)).toBe('answer')
    expect(await observed.settled).toEqual({ status: 'fulfilled', value: 'answer' })
  })

  it('says how the work failed, without ever rejecting itself', async () => {
    const failure = new Error('RAWG said no')
    const observed = observe(after(100, failure))
    await vi.advanceTimersByTimeAsync(100)

    expect(observed.outcome()).toEqual({ status: 'rejected', reason: failure })
    expect(valueOf(observed)).toBeUndefined()
    await expect(observed.settled).resolves.toEqual({ status: 'rejected', reason: failure })
  })

  it('handles the failure of work nobody ever waits for', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      observe(after(100, new Error('RAWG went away')))
      await vi.advanceTimersByTimeAsync(100)
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('trackPending', () => {
  it('counts a budget from the moment it is asked for, not from the moment it is awaited', async () => {
    const pending = trackPending(contextWith())
    const budget = pending.budget(1_000)
    let spent = false

    await vi.advanceTimersByTimeAsync(600)
    void budget.then(() => (spent = true))
    await vi.advanceTimersByTimeAsync(399)
    expect(spent).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(spent).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears every budget still counting when it is released', () => {
    const pending = trackPending(contextWith())
    void pending.budget(1_000)
    void pending.budget(2_500)
    expect(vi.getTimerCount()).toBe(2)

    pending.release()
    expect(vi.getTimerCount()).toBe(0)
    expect(pending.released).toBe(true)
  })

  it('hands over what is still running when it is released, and nothing that has finished', async () => {
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
    const pending = trackPending(contextWith(waitUntil))
    const quick = pending.observe(after(100, 'quick'))
    const failed = pending.observe(after(200, new Error('RAWG said no')))
    const slow = pending.observe(after(7_000, 'slow'))
    await vi.advanceTimersByTimeAsync(200)
    expect(pending.released).toBe(false)

    pending.release()
    // The two that had settled, either way, are nobody's to keep alive.
    expect(quick.outcome().status).toBe('fulfilled')
    expect(failed.outcome().status).toBe('rejected')
    expect(waitUntil).toHaveBeenCalledTimes(1)

    let settled = false
    void waitUntil.mock.calls[0]![0].then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(6_799)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    // The request went on to its answer, and whoever still holds it can read that.
    expect(valueOf(slow)).toBe('slow')
  })

  it('never hands over a rejection, and leaves none unhandled, with a hook or without', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
      const withHook = trackPending(contextWith(waitUntil))
      withHook.observe(after(7_000, new Error('RAWG went away')))
      withHook.release()
      const withoutHook = trackPending(contextWith())
      withoutHook.observe(after(7_000, new Error('RAWG went away')))
      withoutHook.release()

      await vi.advanceTimersByTimeAsync(7_000)
      await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does its work once, however often it is released', () => {
    const waitUntil = vi.fn()
    const pending = trackPending(contextWith(waitUntil))
    pending.observe(after(7_000, 'slow'))

    pending.release()
    pending.release()
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('starts no timer once it has been released: a budget asked for then is already spent', async () => {
    const pending = trackPending(contextWith())
    pending.release()

    let spent = false
    void pending.budget(1_000).then(() => (spent = true))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(spent).toBe(true)
  })

  it('hands a request made after the release straight over, since nobody will come back for it', async () => {
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
    const pending = trackPending(contextWith(waitUntil))
    pending.release()
    expect(waitUntil).not.toHaveBeenCalled()

    const late = pending.observe(after(100, new Error('too late to matter')))
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
    expect(late.outcome().status).toBe('rejected')
  })
})
