/** Schemes that are safe to put in an `href` the visitor can click. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Returns `raw` normalised as an absolute http(s) URL, or `null` for anything else.
 *
 * Store links, game websites and trailer URLs all come from third-party APIs whose records are
 * partly publisher-submitted, and Vue does not sanitise `:href` — a `javascript:` or `data:` value
 * would become a one-click script execution in this site's own origin. Parsing with `URL` (rather
 * than a regex) is what makes the scheme check reliable: it is the same parser the browser uses,
 * so it sees through leading whitespace and control characters, mixed case and percent-encoding
 * exactly as the browser would. A protocol-relative or relative value has no scheme at all and
 * fails to parse without a base, which is the right answer here: these URLs must be absolute.
 *
 * Applied in the mappers so an unsafe value never enters the GraphQL response, and again at the
 * template sites as defence in depth.
 */
export function safeExternalUrl(raw?: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}
