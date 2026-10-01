/**
 * The decisions behind the Speed Insights loader (`app/plugins/speed-insights.client.ts`), kept out
 * of the plugin so they can be tested without a build.
 */

/** The two privacy signals a browser can send; both are read from `navigator`. */
export interface PrivacySignals {
  doNotTrack?: string | null
  globalPrivacyControl?: boolean
}

/**
 * The build-time default of `runtimeConfig.public.speedInsights`: on for a Vercel production build
 * (`VERCEL_ENV=production`), where the project has Speed Insights enabled and
 * `/_vercel/speed-insights/script.js` exists; off for previews, local and CI builds, and fixture
 * mode, which would otherwise request a script that is not there or measure recorded data.
 * `NUXT_PUBLIC_SPEED_INSIGHTS` overrides it at runtime either way (`0` off, `1` on).
 */
export function speedInsightsDefault(env: Record<string, string | undefined>): '1' | '' {
  return env.VERCEL_ENV === 'production' && env.RAWG_FIXTURES !== '1' ? '1' : ''
}

export interface SpeedInsightsGate {
  /** `runtimeConfig.public.speedInsights`; env overrides arrive parsed by destr. */
  enabled: unknown
  /** `import.meta.dev`. */
  dev: boolean
  navigator: PrivacySignals
}

/**
 * Whether this page view may load Speed Insights at all: only in a production build of a deployment
 * where it is on (see `speedInsightsDefault`), and never for a visitor who sent Do Not Track or Global Privacy Control. A visitor
 * who declined is not measured less — the script is simply never requested.
 */
export function speedInsightsWanted({ enabled, dev, navigator }: SpeedInsightsGate): boolean {
  if (dev) return false
  if (!['1', 'true'].includes(String(enabled))) return false
  // "yes" is what older Firefox and Safari sent.
  if (['1', 'yes'].includes(String(navigator.doNotTrack))) return false
  if (navigator.globalPrivacyControl === true) return false
  return true
}

/** The part of a resolved route `routePattern` reads. */
export interface MatchedRoute {
  matched: readonly { path: string }[]
}

/**
 * The route a page view is reported under. Always a pattern from a fixed, small set, so the
 * dashboard groups page views instead of growing one row per address:
 *
 *  - a matched route → its record's path with every parameter written as `[name]`
 *    (`/en/games/:slug()` → `/en/games/[slug]`), read from the route table rather than rebuilt
 *    from the address, so a slug can never leak into it;
 *  - a page showing an error → `/404` for not found, `/error` for anything else, whatever route it
 *    is on — an unknown slug must not count towards the game page's numbers;
 *  - an address nothing matched → `/404`, never the address itself.
 */
export function routePattern(
  to: MatchedRoute,
  error: { statusCode?: number } | null | undefined,
): string {
  if (error) return error.statusCode === 404 ? '/404' : '/error'
  const record = to.matched.at(-1)
  if (!record) return '/404'
  return record.path.replace(/:(\w+)(?:\([^)]*\))?[?*+]?/g, '[$1]')
}

/**
 * The `beforeSend` hook: every report carries the page address without its query string or
 * fragment, so catalog searches and filters never leave the browser. The route pattern
 * (`/games/[slug]`) is what the dashboard groups by; the address is only the detail beneath it.
 */
export function withoutQuery<T extends { url: string }>(event: T): T {
  const end = event.url.search(/[?#]/)
  return end === -1 ? event : { ...event, url: event.url.slice(0, end) }
}
