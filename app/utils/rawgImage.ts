const RAWG_MEDIA = 'https://media.rawg.io/media/'

// `@nuxt/image`'s `sizes` prop only produces a useful (viewport-width-scaled) srcset when given
// breakpoint:value pairs — a bare "100vw" (no breakpoint key) degrades to a single ~1px-wide
// candidate, since it falls back to treating the whole string as a literal screen key. Repeating
// "100vw" at every configured screen (see nuxt.config.ts `image.screens`, plus @nuxt/image's own
// xl/2xl defaults) makes each breakpoint request the CDN's best match for its own width, crossed
// with device pixel ratio — so a full-bleed hero on a large, dense screen ends up requesting well
// past 1280px and `rawgImageUrl` serves the original instead of an upscaled 1280px variant.
export const HERO_IMAGE_SIZES = 'sm:100vw md:100vw lg:100vw xl:100vw 2xl:100vw'
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
  const target = WIDTHS.find((candidate) => candidate >= width * MIN_COVERAGE_RATIO)
  // Nothing in WIDTHS covers the request within tolerance (e.g. a 100vw hero on a 2x screen
  // asking for well over 1280px): rather than upscale the largest CDN variant and go blurry,
  // serve the original — RAWG originals are typically 1920x1080 at ~330KB, a small price for a
  // sharp hero image.
  if (!target) return src
  return `${RAWG_MEDIA}resize/${target}/-/${rest}`
}
