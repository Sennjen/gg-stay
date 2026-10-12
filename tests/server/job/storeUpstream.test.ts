import { describe, expect, it } from 'vitest'
import { discountPercentOf, storeTitle } from '../../../scripts/index/storeUpstream'
import { MAX_OFFER_TITLE_LENGTH } from '../../../server/index/document'

/**
 * What the readers of GOG and of the Microsoft Store share: how a store's own title becomes the
 * plain text an offer carries, and how a discount is counted from two amounts.
 */

describe('storeTitle', () => {
  it('passes a title on as the store wrote it', () => {
    expect(storeTitle('Hollow Knight: Voidheart Edition')).toBe('Hollow Knight: Voidheart Edition')
    expect(storeTitle('DARK SOULS™ III')).toBe('DARK SOULS™ III')
    expect(storeTitle('#DRIVE Rally')).toBe('#DRIVE Rally')
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
    expect(storeTitle('Halo Infinite')).toBe('Halo Infinite')
  })

  it('drops the characters that only steer how text is laid out', () => {
    // A right-to-left override would print the rest of the line backwards.
    expect(storeTitle('Limbo‮ dnuof toN')).toBe('Limbo dnuof toN')
    expect(storeTitle('﻿Lim​bo‏')).toBe('Limbo')
    expect(storeTitle('⁦Limbo⁩')).toBe('Limbo')
  })

  it('leaves markup as the text it is: a page prints a title, it does not render one', () => {
    expect(storeTitle('<b>Limbo</b> & <3')).toBe('<b>Limbo</b> & <3')
  })

  it('cuts a title at two hundred characters, between characters', () => {
    expect(MAX_OFFER_TITLE_LENGTH).toBe(200)
    expect(storeTitle('x'.repeat(200))).toHaveLength(200)
    expect(storeTitle('x'.repeat(201))).toHaveLength(200)
    // Two hundred characters, each of them two code units: none is cut in half.
    const long = storeTitle('🎮'.repeat(300))!
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

  it.each([undefined, null, '', '   ', '\n\t', '​﻿', 42, true, ['Limbo'], { title: 'Limbo' }])(
    'reads no title from %j',
    (value) => {
      expect(storeTitle(value)).toBeNull()
    },
  )
})

describe('discountPercentOf', () => {
  it('is the whole percent a price is below its regular price', () => {
    expect(discountPercentOf(1749, 3499)).toBe(50)
    expect(discountPercentOf(50_820, 154_000)).toBe(67)
    expect(discountPercentOf(0, 999)).toBe(100)
  })

  it('is zero when there is nothing to be below', () => {
    expect(discountPercentOf(999, 999)).toBe(0)
    expect(discountPercentOf(999, 499)).toBe(0)
    expect(discountPercentOf(0, 0)).toBe(0)
  })
})
