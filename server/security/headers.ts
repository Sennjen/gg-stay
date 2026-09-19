// Every third-party origin this app is allowed to reach, named once. RAWG serves covers and its
// own mp4 clips; Steam serves HLS trailers, which hls.js fetches over XHR (hence `connect-src`)
// and demuxes in a worker it creates from a blob URL (hence `worker-src blob:`).
const RAWG_MEDIA = 'https://media.rawg.io'
// media.rawg.io 307-redirects anything it does not hold in its own bucket to api.rawg.io, and a
// redirect target has to satisfy the policy in its own right. Verified against the live CDN:
// GET media.rawg.io/media/resize/640/-/screenshots/201001/full1.jpg → 307 → api.rawg.io/…, which a
// policy naming only media.rawg.io blocks. Both hosts serve the same images.
const RAWG_MEDIA_REDIRECT = 'https://api.rawg.io'
const STEAM_VIDEO = 'https://video.akamai.steamstatic.com'

/**
 * Builds the policy. `scriptHashes` are `'sha256-…'` sources for the two scripts Nuxt inlines into
 * every server-rendered page (the import map and the `window.__NUXT__.config` assignment); the
 * Nitro plugin in server/plugins/csp.ts computes them per response, so HTML gets an exact-hash
 * `script-src` instead of `'unsafe-inline'`. Everything else — the JS, CSS, font and image assets —
 * carries the hash-free policy from `routeRules`, which is strictly tighter.
 *
 * `style-src` keeps `'unsafe-inline'`: Nuxt inlines each route's critical CSS into the rendered
 * head, and unlike the scripts those blocks are not enumerable ahead of the head being built, so
 * there is nothing stable to hash without a security module. Styles cannot execute, and
 * `script-src` with no `'unsafe-inline'` and no `'unsafe-eval'` is what closes the XSS path this
 * policy exists for.
 */
export function contentSecurityPolicy(scriptHashes: readonly string[] = []): string {
  const scriptSrc = ["'self'", ...scriptHashes].join(' ')
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // @nuxt/fonts downloads the Google families at build time and serves them from /_fonts.
    "font-src 'self'",
    `img-src 'self' data: ${RAWG_MEDIA} ${RAWG_MEDIA_REDIRECT}`,
    `media-src 'self' ${RAWG_MEDIA} ${STEAM_VIDEO}`,
    `connect-src 'self' ${STEAM_VIDEO}`,
    "worker-src 'self' blob:",
  ].join('; ')
}

export const CSP_HEADER = 'content-security-policy'

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': contentSecurityPolicy(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Belt and braces with `frame-ancestors 'none'` above, for anything that still reads this.
  'X-Frame-Options': 'DENY',
  // The app uses none of these; denying them stops an embedded third party asking either.
  // `autoplay=(self)` is the exception: the hero trailer plays muted on its own.
  'Permissions-Policy':
    'accelerometer=(), autoplay=(self), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
}
