import AxeBuilder from '@axe-core/playwright'
import { expect, test as base, type Page } from '@playwright/test'

/**
 * A grey 16×9 PNG served in place of every RAWG image. The flows run against the fixture build and
 * must not depend on (or reach) a third-party CDN; a real image keeps `<img>` from erroring, so the
 * pages look and behave as they do in production — only the pixels differ.
 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAEUlEQVR42mPQIhEwjGoYFBoAETxG4RfFmD4AAAAASUVORK5CYII=',
  'base64',
)
const RAWG_IMAGES = /^https:\/\/(media|api)\.rawg\.io\//

/**
 * Impacts that fail a flow. The spec's bar is serious and critical; moderate is held too, because no
 * moderate finding remains and the gate should keep it that way. `minor` findings are annotated in
 * the report but not fatal.
 */
const BLOCKING_IMPACTS = new Set(['moderate', 'serious', 'critical'])

/**
 * Runs axe on the page as it is now and fails on any moderate, serious or critical violation, listing each
 * rule and the elements it flagged. Call it on every page a flow visits and in every dialog state.
 */
export async function expectAccessible(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ''),
  )
  const report = blocking.map(
    (violation) =>
      `${violation.impact} ${violation.id}: ${violation.help}\n` +
      violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
  )
  // Findings below the bar stay visible in the report as annotations rather than vanishing.
  for (const violation of results.violations) {
    if (BLOCKING_IMPACTS.has(violation.impact ?? '')) continue
    base.info().annotations.push({
      type: 'axe',
      description: `${state}: ${violation.impact} ${violation.id} (${violation.nodes.length})`,
    })
  }
  expect(report, `axe on ${state} (${page.url()})`).toEqual([])
}

/**
 * Resolves once Nuxt has finished hydrating the server-rendered page, so client handlers are
 * attached: a click before that reaches a button with no listener yet. Read from the Vue app on the
 * mount point (`vueApp.config.globalProperties.$nuxt` is the Nuxt app), the same flag
 * `useNuxtApp().isHydrating` exposes inside the app.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    type Mounted = { __vue_app__?: { config: { globalProperties: Record<string, unknown> } } }
    const app = (document.querySelector('#__nuxt') as (Element & Mounted) | null)?.__vue_app__
    const nuxt = app?.config.globalProperties.$nuxt as { isHydrating?: boolean } | undefined
    return nuxt?.isHydrating === false
  })
}

export const test = base.extend<{ consoleErrors: string[] }>({
  // Uncaught exceptions, hydration-mismatch reports and CSP violations all reach the console as
  // errors; none is expected on any flow. The one exception is the failed load of a request this
  // fixture refused itself (below), which Chrome logs against the off-site URL.
  consoleErrors: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL!).origin
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() !== 'error') return
        const source = message.location().url
        const refused = source && new URL(source).origin !== origin
        if (refused && message.text().startsWith('Failed to load resource')) return
        errors.push(`${message.text()} (${source || 'no source'})`)
      })
      await use(errors)
      expect(errors, 'browser console errors').toEqual([])
    },
    { auto: true },
  ],
  page: async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    await page.route(
      (url) => url.origin !== origin,
      (route) => {
        if (RAWG_IMAGES.test(route.request().url())) {
          return route.fulfill({ status: 200, contentType: 'image/png', body: PLACEHOLDER_PNG })
        }
        // Everything else off-site (Steam's trailer CDN) is refused: no flow needs it.
        return route.abort('blockedbyclient')
      },
    )
    await use(page)
  },
})

export { expect }
