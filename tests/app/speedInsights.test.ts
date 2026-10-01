import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import plugin from '~/plugins/speed-insights.client'
import { routePattern, speedInsightsWanted, withoutQuery } from '~/utils/speedInsights'

const { injectSpeedInsights, setRoute, ready } = vi.hoisted(() => {
  const setRoute = vi.fn()
  return {
    setRoute,
    injectSpeedInsights: vi.fn(() => ({ setRoute })),
    // The callbacks handed to `onNuxtReady`, run by the test when it says hydration has finished.
    ready: [] as (() => unknown)[],
  }
})

vi.mock('@vercel/speed-insights', () => ({ injectSpeedInsights }))

mockNuxtImport('onNuxtReady', () => (callback: () => unknown) => {
  ready.push(callback)
})

/** A navigator with only the two privacy signals the loader reads. */
const signals = (doNotTrack: string | null = null, globalPrivacyControl?: boolean) => ({
  doNotTrack,
  globalPrivacyControl,
})

describe('speedInsightsWanted', () => {
  it('loads in a production build where it is on, for a visitor sending no privacy signal', () => {
    expect(speedInsightsWanted({ enabled: '1', dev: false, navigator: signals() })).toBe(true)
  })

  it.each([
    ['the flag is empty (every build but Vercel production)', { enabled: '' }],
    ['the flag is off', { enabled: '0' }],
    ['the flag is missing', { enabled: undefined }],
    ['the build is a development build', { dev: true }],
    ['the visitor sends Do Not Track', { navigator: signals('1') }],
    ['the visitor sends Do Not Track the old way ("yes")', { navigator: signals('yes') }],
    ['the visitor sends Global Privacy Control', { navigator: signals(null, true) }],
  ])('does not load when %s', (_, override) => {
    const options = { enabled: '1', dev: false, navigator: signals(), ...override }
    expect(speedInsightsWanted(options)).toBe(false)
  })

  it.each([
    ['true', true],
    ['the number 1 (an env override parsed by destr)', 1],
    ['the string "true"', 'true'],
  ])('reads %s as on', (_, enabled) => {
    expect(speedInsightsWanted({ enabled, dev: false, navigator: signals() })).toBe(true)
  })

  it('treats an explicit Do Not Track "0" as no signal', () => {
    expect(speedInsightsWanted({ enabled: '1', dev: false, navigator: signals('0') })).toBe(true)
  })
})

describe('routePattern', () => {
  const at = (...paths: string[]) => ({ matched: paths.map((path) => ({ path })) })

  it.each([
    [at('/'), '/'],
    [at('/en'), '/en'],
    [at('/games'), '/games'],
    [at('/games/:slug()'), '/games/[slug]'],
    [at('/en/games/:slug()'), '/en/games/[slug]'],
    [at('/en/games/:slug'), '/en/games/[slug]'],
    [at('/docs/:path(.*)*'), '/docs/[path]'],
    [at('/games', '/games/:slug()'), '/games/[slug]'],
  ])('reports the matched record %j as %s', (to, expected) => {
    expect(routePattern(to, undefined)).toBe(expected)
  })

  it('reports a route nothing matched as /404, never its path', () => {
    expect(routePattern(at(), undefined)).toBe('/404')
  })

  it.each([
    ['a 404', { statusCode: 404 }, '/404'],
    ['a 500', { statusCode: 500 }, '/error'],
    ['an error with no status', {}, '/error'],
  ])('reports a page showing %s by its status, whatever route it is on', (_, error, expected) => {
    expect(routePattern(at('/games/:slug()'), error)).toBe(expected)
  })
})

describe('withoutQuery', () => {
  it.each([
    ['https://gg-stay.vercel.app/games?search=witcher&page=2', 'https://gg-stay.vercel.app/games'],
    [
      'https://gg-stay.vercel.app/en/games/portal-2#media',
      'https://gg-stay.vercel.app/en/games/portal-2',
    ],
    ['https://gg-stay.vercel.app/games?a=1#b', 'https://gg-stay.vercel.app/games'],
    ['https://gg-stay.vercel.app/', 'https://gg-stay.vercel.app/'],
  ])('reports %s as %s', (url, expected) => {
    expect(withoutQuery({ type: 'vital', url, route: '/games' })).toEqual({
      type: 'vital',
      url: expected,
      route: '/games',
    })
  })
})

describe('the Speed Insights plugin', () => {
  const config = () => useRuntimeConfig().public as Record<string, unknown>
  let saved: unknown
  // The plugin's navigation hook, captured instead of registered on the test app's real router.
  let navigationHook: ReturnType<typeof vi.spyOn<Router, 'afterEach'>>

  const runPlugin = async () => {
    const nuxtApp = useNuxtApp()
    await nuxtApp.runWithContext(() => plugin(nuxtApp))
  }
  const hydrate = async () => {
    for (const callback of ready.splice(0)) await callback()
  }
  const setNavigator = (name: string, value: unknown) =>
    Object.defineProperty(window.navigator, name, { value, configurable: true })

  beforeEach(() => {
    saved = config().speedInsights
    injectSpeedInsights.mockClear()
    setRoute.mockClear()
    ready.length = 0
    navigationHook = vi.spyOn(useNuxtApp().$router, 'afterEach').mockImplementation(() => () => {})
  })
  afterEach(() => {
    navigationHook.mockRestore()
    config().speedInsights = saved
    setNavigator('doNotTrack', null)
    setNavigator('globalPrivacyControl', undefined)
    Reflect.deleteProperty(window, 'doNotTrack')
  })

  it('is off while the public flag is empty, as in every build but Vercel production', async () => {
    config().speedInsights = ''
    await runPlugin()
    expect(ready).toHaveLength(0)
    await hydrate()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
  })

  it('injects the script once the app is ready, not while the plugin runs', async () => {
    config().speedInsights = '1'
    await runPlugin()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
    await hydrate()
    expect(injectSpeedInsights).toHaveBeenCalledTimes(1)
    expect(injectSpeedInsights).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/', framework: 'nuxt', beforeSend: withoutQuery }),
      undefined,
    )
  })

  it.each([
    ['/', '/'],
    ['/en', '/en'],
    ['/games?search=witcher', '/games'],
    ['/games/portal-2', '/games/[slug]'],
    ['/en/games/the-witcher-3-wild-hunt', '/en/games/[slug]'],
    // A slug equal to another segment of its path stays a pattern, not `/[slug]/games`.
    ['/games/games', '/games/[slug]'],
    ['/games/%D0%B3%D1%80%D0%B0', '/games/[slug]'],
    ['/this/is/not/a/page', '/404'],
    ['/en/xyz', '/404'],
    ['/games/portal-2/extra', '/404'],
  ])('reports a navigation to %s as the route %s', async (path, route) => {
    config().speedInsights = '1'
    const router = useNuxtApp().$router
    await runPlugin()
    await hydrate()
    expect(navigationHook).toHaveBeenCalledTimes(1)
    const guard = navigationHook.mock.calls[0]![0]
    guard(router.resolve(path), router.currentRoute.value, undefined)
    expect(setRoute).toHaveBeenLastCalledWith(route)
  })

  describe('on an error page', () => {
    afterEach(async () => {
      await clearError()
    })

    it('reports a game page that answered 404 (an unknown slug) as /404', async () => {
      config().speedInsights = '1'
      const router = useNuxtApp().$router
      await runPlugin()
      await hydrate()
      const guard = navigationHook.mock.calls[0]![0]
      guard(router.resolve('/games/no-such-game'), router.currentRoute.value, undefined)
      expect(setRoute).toHaveBeenLastCalledWith('/games/[slug]')
      // The page throws its 404 after the navigation has finished.
      useError().value = createError({ statusCode: 404 })
      await nextTick()
      expect(setRoute).toHaveBeenLastCalledWith('/404')
    })

    it('reports any other error as /error', async () => {
      config().speedInsights = '1'
      await runPlugin()
      await hydrate()
      useError().value = createError({ statusCode: 502 })
      await nextTick()
      expect(setRoute).toHaveBeenLastCalledWith('/error')
    })

    it('starts on /404 when the server already rendered the not-found page', async () => {
      config().speedInsights = '1'
      useError().value = createError({ statusCode: 404 })
      await runPlugin()
      await hydrate()
      expect(injectSpeedInsights).toHaveBeenCalledWith(
        expect.objectContaining({ route: '/404' }),
        undefined,
      )
    })
  })

  it.each([
    ['Do Not Track', 'doNotTrack', '1'],
    ['Global Privacy Control', 'globalPrivacyControl', true],
    ['Do Not Track the old way', 'doNotTrack', 'yes'],
  ])('loads nothing for a visitor sending %s', async (_, name, value) => {
    config().speedInsights = '1'
    setNavigator(name, value)
    await runPlugin()
    await hydrate()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
  })

  it('loads nothing for a browser that sends Do Not Track on window, not navigator', async () => {
    config().speedInsights = '1'
    Object.defineProperty(window, 'doNotTrack', { value: '1', configurable: true })
    await runPlugin()
    await hydrate()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
  })
})
