import { describe, expect, it } from 'vitest'
import {
  htmlToText,
  isLikelyUkrainian,
  resolveLocalizedDescription,
} from '../../../server/steam/description'

describe('htmlToText', () => {
  it('turns <br>, </p>, </li>, </h1..6> into newlines and prefixes <li> with "• "', () => {
    const html =
      '<h2>Heading</h2><p>First paragraph.<br>Second line.</p><ul><li>One</li><li>Two</li></ul>'
    expect(htmlToText(html)).toBe('Heading\nFirst paragraph.\nSecond line.\n• One\n• Two')
  })

  it('strips all remaining tags', () => {
    expect(htmlToText('<div class="x"><strong>Bold</strong> and <em>italic</em></div>')).toBe(
      'Bold and italic',
    )
  })

  it('decodes named and numeric HTML entities', () => {
    expect(htmlToText('Tom &amp; Jerry &mdash; caf&#233; &#x2013; time')).toBe(
      'Tom & Jerry — café – time',
    )
  })

  it('drops <img>, <video>, <script> and <style> content entirely', () => {
    expect(
      htmlToText(
        '<p>Before</p><img src="x.jpg"><video src="x.mp4"></video>' +
          '<script>alert(1)</script><style>.a{color:red}</style><p>After</p>',
      ),
    ).toBe('Before\nAfter')
  })

  it('collapses whitespace', () => {
    expect(htmlToText('<p>Too   many\t\tspaces</p>')).toBe('Too many spaces')
  })

  it('caps at 4000 characters on a paragraph boundary', () => {
    const paragraph = 'A'.repeat(300)
    const html = Array.from({ length: 20 }, () => `<p>${paragraph}</p>`).join('')
    const result = htmlToText(html)
    expect(result.length).toBeLessThanOrEqual(4000)
    // Cut cleanly at a paragraph boundary: every paragraph in the result is the full 300-char
    // one, never a truncated partial paragraph.
    const paragraphs = result.split('\n')
    expect(paragraphs.every((p) => p === paragraph)).toBe(true)
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})

describe('isLikelyUkrainian', () => {
  it('accepts real-looking Ukrainian text', () => {
    const text =
      'Це офіційний опис гри українською мовою. Він містить достатньо кириличних літер і ' +
      'характерні українські букви, наприклад: їжак, коріння, ґанок, єдність.'
    expect(isLikelyUkrainian(text)).toBe(true)
  })

  it('rejects English text', () => {
    const text = 'This is an English description of the game with plenty of Latin letters.'
    expect(isLikelyUkrainian(text)).toBe(false)
  })

  it('rejects Russian-only text (no і/ї/є/ґ)', () => {
    const text =
      'Это описание игры на русском языке без характерных украинских букв совсем и никогда.'
    expect(isLikelyUkrainian(text)).toBe(false)
  })

  it('rejects mixed text with product names in Latin when Cyrillic share is too low', () => {
    const text = 'Steam Deck Epic Games Store GOG Galaxy PlayStation Xbox Nintendo Switch гра'
    expect(isLikelyUkrainian(text)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isLikelyUkrainian('')).toBe(false)
  })
})

describe('resolveLocalizedDescription', () => {
  const rawg = 'An English description from RAWG.'

  it('returns RAWG English text for a non-uk locale', () => {
    expect(
      resolveLocalizedDescription('en', rawg, {
        about_the_game: '<p>Опис їжака ґанку єдність</p>',
      }),
    ).toEqual({ text: rawg, language: 'en', source: 'RAWG' })
  })

  it('returns null for a non-uk locale when RAWG has no description', () => {
    expect(resolveLocalizedDescription('en', null, null)).toBeNull()
  })

  it('builds Ukrainian text from about_the_game when it is non-empty', () => {
    const html =
      '<p>Це офіційний опис гри. Він розповідає про пригоди героя, його їжака та ґанок його ' +
      'дому, а також про єдність команди.</p>'
    expect(resolveLocalizedDescription('uk', rawg, { about_the_game: html })).toEqual({
      text: 'Це офіційний опис гри. Він розповідає про пригоди героя, його їжака та ґанок його дому, а також про єдність команди.',
      language: 'uk',
      source: 'STEAM',
    })
  })

  it('falls back to short_description when about_the_game is empty', () => {
    const uk =
      'Короткий опис українською: їжак, ганок, ґанок, єдність команди у грі, багато кирилиці тут.'
    expect(
      resolveLocalizedDescription('uk', rawg, { about_the_game: '', short_description: uk }),
    ).toEqual({ text: uk, language: 'uk', source: 'STEAM' })
  })

  it('falls back to RAWG English when Steam text is English (silent Steam fallback)', () => {
    const english = 'A charming farming simulator with deep systems and relaxing gameplay loops.'
    expect(resolveLocalizedDescription('uk', rawg, { about_the_game: english })).toEqual({
      text: rawg,
      language: 'en',
      source: 'RAWG',
    })
  })

  it('falls back to RAWG English when there is no Steam link/data at all', () => {
    expect(resolveLocalizedDescription('uk', rawg, null)).toEqual({
      text: rawg,
      language: 'en',
      source: 'RAWG',
    })
  })

  it('returns null when locale is uk, Steam has nothing, and RAWG has no description', () => {
    expect(resolveLocalizedDescription('uk', null, null)).toBeNull()
  })

  it('falls back to RAWG for empty Steam text fields', () => {
    expect(
      resolveLocalizedDescription('uk', rawg, { about_the_game: '', short_description: '' }),
    ).toEqual({ text: rawg, language: 'en', source: 'RAWG' })
  })
})
