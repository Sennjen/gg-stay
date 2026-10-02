import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepRunning } from '../../server/utils/keepRunning'

/**
 * `keepRunning` hands work to the platform through `@vercel/functions`, which finds the current
 * request's context under a global symbol the Vercel runtime installs. Installing a stand-in under
 * the same symbol is how a test sees what a deployed function would do, without a deployment.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context')

type WithRequestContext = typeof globalThis & {
  [REQUEST_CONTEXT]?: { get: () => { waitUntil?: (work: Promise<unknown>) => void } }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT)
})

describe('keepRunning', () => {
  it('hands the work to the platform on Vercel', () => {
    const waitUntil = vi.fn()
    ;(globalThis as WithRequestContext)[REQUEST_CONTEXT] = { get: () => ({ waitUntil }) }
    const work = Promise.resolve()
    keepRunning(work)
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(work)
  })

  it('does nothing anywhere else, where the process outlives the work by itself', () => {
    expect(() => keepRunning(Promise.resolve())).not.toThrow()
  })
})
