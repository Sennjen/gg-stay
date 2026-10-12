import { describe, expect, it } from 'vitest'
import { discountPercentOf, reasonOf, storeTitle } from '../../../scripts/index/storeUpstream'
import { MAX_OFFER_TITLE_LENGTH } from '../../../server/index/document'

/**
 * What the readers of GOG and of the Microsoft Store share: how a store's own title becomes the
 * plain text an offer carries, how a discount is counted from two amounts, and how somebody
 * else's words become a line of the job's log.
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

  it('is no longer than a line', () => {
    expect(reasonOf(new Error('x'.repeat(5_000)))).toHaveLength(200)
  })
})
