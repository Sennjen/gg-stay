import { describe, expect, it } from 'vitest'
import { chipPercent } from '../../shared/discount'

describe('chipPercent', () => {
  it.each([1, 2, 50, 78, 99])(
    'is %i for a discount of that much beside a higher price',
    (percent) => {
      expect(chipPercent(percent, true)).toBe(percent)
    },
  )

  it.each([
    [0, 'nothing'],
    [100, 'everything'],
    [101, 'more than everything'],
    [-5, 'less than nothing'],
    [Number.NaN, 'no number'],
    [null, 'no percent'],
    [undefined, 'no percent at all'],
  ])(
    'is no chip for %j: a discount of %s says nothing a price can be read off',
    (percent, _what) => {
      expect(chipPercent(percent, true)).toBeNull()
    },
  )

  it('is no chip without a higher price beside it, whatever the percent', () => {
    for (const percent of [1, 50, 99]) expect(chipPercent(percent, false)).toBeNull()
  })

  it('takes nothing but a number for a percent', () => {
    expect(chipPercent('50' as unknown as number, true)).toBeNull()
  })
})
