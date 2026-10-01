/**
 * Vercel Speed Insights: Core Web Vitals from real visitors, grouped by route pattern.
 *
 * Not the package's own Nuxt module, which registers a plugin that injects the script while the
 * app is still starting, for every visitor, in every build. This plugin does what that module's
 * runtime does — `injectSpeedInsights` with the route pattern from `computeRoute` (so
 * `/games/[slug]`, not each slug), updated after every client-side navigation, plus the two build
 * variables Vercel uses to relocate the script — and adds what the module cannot:
 *
 *  - Vercel production builds only by default (`speedInsightsDefault`; `NUXT_PUBLIC_SPEED_INSIGHTS`
 *    0/1 overrides it), so previews, local and CI builds never request
 *    `/_vercel/speed-insights/script.js`, which exists only on a deployment with it enabled;
 *  - nothing at all for a visitor who sends Do Not Track or Global Privacy Control;
 *  - loaded after hydration, when the browser is idle, from its own chunk, and never prefetched
 *    (see the `build:manifest` hook in nuxt.config.ts): first-load JavaScript carries only this
 *    file;
 *  - no query strings or fragments in the reported address (`withoutQuery`);
 *  - a route pattern taken from the route table, with error pages and unmatched addresses reported
 *    as `/404` or `/error` (`routePattern`) — the package's `computeRoute` rebuilds the pattern
 *    from the address and returns an unmatched address unchanged.
 *
 * It imports the framework-free entry (`@vercel/speed-insights`) rather than
 * `@vercel/speed-insights/nuxt/runtime`: the latter imports Nuxt's and Vue's composables, and a
 * dynamic chunk that shares modules with the entry made the bundler re-split three first-load
 * chunks — new hashes for code that did not change, and an extra late request. The framework-free
 * entry leaves every other chunk byte-identical.
 *
 * The script is same-origin and posts to `/_vercel/speed-insights/vitals`, so the existing
 * `script-src 'self'` and `connect-src 'self'` cover it; see `server/security/headers.ts`.
 */
export default defineNuxtPlugin({
  name: 'speed-insights',
  setup(nuxtApp) {
    const navigator: PrivacySignals = window.navigator
    const wanted = speedInsightsWanted({
      enabled: useRuntimeConfig().public.speedInsights,
      dev: import.meta.dev,
      navigator: {
        // Older Safari sent Do Not Track on `window` instead.
        doNotTrack: navigator.doNotTrack ?? (window as PrivacySignals).doNotTrack,
        globalPrivacyControl: navigator.globalPrivacyControl,
      },
    })
    if (!wanted) return

    const error = useError()
    onNuxtReady(async () => {
      try {
        const { injectSpeedInsights } = await import('@vercel/speed-insights')
        const router = nuxtApp.$router
        const insights = injectSpeedInsights(
          {
            route: routePattern(router.currentRoute.value, error.value),
            framework: 'nuxt',
            basePath: import.meta.env.VITE_VERCEL_OBSERVABILITY_BASEPATH,
            beforeSend: withoutQuery,
          },
          import.meta.env.VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG,
        )
        if (!insights) return
        router.afterEach((to) => insights.setRoute(routePattern(to, error.value)))
        // A page throws its 404 after the navigation that led to it has finished, and leaving an
        // error page clears the error after it; both have to move the route too.
        watch(error, () => insights.setRoute(routePattern(router.currentRoute.value, error.value)))
      } catch {
        // A blocked or failed chunk costs the page nothing; the measurement is simply missing.
      }
    })
  },
})
