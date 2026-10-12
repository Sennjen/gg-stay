import { describe, expect, it } from 'vitest'
import { formatUah } from '~/utils/format'
import { formatForeignPrice, isPriceAmount, namesAnotherProduct } from '~/utils/storeOffers'

const usd = (amount: number) => ({ amount, currency: 'USD' })

describe('formatForeignPrice', () => {
  it('writes dollars the way the store does: the sign, the dollars, a point, two digits of cents', () => {
    expect(formatForeignPrice(usd(8.99))).toBe('$8.99')
    expect(formatForeignPrice(usd(39.99))).toBe('$39.99')
    expect(formatForeignPrice(usd(29.99))).toBe('$29.99')
  })

  it('always writes two digits of cents', () => {
    expect(formatForeignPrice(usd(5))).toBe('$5.00')
    expect(formatForeignPrice(usd(4.7))).toBe('$4.70')
    expect(formatForeignPrice(usd(0.05))).toBe('$0.05')
    expect(formatForeignPrice(usd(0))).toBe('$0.00')
  })

  it('is not thrown off by how a decimal fraction is held as a number', () => {
    // 8.99 × 100 is 899.0000000000001, and 1.005 × 100 is 100.49999999999999.
    expect(formatForeignPrice(usd(0.1 + 0.2))).toBe('$0.30')
    expect(formatForeignPrice(usd(19.99))).toBe('$19.99')
    expect(formatForeignPrice(usd(1.15))).toBe('$1.15')
    expect(formatForeignPrice(usd(64.35))).toBe('$64.35')
  })

  it('groups thousands with a comma, as the store would', () => {
    expect(formatForeignPrice(usd(1299))).toBe('$1,299.00')
    expect(formatForeignPrice(usd(1234567.5))).toBe('$1,234,567.50')
  })

  it('has no locale to depend on: the Ukrainian page and the English one quote the same figure', () => {
    // The hryvnia estimate beside it is the part that follows the page's language.
    expect(formatForeignPrice(usd(8.99))).toBe('$8.99')
    expect(formatUah(1348, 'uk-UA').replace(/\s/g, ' ')).toBe('1 348 ₴')
    expect(formatUah(1348, 'en-US').replace(/\s/g, ' ')).toBe('1,348 ₴')
    expect(formatUah(404, 'uk-UA')).toBe(formatUah(404, 'en-US'))
  })

  it('writes a currency it has no sign for by its code, after the number, on one line', () => {
    expect(formatForeignPrice({ amount: 7.5, currency: 'EUR' })).toBe('7.50\u00a0EUR')
  })
})

describe('isPriceAmount', () => {
  it.each([0, 0.01, 8.99, 675, 1_349])('takes %j for a price', (amount) => {
    expect(isPriceAmount(amount)).toBe(true)
  })

  it.each([
    [-0.01],
    [-8.99],
    [-675],
    [Number.NaN],
    [Number.NEGATIVE_INFINITY],
    [null],
    [undefined],
    ['8.99'],
  ])('does not take %j for one', (amount) => {
    expect(isPriceAmount(amount as number)).toBe(false)
  })
})

describe('namesAnotherProduct', () => {
  const GAME = 'Batman: Arkham Knight'

  it.each([
    ['The Witcher 3: Wild Hunt - Game of the Year Edition', 'The Witcher 3: Wild Hunt'],
    ['Forza Horizon 5 Standard Edition', 'Forza Horizon 5'],
    ['Hollow Knight: Voidheart Edition', 'Hollow Knight'],
    ['Life is Strange Complete Season (Episodes 1-5)', 'Life is Strange'],
    ['Відьмак 3: Дикий Гін', 'The Witcher 3: Wild Hunt'],
    ['Batman: Arkham Knight Premium Edition', GAME],
  ])('says %j is another product than %j', (title, name) => {
    expect(namesAnotherProduct(title, name)).toBe(true)
  })

  it.each([
    ['the same name', 'Batman: Arkham Knight'],
    ['capitals', 'BATMAN: ARKHAM KNIGHT'],
    ['a trademark sign', 'Batman™: Arkham Knight'],
    ['a registered sign', 'Batman®: Arkham Knight'],
    ['a copyright sign', 'Batman: Arkham Knight ©'],
    ['spaces around it', '   Batman: Arkham Knight  '],
    ['a run of spaces inside it', 'Batman:   Arkham    Knight'],
    ['a tab and a line break', 'Batman:\tArkham\nKnight'],
    ['a no-break space', 'Batman:\u00a0Arkham Knight'],
    ['all of them at once', '  BATMAN™:  Arkham\u00a0KNIGHT® '],
  ])('says the game’s own name with %s is not', (_what, title) => {
    expect(namesAnotherProduct(title, GAME)).toBe(false)
  })

  it('compares both ways: signs and capitals in the game’s name do not count either', () => {
    expect(namesAnotherProduct('limbo', 'LIMBO')).toBe(false)
    expect(namesAnotherProduct('METRO EXODUS', 'Metro Exodus')).toBe(false)
    expect(namesAnotherProduct('Tetris Effect', 'Tetris® Effect')).toBe(false)
  })

  it('still tells punctuation apart: that is not case, a sign or spacing', () => {
    expect(namesAnotherProduct('Batman - Arkham Knight', GAME)).toBe(true)
    expect(namesAnotherProduct('Batman Arkham Knight', GAME)).toBe(true)
  })

  it.each([[null], [undefined], [''], ['   '], ['™'], [' ® © ']])(
    'has nothing to show for a title of %j',
    (title) => {
      expect(namesAnotherProduct(title, GAME)).toBe(false)
    },
  )

  it('shows a title when the game’s own name is unknown', () => {
    expect(namesAnotherProduct('Stardew Valley', null)).toBe(true)
    expect(namesAnotherProduct('Stardew Valley', undefined)).toBe(true)
    expect(namesAnotherProduct('Stardew Valley', '')).toBe(true)
  })
})
