import { createHash } from 'node:crypto'
import { CSP_HEADER, contentSecurityPolicy } from '../security/headers'

/**
 * The single source of the Content-Security-Policy header.
 *
 * It is a runtime plugin rather than a `routeRules` header on purpose: the Vercel preset compiles a
 * `routeRules` header into a proxy-level route in `.vercel/output/config.json`, which would put a
 * hash-free `script-src 'self'` on every response either instead of or alongside this one. The
 * browser would then enforce a policy without the hashes, block the two scripts Nuxt inlines — the
 * `#entry` import map and the `window.__NUXT__.config` assignment — and every page would render
 * from the server and never hydrate, in production only. `server/security/headers.ts` keeps the
 * static headers that are safe to set at the proxy; the CSP is set here, twice over:
 *
 *  - `render:html` runs after the head and body chunks are assembled and before the response is
 *    sent, which is the one point where both the final markup and the event are in hand. It hashes
 *    exactly the inline scripts Nuxt itself emitted, so anything injected into the page later (the
 *    actual attack) still has no source that matches.
 *  - `beforeResponse` fires last, for every response the server produces, and fills in the
 *    hash-free policy for anything that was not an HTML render (the GraphQL endpoint, JSON errors).
 *    It never overwrites a policy already set, so the hashed one always wins on HTML.
 */

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g

/** JSON in a `<script type="application/json">` is data, not code, and needs no hash. */
const DATA_SCRIPT = /type="application\/(?:ld\+)?json"/

/**
 * Nuxt inlines exactly two executable scripts per server-rendered page today. If that ever stops
 * being true, the page either loses a hash it needs (and stops hydrating) or gains one nobody
 * reviewed — both are worth a loud line in the logs rather than a silent behaviour change.
 */
const EXPECTED_INLINE_SCRIPTS = 2
let warned = false

function hashesIn(chunks: readonly string[]): string[] {
  const hashes = new Set<string>()
  for (const chunk of chunks) {
    for (const [tag, body] of chunk.matchAll(INLINE_SCRIPT)) {
      if (DATA_SCRIPT.test(tag)) continue
      if (!body) continue
      hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
    }
  }
  return [...hashes]
}

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:html', (html, { event }) => {
    const hashes = hashesIn([...html.head, ...html.bodyPrepend, ...html.body, ...html.bodyAppend])
    if (hashes.length !== EXPECTED_INLINE_SCRIPTS && !warned) {
      warned = true
      console.error(
        `[csp] expected ${EXPECTED_INLINE_SCRIPTS} inline scripts in the rendered page, found ` +
          `${hashes.length}. The page's script-src may no longer match what Nuxt inlines; check ` +
          `server/plugins/csp.ts against the current Nuxt release.`,
      )
    }
    setResponseHeader(event, CSP_HEADER, contentSecurityPolicy(hashes))
  })

  nitro.hooks.hook('beforeResponse', (event) => {
    if (getResponseHeader(event, CSP_HEADER)) return
    setResponseHeader(event, CSP_HEADER, contentSecurityPolicy())
  })
})
