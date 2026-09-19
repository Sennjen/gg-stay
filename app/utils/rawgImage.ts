const RAWG_MEDIA = 'https://media.rawg.io/media/'
const WIDTHS = [200, 420, 640, 1280] as const

// Accept a CDN size down to 75% of the requested width (upscaled by at most
// one third) rather than always rounding up to the next size. This trades
// slightly soft images on 2x screens for 2-4x fewer bytes per cover.
const MIN_COVERAGE_RATIO = 0.75

/** Rewrites a RAWG media url to the CDN's resized variant. */
export function rawgImageUrl(src: string, width?: number): string {
  if (!width || !src.startsWith(RAWG_MEDIA)) return src
  const rest = src.slice(RAWG_MEDIA.length)
  if (rest.startsWith('resize/') || rest.startsWith('crop/')) return src
  const target =
    WIDTHS.find((candidate) => candidate >= width * MIN_COVERAGE_RATIO) ?? WIDTHS[WIDTHS.length - 1]
  return `${RAWG_MEDIA}resize/${target}/-/${rest}`
}
