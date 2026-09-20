const RAWG_MEDIA = 'https://media.rawg.io/media/'

// `@nuxt/image`'s `sizes` prop is NOT a CSS `sizes` attribute. It takes `breakpoint:value` pairs
// keyed on `image.screens` (nuxt.config.ts: sm 420, md 640, lg 1280, plus @nuxt/image's own
// xl 1280 / 2xl 1536 defaults) and builds both the emitted `sizes` attribute and the `srcset`
// candidates from them. A CSS media-query string is silently mangled: `parseSizes` splits on
// whitespace/commas and on `:`, so `(max-width: 640px) 50vw, 33vw` decomposes into garbage, and a
// bare `33vw` with no breakpoint key produces a single `0w` candidate — an invalid descriptor that
// voids the whole srcset. Only a bare pixel value (`200px`) is safe without a key: it yields one
// candidate per density at exactly that width.
//
// Each pair contributes a candidate of `round(value% × screenWidth) × density` and a media query
// that ends at the NEXT declared breakpoint, so `sm:` covers viewports up to 639px, `md:` up to
// 1279px and `lg:` everything above. Values are therefore written against the layout's real slot
// width at the top of each of those bands, not against the Tailwind breakpoint that produced it.
// Repeated CDN urls at different descriptors are expected: `rawgImageUrl` snaps a requested width
// to the nearest variant that covers at least 75% of it.
//
// Every constant below is covered by a test that asserts the EMITTED `sizes`/`srcset`, because the
// input string alone says nothing about what the browser receives.

/** Full-bleed heroes: 100vw at every breakpoint, up to the CDN original on large dense screens. */
export const HERO_IMAGE_SIZES = 'sm:100vw md:100vw lg:100vw xl:100vw 2xl:100vw'

/**
 * Catalog grid card: `grid-cols-2 md:3 lg:4 xl:5` (Tailwind breakpoints 768/1024/1280) inside a
 * `max-w-6xl` container, so the real slot is ~w/2 below 768px, 228–375px from 640 to 1279px, and a
 * fixed ~211px above that.
 *
 * `@nuxt/image`'s bands do not line up with Tailwind's — `md:` here covers **640–1279px**, where
 * the layout is 2, 3 *and* 4 columns — so a `vw` value cannot fit that band: 50vw is right at
 * 640px and twice the slot at 1279px, 33vw is the reverse. A fixed `380px`, the widest slot the
 * band ever renders (2 columns at 767px), is honest across all of it and resolves to the same CDN
 * variant the pre-breakpoint `420px` string did. Declaring `50vw` here instead made a 1024px
 * laptop claim a 512px slot and fetch the 640px variant for a ~250px cover.
 */
export const CARD_GRID_IMAGE_SIZES = 'sm:50vw md:380px lg:220px'

/** Catalog list card: full width on phones, a fixed 220px cover from 640px up. */
export const CARD_LIST_IMAGE_SIZES = 'sm:100vw md:220px'

/** Landing rows: cards are a fixed 280px wide in the horizontal scroller at every viewport. */
export const CARD_ROW_IMAGE_SIZES = '280px'

/** Gallery thumbnails: 2 columns on phones, 3 above 640px, capped by the container at ~365px. */
export const GALLERY_THUMB_IMAGE_SIZES = 'sm:50vw md:33vw lg:370px'

/** Lightbox: viewport-wide on phones, capped by the dialog's `max-w-4xl` column above 1280px. */
export const GALLERY_LIGHTBOX_IMAGE_SIZES = 'sm:100vw md:100vw lg:900px'

/** Header search suggestions: a fixed 96px thumbnail. */
export const SEARCH_THUMBNAIL_IMAGE_SIZES = '96px'
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
