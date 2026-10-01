/**
 * Fixture mode is never measured. It can be switched on at runtime (`NUXT_RAWG_FIXTURES=1`), after
 * the build baked Speed Insights on, so the server turns the public flag off for every render in
 * fixture mode — whatever `NUXT_PUBLIC_SPEED_INSIGHTS` says. The runtime config here is this
 * request's own copy, and it is what the page's `__NUXT__.config` is serialised from, so the client
 * loader (`speed-insights.client.ts`) simply sees the flag off.
 */
export default defineNuxtPlugin({
  name: 'speed-insights:fixtures',
  setup() {
    const config = useRuntimeConfig()
    config.public.speedInsights = speedInsightsAtRuntime(
      config.public.speedInsights,
      config.rawgFixtures,
    ) as string
  },
})
