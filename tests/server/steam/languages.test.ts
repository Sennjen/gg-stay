import { describe, expect, it } from 'vitest'
import { parseUkrainianSupport } from '../../../server/steam/languages'
import languageFixtures from '../../fixtures/steam/languages.json'

const fixtures = languageFixtures as Record<string, string>

describe('parseUkrainianSupport', () => {
  it.each([
    ['textOnly', { text: true, audio: false }, 'Ukrainian text, no audio marker'],
    ['withAudio', { text: true, audio: true }, 'Ukrainian with a full-audio asterisk'],
    ['none', { text: false, audio: false }, 'no Ukrainian in the list'],
    [
      'englishResponseUkrainian',
      { text: true, audio: false },
      'response in English, name "Ukrainian"',
    ],
    [
      'russianResponseUkrainian',
      { text: true, audio: false },
      'response in Russian, name "Украинский"',
    ],
    [
      'legendPresentNoUkrainian',
      { text: false, audio: false },
      'legend line present, no Ukrainian',
    ],
    [
      'audioOnAnotherLanguageNotUkrainian',
      { text: true, audio: false },
      "another language's asterisk must not be attributed to Ukrainian",
    ],
    [
      'substringNotUkrainian',
      { text: false, audio: false },
      'must not match "Ukrainian" inside a longer word',
    ],
    [
      'nbspPaddedUkrainian',
      { text: true, audio: true },
      '&nbsp; padding around the name and before the asterisk marker is trimmed',
    ],
  ])('%s -> %j (%s)', (key, expected) => {
    expect(parseUkrainianSupport(fixtures[key])).toEqual(expected)
  })

  it('returns { text: false, audio: false } for empty, null or undefined input', () => {
    expect(parseUkrainianSupport('')).toEqual({ text: false, audio: false })
    expect(parseUkrainianSupport(null)).toEqual({ text: false, audio: false })
    expect(parseUkrainianSupport(undefined)).toEqual({ text: false, audio: false })
  })

  it('accepts an optional isFree flag without changing parsing', () => {
    expect(parseUkrainianSupport(fixtures.textOnly, true)).toEqual({ text: true, audio: false })
    expect(parseUkrainianSupport(fixtures.textOnly, false)).toEqual({ text: true, audio: false })
  })

  it('is case-insensitive on the language name', () => {
    expect(parseUkrainianSupport('english, УКРАЇНСЬКА, russian')).toEqual({
      text: true,
      audio: false,
    })
    expect(parseUkrainianSupport('english, ukrainian, russian')).toEqual({
      text: true,
      audio: false,
    })
  })

  it('trims whitespace around each language name', () => {
    expect(parseUkrainianSupport('  English ,  Українська  ,  Russian  ')).toEqual({
      text: true,
      audio: false,
    })
  })

  it('runs in linear time on a long, pathological input (no catastrophic backtracking)', () => {
    const long =
      Array.from({ length: 5_000 }, () => 'English').join(', ') + ', Українська<strong>*</strong>'
    const start = performance.now()
    expect(parseUkrainianSupport(long)).toEqual({ text: true, audio: true })
    expect(performance.now() - start).toBeLessThan(200)
  })
})
