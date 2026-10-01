import type { RouteLocationNormalized } from 'vue-router'

/**
 * Vercel Speed Insights: Core Web Vitals from real visitors, grouped by route pattern.
 *
 * Not the package's own Nuxt module, which registers a plugin that injects the script while the
 * app is still starting, for every visitor, in every build. This plugin does what that module's
 * runtime does — `injectSpeedInsights` with the route pattern from `computeRoute` (so
 * `/games/[slug]`, not each slug), updated after every client-side navigation, plus the two build
 * variables Vercel uses to relocate the script — and adds what the module cannot:
 *
 *  - production builds of a deployment that opted in only (`NUXT_PUBLIC_SPEED_INSIGHTS=1`), so a
 *    local or CI build never requests `/_vercel/speed-insights/script.js`, which exists only on a
 *    Vercel deployment with Speed Insights enabled;
 *  - nothing at all for a visitor who sends Do Not Track or Global Privacy Control;
 *  - loaded after hydration, when the browser is idle, from its own chunk, and never prefetched
 *    (see the `build:manifest` hook in nuxt.config.ts): first-load JavaScript carries only this
 *    file;
 *  - no query strings or fragments in the reported address (`withoutQuery`).
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
    const wanted = speedInsightsWanted({
      enabled: useRuntimeConfig().public.speedInsights,
      dev: import.meta.dev,
      navigator: window.navigator,
    })
    if (!wanted) return

    onNuxtReady(async () => {
      try {
        const { computeRoute, injectSpeedInsights } = await import('@vercel/speed-insights')
        const router = nuxtApp.$router
        const pattern = (to: RouteLocationNormalized) =>
          computeRoute(to.path, to.params as Record<string, string | string[]>)
        const insights = injectSpeedInsights(
          {
            route: pattern(router.currentRoute.value),
            framework: 'nuxt',
            basePath: import.meta.env.VITE_VERCEL_OBSERVABILITY_BASEPATH,
            beforeSend: withoutQuery,
          },
          import.meta.env.VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG,
        )
        router.afterEach((to) => insights?.setRoute(pattern(to)))
      } catch {
        // A blocked or failed chunk costs the page nothing; the measurement is simply missing.
      }
    })
  },
})
