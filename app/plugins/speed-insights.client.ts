/**
 * Vercel Speed Insights: Core Web Vitals from real visitors, grouped by route pattern.
 *
 * Not the package's own Nuxt module, which registers a plugin that injects the script while the
 * app is still starting, for every visitor, in every build. This plugin keeps the same runtime call
 * (`injectSpeedInsights` from `@vercel/speed-insights/nuxt/runtime`, which reports
 * `/games/[slug]` rather than each slug and follows client-side navigation) and adds what the
 * module cannot:
 *
 *  - production builds of a deployment that opted in only (`NUXT_PUBLIC_SPEED_INSIGHTS=1`), so a
 *    local or CI build never requests `/_vercel/speed-insights/script.js`, which exists only on a
 *    Vercel deployment with Speed Insights enabled;
 *  - nothing at all for a visitor who sends Do Not Track or Global Privacy Control;
 *  - loaded after hydration, when the browser is idle, from its own chunk: the runtime is a dynamic
 *    import, so the first-load JavaScript carries only this file;
 *  - no query strings or fragments in the reported address (`withoutQuery`).
 *
 * The script is same-origin and posts to `/_vercel/speed-insights/vitals`, so the existing
 * `script-src 'self'` and `connect-src 'self'` cover it; see `server/security/headers.ts`.
 */
export default defineNuxtPlugin({
  name: 'speed-insights',
  setup(nuxtApp) {
    const wanted = speedInsightsWanted({
      enabled: useRuntimeConfig().public.speedInsights,
      dev: import.meta.dev,
      navigator: window.navigator,
    })
    if (!wanted) return

    onNuxtReady(async () => {
      try {
        const { injectSpeedInsights } = await import('@vercel/speed-insights/nuxt/runtime')
        // It reads the router through Nuxt's composables, so it needs the app's context back.
        nuxtApp.runWithContext(() => injectSpeedInsights({ beforeSend: withoutQuery }))
      } catch {
        // A blocked or failed chunk costs the page nothing; the measurement is simply missing.
      }
    })
  },
})
