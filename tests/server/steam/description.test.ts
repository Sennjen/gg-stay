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

  describe('quote-aware tag scanning (regression: a quoted ">" must not end the tag early)', () => {
    it("reviewer's exact reproduction: an attribute value containing '>' no longer leaks", () => {
      expect(htmlToText('<div title="a>b">Дуже цікава гра')).toBe('Дуже цікава гра')
    })

    it('handles a quoted attribute value containing "<" too', () => {
      expect(htmlToText('<a title="b<c">text</a>')).toBe('text')
    })

    it('handles single-quoted attribute values containing ">"', () => {
      expect(htmlToText("<span data-x='1>2'>kept</span>")).toBe('kept')
    })

    it('drops only the trailing unclosed tag at end of input', () => {
      expect(htmlToText('Before<div class="unterminated')).toBe('Before')
      expect(htmlToText('Before<div class=unterminated')).toBe('Before')
    })

    it('drops <script>/<style>/<video>/<iframe>/<noscript> content case-insensitively, up to the matching close tag or end of input', () => {
      expect(htmlToText('<SCRIPT>evil()</ScRiPt>Safe')).toBe('Safe')
      expect(htmlToText('<style>.a{color:red}</style>Safe')).toBe('Safe')
      expect(htmlToText('<video src="x.mp4"><source src="y.mp4"></video>Safe')).toBe('Safe')
      expect(htmlToText('<iframe src="//evil.example"></iframe>Safe')).toBe('Safe')
      expect(htmlToText('<noscript>Enable JS</noscript>Safe')).toBe('Safe')
      // No closing tag at all: content dropped to end of input.
      expect(htmlToText('Before<script>never closes')).toBe('Before')
      // Self-closing form: no content to skip, tag itself just dropped.
      expect(htmlToText('<script src="x.js"/>After')).toBe('After')
    })

    it('drops HTML comments', () => {
      expect(htmlToText('<!-- secret note --><p>Kept</p>')).toBe('Kept')
      expect(htmlToText('Before<!-- unterminated comment')).toBe('Before')
    })

    it('decodes entities only after tags are stripped, so &lt;script&gt; stays inert text', () => {
      expect(htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>')
    })

    it('keeps a lone "<" that does not start a tag as literal text', () => {
      expect(htmlToText('5 < 6 and <3 love')).toBe('5 < 6 and <3 love')
    })

    it('completes quickly and correctly for a ~1MB hostile string of unclosed quoted tags', () => {
      const hostile = '<a href="x>'.repeat(50_000) // ~550 KB, every quote left dangling.
      const start = performance.now()
      const result = htmlToText(hostile)
      const elapsed = performance.now() - start
      // No literal text ever appears between the tag markers, so nothing survives stripping.
      expect(result).toBe('')
      expect(elapsed).toBeLessThan(2_000)
    })

    it('completes quickly and correctly for 50 000 lone "<" characters', () => {
      const hostile = '<'.repeat(50_000)
      const start = performance.now()
      const result = htmlToText(hostile)
      const elapsed = performance.now() - start
      // Every "<" is literal text (none starts a tag), capped at MAX_LENGTH with no paragraph
      // break to cut on, so the fallback keeps the raw first 4000 characters.
      expect(result).toBe('<'.repeat(4_000))
      expect(elapsed).toBeLessThan(2_000)
    })
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

  it('uses short_description when about_the_game is markup without any text', () => {
    const result = resolveLocalizedDescription('uk', 'English text', {
      about_the_game:
        '<p class="bb_paragraph"><span class="bb_img_ctn"><img class="bb_img" src="https://example.test/a.png"></span></p><br>',
      short_description: 'Ви — Ґеральт із Рівії, найманий мисливець на чудовиськ.',
    })
    expect(result).toEqual({
      text: 'Ви — Ґеральт із Рівії, найманий мисливець на чудовиськ.',
      language: 'uk',
      source: 'STEAM',
    })
  })

  it('uses a Ukrainian short_description when about_the_game is English', () => {
    const result = resolveLocalizedDescription('uk', 'English text', {
      about_the_game: '<p>An open world adventure with a long English description.</p>',
      short_description: 'Пригода у відкритому світі, де кожне рішення має наслідки.',
    })
    expect(result?.source).toBe('STEAM')
    expect(result?.text).toContain('Пригода')
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
