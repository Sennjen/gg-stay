/**
 * Absolute URLs on this site, for the head: Open Graph, JSON-LD and the share image.
 *
 * Built on `i18n.baseUrl` — the value every canonical and hreflang link already uses, validated at
 * build time by `shared/siteUrl.ts` — so a page's `og:url`, its JSON-LD `url` and its canonical can
 * never name two different hosts.
 */
export function useSiteUrl() {
  const siteUrl = useRuntimeConfig().public.i18n.baseUrl
  return {
    siteUrl,
    // The root is the bare origin, exactly as the i18n canonical writes it, so the landing's
    // JSON-LD `url` and its canonical are the same string.
    absoluteUrl: (path: string) =>
      path === '/' || path === ''
        ? siteUrl
        : `${siteUrl}${path.startsWith('/') ? path : `/${path}`}`,
  }
}
