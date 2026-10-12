import { describe, expect, it } from 'vitest'
import { discountPercentOf, reasonOf, storeTitle } from '../../../scripts/index/storeUpstream'
import { MAX_OFFER_TITLE_LENGTH } from '../../../server/index/document'

/**
 * What the readers of GOG and of the Microsoft Store share: how a store's own title becomes the
 * plain text an offer carries, how a discount is counted from two amounts, and how somebody
 * else's words become a line of the job's log.
 *
 * Every invisible character below is written as an escape, never as itself: a test about text
 * nobody can see must at least be readable.
 */

describe('storeTitle', () => {
  it('passes a title on as the store wrote it', () => {
    expect(storeTitle('Hollow Knight: Voidheart Edition')).toBe('Hollow Knight: Voidheart Edition')
    expect(storeTitle('DARK SOULS\u2122 III')).toBe('DARK SOULS\u2122 III')
    expect(storeTitle('#DRIVE Rally')).toBe('#DRIVE Rally')
    expect(storeTitle('2048')).toBe('2048')
    expect(storeTitle('黎明为歌 - Melody before the Dawn')).toBe(
      '黎明为歌 - Melody before the Dawn',
    )
    // Ukrainian, as Microsoft answers where a publisher wrote the listing in it.
    expect(storeTitle('Відьмак 3: Дикий Гін')).toBe('Відьмак 3: Дикий Гін')
  })

  it('trims it and puts it on one line', () => {
    expect(storeTitle('  LIMBO  ')).toBe('LIMBO')
    expect(storeTitle('The Witcher 3:\n\tWild   Hunt\r\n')).toBe('The Witcher 3: Wild Hunt')
    expect(storeTitle('Halo\u0000Infinite\u0007')).toBe('Halo Infinite')
    // A no-break space and an ideographic one are spaces like any other.
    expect(storeTitle('Halo\u00A0Infinite')).toBe('Halo Infinite')
    expect(storeTitle('Halo\u3000Infinite')).toBe('Halo Infinite')
    expect(storeTitle('Halo\u2028Infinite')).toBe('Halo Infinite')
  })

  it('drops the characters that only steer how text is laid out', () => {
    // A right-to-left override would print the rest of the line backwards.
    expect(storeTitle('Limbo\u202E dnuof toN')).toBe('Limbo dnuof toN')
    expect(storeTitle('\uFEFFLim\u200Bbo\u200F')).toBe('Limbo')
    expect(storeTitle('\u2066Limbo\u2069')).toBe('Limbo')
  })

  it.each([
    ['an Arabic letter mark', '\u061C'],
    ['a soft hyphen', '\u00AD'],
    ['a Mongolian vowel separator', '\u180E'],
    ['a zero-width joiner', '\u200D'],
    ['a language tag', '\u{E0001}'],
    ['a tag letter', '\u{E0041}'],
    ['an interlinear annotation anchor', '\uFFF9'],
  ])('drops every format character, %s included', (_what, character) => {
    expect(storeTitle(`Lim${character}bo`)).toBe('Limbo')
    expect(storeTitle(`${character}Limbo${character}`)).toBe('Limbo')
  })

  it.each([
    ['U+3164, the Hangul filler', '\u3164'],
    ['U+115F, the Hangul choseong filler', '\u115F'],
    ['U+1160, the Hangul jungseong filler', '\u1160'],
    ['U+FFA0, the halfwidth Hangul filler', '\uFFA0'],
  ])('drops %s, which Unicode calls a letter and nobody can see', (_what, filler) => {
    // The trap: each is a letter by its category, so a rule about letters alone would keep it.
    expect(/\p{L}/u.test(filler)).toBe(true)
    expect(storeTitle(filler.repeat(5))).toBeNull()
    expect(storeTitle(`Lim${filler}bo`)).toBe('Limbo')
  })

  it('reads no title from text with no letter and no digit in it', () => {
    for (const blank of [
      '!!!',
      '\u2122',
      '- \u2014 -',
      '***',
      '\u2800\u2800',
      '\u{1F3AE}',
      '(\u00AE)',
    ]) {
      expect(storeTitle(blank)).toBeNull()
    }
    // One letter, or one digit, in any script, is enough.
    expect(storeTitle('!!! 7 !!!')).toBe('!!! 7 !!!')
    expect(storeTitle('\u{1F3AE} Q')).toBe('\u{1F3AE} Q')
    expect(storeTitle('\u0416')).toBe('\u0416')
    expect(storeTitle('\u4E09')).toBe('\u4E09')
  })

  it('leaves markup as the text it is: a page prints a title, it does not render one', () => {
    expect(storeTitle('<b>Limbo</b> & <3')).toBe('<b>Limbo</b> & <3')
    expect(storeTitle('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })

  it('cuts a title at two hundred characters, between characters', () => {
    expect(MAX_OFFER_TITLE_LENGTH).toBe(200)
    expect(storeTitle('x'.repeat(200))).toHaveLength(200)
    expect(storeTitle('x'.repeat(201))).toHaveLength(200)
    // Three hundred letters of two code units each: two hundred are kept, and none cut in half.
    const scriptX = '\u{1D4B3}'
    expect(scriptX).toHaveLength(2)
    const long = storeTitle(scriptX.repeat(300))!
    expect(Array.from(long)).toHaveLength(200)
    expect(long.isWellFormed()).toBe(true)
    // What the cut leaves at the end is trimmed again.
    expect(storeTitle(`${'x'.repeat(199)} y`)).toBe('x'.repeat(199))
  })

  it('makes well-formed text of a title that is not', () => {
    const title = storeTitle('Limbo \uD83C')!
    expect(title.isWellFormed()).toBe(true)
    expect(title.startsWith('Limbo')).toBe(true)
  })

  it.each([
    undefined,
    null,
    '',
    '   ',
    '\n\t',
    '\u200B\uFEFF',
    42,
    true,
    ['Limbo'],
    { title: 'Limbo' },
  ])('reads no title from %j', (value) => {
    expect(storeTitle(value)).toBeNull()
  })
})

describe('discountPercentOf', () => {
  it('is the whole percent a price is below its regular price', () => {
    expect(discountPercentOf(1749, 3499)).toBe(50)
    expect(discountPercentOf(50_820, 154_000)).toBe(67)
    expect(discountPercentOf(599, 999)).toBe(40)
  })

  it('is zero when there is nothing to be below', () => {
    expect(discountPercentOf(999, 999)).toBe(0)
    expect(discountPercentOf(999, 499)).toBe(0)
    expect(discountPercentOf(0, 0)).toBe(0)
    expect(discountPercentOf(999, 0)).toBe(0)
  })

  it('is a hundred only for a price of nothing', () => {
    expect(discountPercentOf(0, 999)).toBe(100)
    // One cent is not free, whatever the division rounds to.
    expect(discountPercentOf(1, 200)).toBe(99)
    expect(discountPercentOf(5, 1000)).toBe(99)
    expect(discountPercentOf(1, 1_000_000)).toBe(99)
  })

  it('is at least one for any price below the regular one', () => {
    // A cent under a thousand rounds to nothing, and is still a discount.
    expect(discountPercentOf(999, 1000)).toBe(1)
    expect(discountPercentOf(153_999, 154_000)).toBe(1)
    expect(discountPercentOf(996, 1000)).toBe(1)
  })
})

describe('reasonOf', () => {
  it('is an error’s message, or the thing itself as text', () => {
    expect(reasonOf(new Error('GOG upstream failure: TIMEOUT'))).toBe(
      'GOG upstream failure: TIMEOUT',
    )
    expect(reasonOf('no answer')).toBe('no answer')
    expect(reasonOf(503)).toBe('503')
  })

  it('is one line, so nothing in it can begin a line of the runner’s log', () => {
    // On a GitHub runner a line of standard output beginning with `::` is a command.
    const reason = reasonOf(new Error('the catalog repeated x\n::add-mask::secret\r\n::error::y'))

    expect(reason).toBe('the catalog repeated x ::add-mask::secret ::error::y')
    expect(reason).not.toMatch(/[\r\n]/)
    expect(reasonOf('a\u2028b\u2029c\u0085d\u0000e\tf')).toBe('a b c d e f')
  })

  it('cannot begin a command in the runner’s older form either', () => {
    // `##[name]` is read as a command wherever it stands in a line, not only at its start, so a
    // space is put between the two signs and the bracket: the text is all there and no command.
    expect(reasonOf('##[stop-commands]x')).toBe('## [stop-commands]x')
    expect(reasonOf(new Error('GOG said ##[error]x'))).toBe('GOG said ## [error]x')
    for (const text of [
      '###[error]x',
      '##[##[warning]y',
      '#\n#[error]x ##\t[group]z ##[',
      '####[[',
    ]) {
      expect(reasonOf(text), text).not.toContain('##[')
    }
    // Nothing else of a number sign or a bracket is touched.
    expect(reasonOf('#1 [beta] ## two')).toBe('#1 [beta] ## two')
  })

  it('is no longer than a line', () => {
    expect(reasonOf(new Error('x'.repeat(5_000)))).toHaveLength(200)
  })
})
