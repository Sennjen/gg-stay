import { describe, expect, it } from 'vitest'
import en from '~~/i18n/locales/en.json'
import uk from '~~/i18n/locales/uk.json'

function collectKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('locale files', () => {
  it('have exactly the same set of nested keys', () => {
    expect(collectKeys(uk).sort()).toEqual(collectKeys(en).sort())
  })
})
