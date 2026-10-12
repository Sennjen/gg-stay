import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

/**
 * Every message of a locale file as it is written, under its key path. Read from disk: the i18n
 * module compiles an imported locale file, and a compiled message is not the string it was.
 */
function messagesOf(locale: 'uk' | 'en'): [key: string, text: string][] {
  const path = resolve(process.cwd(), `i18n/locales/${locale}.json`)
  const collect = (value: unknown, prefix: string): [string, string][] =>
    typeof value === 'string'
      ? [[prefix, value]]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          collect(child, prefix ? `${prefix}.${key}` : key),
        )
  return collect(JSON.parse(readFileSync(path, 'utf-8')), '')
}

/**
 * The messages that carried an em dash when the rule against one was made, here and on the main
 * branch. They are reworded in a change of their own; a key leaves this list when its dash goes,
 * and the list goes when it is empty.
 */
const WRITTEN_BEFORE_THE_RULE = [
  'home.title',
  'home.shareImageAlt',
  'gege.greeter.pitch',
  'catalog.indexedOnlyNote',
  'catalog.descriptionFiltered',
  'game.metaFallback',
  'gallery.thumbnailAlt',
  'why.lead',
  'why.cards.language.description',
  'why.cards.filters.description',
  'why.cards.stores.description',
  'why.cards.ukrainianGames.description',
  'why.cards.gege.description',
  'ask.titleQuery',
  'ask.description',
  'ask.fallbackNote',
  'ask.emptyHint',
  'ask.emptyHintNoFilter',
]

describe('locale files', () => {
  it('have exactly the same set of nested keys', () => {
    expect(collectKeys(uk).sort()).toEqual(collectKeys(en).sort())
  })

  // The site's own copy is written without the em dash: a sentence that wants one is reworded,
  // not re-punctuated with a hyphen. An en dash in a range is another sign and is left alone.
  it.each(['uk', 'en'] as const)('carry no new em dash: %s', (locale) => {
    const withOne = messagesOf(locale)
      .filter(([key, text]) => text.includes('—') && !WRITTEN_BEFORE_THE_RULE.includes(key))
      .map(([key]) => key)
    expect(withOne).toEqual([])
  })
})
