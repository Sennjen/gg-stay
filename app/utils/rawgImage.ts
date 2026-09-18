const RAWG_MEDIA = 'https://media.rawg.io/media/'
const WIDTHS = [200, 420, 640, 1280] as const

/** Rewrites a RAWG media url to the CDN's resized variant. */
export function rawgImageUrl(src: string, width?: number): string {
  if (!width || !src.startsWith(RAWG_MEDIA)) return src
  const rest = src.slice(RAWG_MEDIA.length)
  if (rest.startsWith('resize/') || rest.startsWith('crop/')) return src
  const target = WIDTHS.find((candidate) => candidate >= width) ?? WIDTHS[WIDTHS.length - 1]
  return `${RAWG_MEDIA}resize/${target}/-/${rest}`
}
