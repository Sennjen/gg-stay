/**
 * The decisions behind the Speed Insights loader (`app/plugins/speed-insights.client.ts`), kept out
 * of the plugin so they can be tested without a build.
 */

/** The two privacy signals a browser can send; both are read from `navigator`. */
export interface PrivacySignals {
  doNotTrack?: string | null
  globalPrivacyControl?: boolean
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
 * that opted in, and never for a visitor who sent Do Not Track or Global Privacy Control. A visitor
 * who declined is not measured less — the script is simply never requested.
 */
export function speedInsightsWanted({ enabled, dev, navigator }: SpeedInsightsGate): boolean {
  if (dev) return false
  if (!['1', 'true'].includes(String(enabled))) return false
  if (navigator.doNotTrack === '1') return false
  if (navigator.globalPrivacyControl === true) return false
  return true
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
