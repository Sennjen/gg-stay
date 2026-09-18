import { describe, expect, it } from 'vitest'
import { stableStringify } from '~/utils/stableStringify'

describe('stableStringify', () => {
  it('is independent of key order and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(
      stableStringify({ a: { d: [2, 1] }, b: 1 }),
    )
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
})
