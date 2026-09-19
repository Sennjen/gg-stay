const LARGE_STEP = 100_000
const SMALL_STEP = 1_000
const LARGE_THRESHOLD = 100_000

/**
 * Rounds a catalog total down to a "friendly" figure for the landing page headline
 * ("900 000+ ігор у каталозі"): down to the nearest 100 000 once the count reaches
 * six figures, down to the nearest 1 000 below that. Always rounds down, so the "+"
 * suffix next to it never overstates the real total.
 *
 * Returns `null` when rounding down lands on zero — a total under 1 000 has no friendly figure,
 * and "0+ ігор у каталозі" is worse than saying nothing. The landing page hides the headline in
 * that case. Real RAWG totals are ~900 000; the fixture set is what makes this reachable.
 */
export function roundGameCount(total: number): number | null {
  if (total <= 0) return null
  const step = total >= LARGE_THRESHOLD ? LARGE_STEP : SMALL_STEP
  const rounded = Math.floor(total / step) * step
  return rounded > 0 ? rounded : null
}
