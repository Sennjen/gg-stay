/** JSON.stringify with sorted object keys, so equal values always produce equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const source = inner as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .map((key) => [key, source[key]]),
      )
    }
    return inner
  })
}
