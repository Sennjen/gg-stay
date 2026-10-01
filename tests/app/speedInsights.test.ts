import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import plugin from '~/plugins/speed-insights.client'
import { speedInsightsWanted, withoutQuery } from '~/utils/speedInsights'

const { injectSpeedInsights, ready } = vi.hoisted(() => ({
  injectSpeedInsights: vi.fn(),
  // The callbacks handed to `onNuxtReady`, run by the test when it says hydration has finished.
  ready: [] as (() => unknown)[],
}))

vi.mock('@vercel/speed-insights/nuxt/runtime', () => ({ injectSpeedInsights }))

mockNuxtImport('onNuxtReady', () => (callback: () => unknown) => {
  ready.push(callback)
})

/** A navigator with only the two privacy signals the loader reads. */
const signals = (doNotTrack: string | null = null, globalPrivacyControl?: boolean) => ({
  doNotTrack,
  globalPrivacyControl,
})

describe('speedInsightsWanted', () => {
  it('loads in a production build that opted in, for a visitor sending no privacy signal', () => {
    expect(speedInsightsWanted({ enabled: '1', dev: false, navigator: signals() })).toBe(true)
  })

  it.each([
    ['the flag is empty (every build that did not opt in)', { enabled: '' }],
    ['the flag is off', { enabled: '0' }],
    ['the flag is missing', { enabled: undefined }],
    ['the build is a development build', { dev: true }],
    ['the visitor sends Do Not Track', { navigator: signals('1') }],
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
    ready.length = 0
  })
  afterEach(() => {
    config().speedInsights = saved
    setNavigator('doNotTrack', null)
    setNavigator('globalPrivacyControl', undefined)
  })

  it('is off unless the deployment opts in', async () => {
    expect(saved).toBe('')
    await runPlugin()
    await hydrate()
    expect(ready).toEqual([])
    expect(injectSpeedInsights).not.toHaveBeenCalled()
  })

  it('injects the script once the app is ready, not while the plugin runs', async () => {
    config().speedInsights = '1'
    await runPlugin()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
    await hydrate()
    expect(injectSpeedInsights).toHaveBeenCalledTimes(1)
    expect(injectSpeedInsights).toHaveBeenCalledWith({ beforeSend: withoutQuery })
  })

  it.each([
    ['Do Not Track', 'doNotTrack', '1'],
    ['Global Privacy Control', 'globalPrivacyControl', true],
  ])('loads nothing for a visitor sending %s', async (_, name, value) => {
    config().speedInsights = '1'
    setNavigator(name, value)
    await runPlugin()
    await hydrate()
    expect(injectSpeedInsights).not.toHaveBeenCalled()
  })
})
