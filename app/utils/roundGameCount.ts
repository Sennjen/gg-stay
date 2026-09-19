const LARGE_STEP = 100_000
const SMALL_STEP = 1_000
const LARGE_THRESHOLD = 100_000

/**
 * Rounds a catalog total down to a "friendly" figure for the landing page headline
 * ("900 000+ ігор у каталозі"): down to the nearest 100 000 once the count reaches
 * six figures, down to the nearest 1 000 below that. Always rounds down, so the "+"
 * suffix next to it never overstates the real total.
 */
export function roundGameCount(total: number): number {
  if (total <= 0) return 0
  const step = total >= LARGE_THRESHOLD ? LARGE_STEP : SMALL_STEP
  return Math.floor(total / step) * step
}
