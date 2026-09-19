import { createHash } from 'node:crypto'
import { CSP_HEADER, contentSecurityPolicy } from '../security/headers'

/**
 * Nuxt inlines two scripts into every server-rendered page — the `#entry` import map and the
 * `window.__NUXT__.config` assignment — and neither carries a nonce without a security module. The
 * blunt fix would be `script-src 'unsafe-inline'`, which would give up most of what the policy is
 * for. Instead this hashes exactly the inline scripts Nuxt itself emitted and allows those, so
 * anything injected into the page later (the actual attack) still has no source that matches.
 *
 * `render:html` runs after the head and body chunks are assembled and before the response is sent,
 * which is the one point where both the final markup and the event are in hand. The header set
 * here replaces the hash-free one that `routeRules` put on the response.
 */

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g

/** JSON in a `<script type="application/json">` is data, not code, and needs no hash. */
const DATA_SCRIPT = /type="application\/(?:ld\+)?json"/

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
    if (hashes.length === 0) return
    setResponseHeader(event, CSP_HEADER, contentSecurityPolicy(hashes))
  })
})
