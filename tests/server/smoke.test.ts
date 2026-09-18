import { describe, expect, it } from 'vitest'

describe('unit project', () => {
  it('runs in node', () => {
    expect(typeof process.versions.node).toBe('string')
  })
})
