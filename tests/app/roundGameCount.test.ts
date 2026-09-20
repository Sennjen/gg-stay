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
    [250_500, 200_000],
  ])('rounds %i down to %i', (input, expected) => {
    expect(roundGameCount(input)).toBe(expected)
  })

  // Anything that rounds down to nothing has no friendly figure to show: "0+ ігор у каталозі" is
  // a wrong sentence, and the landing page hides the headline rather than print it.
  it.each([999, 1, 0, -5])('returns null for %i, which has no friendly figure', (input) => {
    expect(roundGameCount(input)).toBeNull()
  })
})
