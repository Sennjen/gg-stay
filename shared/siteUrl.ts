/** What a build without `NUXT_PUBLIC_SITE_URL` links to: the development server. */
export const DEV_SITE_URL = 'http://localhost:3000'

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/

/** Where the build runs, as Vercel reports it. Both are unset outside Vercel. */
export interface BuildEnvironment {
  /** `VERCEL_ENV`: `production`, `preview` or `development`. */
  vercelEnv?: string
  /** `VERCEL_URL`: the deployment's own host, without a scheme. */
  vercelUrl?: string
}

/** A preview deployment: a full copy of the site on its own host, never to be indexed. */
export function isPreviewDeployment(vercelEnv: string | undefined): boolean {
  return vercelEnv === 'preview'
}

/** The `X-Robots-Tag` a preview deployment sends on every response. */
export const PREVIEW_ROBOTS = 'noindex, nofollow'

const LOOPBACK = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/

/**
 * The site's public origin, checked before anything is built on it.
 *
 * Every canonical link, hreflang alternate, `og:url`, sitemap entry and JSON-LD `url` is this value
 * with a path appended, so a value that is not a bare origin breaks all of them at once and
 * silently: production once carried `https://gg-stay.vercel.app;`, and every canonical read
 * `https://gg-stay.vercel.app;/games`. The build therefore refuses anything that would not come
 * back unchanged from `new URL(raw).origin` — a trailing slash, semicolon or whitespace, a path, a
 * query, credentials, or a scheme other than http(s).
 *
 * When it is unset, where the build runs decides:
 * - **Vercel production** fails: a production build that lost the variable would otherwise point
 *   every canonical and the sitemap at localhost, as silently as the semicolon did. A production
 *   value must also be public — https, and not a loopback host.
 * - **Vercel preview** uses the deployment's own host (`VERCEL_URL`): the variable is set for
 *   production only, and a preview is its own site. Previews are kept out of the index anyway
 *   (`PREVIEW_ROBOTS`).
 * - **Anywhere else** — local builds, CI, the test server — falls back to the development origin.
 */
export function parseSiteUrl(raw: string | undefined, env: BuildEnvironment = {}): string {
  if (raw === undefined || raw === '') {
    if (env.vercelEnv === 'production') {
      throw new Error(
        'NUXT_PUBLIC_SITE_URL is required on a Vercel production build, and it is unset. Set it ' +
          'to the public origin, such as https://example.com.',
      )
    }
    if (isPreviewDeployment(env.vercelEnv)) {
      const origin = originOf(`https://${env.vercelUrl ?? ''}`)
      if (origin === null) {
        throw new Error(
          `NUXT_PUBLIC_SITE_URL is unset on a Vercel preview build, and VERCEL_URL ` +
            `(${JSON.stringify(env.vercelUrl ?? '')}) is not a host name to fall back to.`,
        )
      }
      return origin
    }
    return DEV_SITE_URL
  }
  const origin = originOf(raw)
  if (origin === null) {
    throw new Error(
      `NUXT_PUBLIC_SITE_URL must be an absolute http(s) origin with no path, query, trailing ` +
        `slash, whitespace or punctuation, such as https://example.com (a Unicode host goes in ` +
        `its punycode (xn--) form) — got ${JSON.stringify(raw)}.`,
    )
  }
  if (env.vercelEnv === 'production' && (!origin.startsWith('https://') || LOOPBACK.test(origin))) {
    throw new Error(
      `NUXT_PUBLIC_SITE_URL on a Vercel production build must be the public https origin, not ` +
        `${JSON.stringify(raw)}.`,
    )
  }
  return origin
}

/** `raw` as a bare http(s) origin, or `null` when it is anything more or less than one. */
function originOf(raw: string): string | null {
  let origin: string | null = null
  try {
    const url = new URL(raw)
    // The URL parser accepts `;` and `,` inside a host, so `https://gg-stay.vercel.app;` parses
    // with the semicolon as part of the host name. A real host name is labels of letters, digits
    // and hyphens (or a bracketed IPv6 address), and nothing else gets through.
    const hostOk = HOST_NAME.test(url.hostname) || IPV6_HOST.test(url.hostname)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && hostOk) origin = url.origin
  } catch {
    origin = null
  }
  // Comparing case-insensitively lets a capitalised host through (the URL parser lowercases it),
  // while anything the parser had to drop or rewrite — whitespace, a path, a stray character after
  // the host — makes the two differ.
  return origin !== null && origin === raw.toLowerCase() ? origin : null
}
