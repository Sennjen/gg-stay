// Every third-party origin this app is allowed to reach, named once. RAWG serves covers and its
// own mp4 clips; Steam serves HLS trailers, which hls.js fetches over XHR (hence `connect-src`),
// demuxes in a worker it creates from a blob URL (hence `worker-src blob:`) and attaches to the
// <video> element as a MediaSource object URL (hence `blob:` in `media-src` — a blob in a media
// context is governed by `media-src`, not by `worker-src`, and without it the trailer silently
// never plays on every engine that is not Safari).
const RAWG_MEDIA = 'https://media.rawg.io'
// media.rawg.io 307-redirects anything it does not hold in its own bucket to api.rawg.io, and a
// redirect target has to satisfy the policy in its own right. Verified against the live CDN:
// GET media.rawg.io/media/resize/640/-/screenshots/201001/full1.jpg → 307 → api.rawg.io/…, which a
// policy naming only media.rawg.io blocks. Both hosts serve the same images.
const RAWG_MEDIA_REDIRECT = 'https://api.rawg.io'
// Verified against a live Steam trailer (app 292030): the master playlist, every variant playlist
// and the audio playlist reference their segments with RELATIVE URIs and answer 200 with no
// redirect, so the whole session stays on this one host. Steam's other CDN host
// (shared.akamai.steamstatic.com) only serves the movie thumbnails, which the projection in
// server/steam/appDetailsProjection.ts never keeps — only `hls_h264` reaches the client.
const STEAM_VIDEO = 'https://video.akamai.steamstatic.com'

/**
 * Builds the policy. `scriptHashes` are `'sha256-…'` sources for the two scripts Nuxt inlines into
 * every server-rendered page (the import map and the `window.__NUXT__.config` assignment); the
 * Nitro plugin in server/plugins/csp.ts computes them per response, so HTML gets an exact-hash
 * `script-src` instead of `'unsafe-inline'`. Responses with no inline script (the API, JSON errors)
 * get the hash-free policy, which is strictly tighter.
 *
 * THE CSP IS SENT FROM EXACTLY ONE PLACE — that plugin. It deliberately does NOT go into
 * `routeRules`: the Vercel preset compiles a `routeRules` header into a proxy-level entry in
 * `.vercel/output/config.json`, which would put a hash-free `script-src 'self'` on every response
 * either instead of or alongside the function's own header. Either way the browser would end up
 * enforcing a policy without the hashes, block `window.__NUXT__.config`, and leave every page
 * server-rendered but unhydrated — in production only, where no header test runs.
 * `STATIC_SECURITY_HEADERS` below is what `routeRules` carries, and it has no CSP in it.
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
    `media-src 'self' blob: ${RAWG_MEDIA} ${STEAM_VIDEO}`,
    `connect-src 'self' ${STEAM_VIDEO}`,
    "worker-src 'self' blob:",
  ].join('; ')
}

export const CSP_HEADER = 'content-security-policy'

/**
 * The policy for `/api/graphql`, set by the route handler itself.
 *
 * This is not a second source for the pages: yoga answers with its own `Response`, which Nitro
 * hands straight to the client without passing it through the `beforeResponse` hook the plugin
 * back-fills from, so that one route would otherwise carry no policy at all. A JSON body hosts no
 * document and loads nothing, so it needs no allow-list — `'none'` everywhere is both the tightest
 * and the most accurate description of what the endpoint is entitled to do. `nosniff` (from
 * `routeRules`) is what stops the body being re-interpreted as a document in the first place; this
 * header is what makes the answer harmless if it ever were.
 *
 * On Vercel the same gap applies to CDN-served static assets, which never reach the function at
 * all: they carry the four static headers from the route table and no CSP. Also harmless — they
 * are scripts, styles and fonts, governed by the policy of the page that loads them — and stated
 * here rather than implied away.
 */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'"

/**
 * The headers that are identical on every response and carry no per-response state, so they are
 * safe to set once in `routeRules` — which on Vercel means the CDN applies them to static assets
 * too, not just to function responses. The CSP is **not** among them; see above.
 */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Belt and braces with `frame-ancestors 'none'` in the policy, for anything that still reads it.
  'X-Frame-Options': 'DENY',
  // The app uses none of these; denying them stops an embedded third party asking either.
  // `autoplay=(self)` is the exception: the hero trailer plays muted on its own.
  'Permissions-Policy':
    'accelerometer=(), autoplay=(self), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
}
