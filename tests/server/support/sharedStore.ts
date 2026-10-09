import type { SharedStore } from '../../../server/upstream/layeredCache'

/**
 * A shared store that is a map: what the upstream caches are given on Vercel is the platform's
 * Runtime Cache, and this stands in for it in every suite. It keeps what it is handed the way
 * that cache does — as JSON, so nothing that would not survive the round trip survives here — and
 * records every read and write, so a case can say exactly what reached the shared level.
 *
 * Two of these sharing one `entries` map are two instances of the function reading one cache.
 */
export interface FakeSharedStore extends SharedStore {
  /** What is held, under the key it was written with, as the JSON that was stored. */
  readonly entries: Map<string, string>
  /** Every key that was read, in order. */
  readonly reads: string[]
  /** Every write, in order, with the lifetime it asked for. */
  readonly writes: { key: string; value: unknown; ttlSeconds: number }[]
}

export function createFakeSharedStore(entries = new Map<string, string>()): FakeSharedStore {
  const reads: string[] = []
  const writes: FakeSharedStore['writes'] = []
  return {
    entries,
    reads,
    writes,
    get: async (key) => {
      reads.push(key)
      const held = entries.get(key)
      return held === undefined ? null : (JSON.parse(held) as unknown)
    },
    set: async (key, value, ttlSeconds) => {
      const stored = JSON.stringify(value)
      writes.push({ key, value: JSON.parse(stored) as unknown, ttlSeconds })
      entries.set(key, stored)
    },
  }
}
