import { describe, expect, it } from 'vitest'
import { roundGameCount } from '~/utils/roundGameCount'

describe('roundGameCount', () => {
  it.each([
    [900_934, 900_000], // production totalGames today
    [1_000_000, 1_000_000],
    [100_000, 100_000],
    [199_999, 100_000],
    [99_999, 99_000],
    [1_999, 1_000],
    [999, 0],
    [0, 0],
    [250_500, 200_000],
  ])('rounds %i down to %i', (input, expected) => {
    expect(roundGameCount(input)).toBe(expected)
  })

  it('never returns a negative count for negative input', () => {
    expect(roundGameCount(-5)).toBe(0)
  })
})
