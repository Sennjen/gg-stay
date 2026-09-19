import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HeroVideo from '~/components/HeroVideo.vue'

const CLIP_URL = 'https://media.rawg.io/media/movies/1/movie480.mp4'
const HLS_URL = 'https://video.akamai.steamstatic.com/store_trailers/1/hls_264_master.m3u8?t=123'

function mockMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mockCanPlayType(supportsNativeHls: boolean) {
  HTMLVideoElement.prototype.canPlayType = vi
    .fn()
    .mockImplementation((type: string) =>
      type === 'application/vnd.apple.mpegurl' && supportsNativeHls ? 'probably' : '',
    )
}

// A minimal fake of the hls.js public API: on()/trigger() lets tests fire MANIFEST_PARSED/ERROR
// the same way the real library would, without pulling in real HLS parsing or network I/O.
class FakeHls {
  static isSupportedResult = true
  static Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' } as const
  static isSupported = vi.fn(() => FakeHls.isSupportedResult)
  static instances: FakeHls[] = []

  levels = [{ height: 1080 }, { height: 720 }, { height: 480 }]
  autoLevelCapping = -1
  listeners = new Map<string, ((event: string, data: unknown) => void)[]>()
  loadSource = vi.fn()
  attachMedia = vi.fn()
  destroy = vi.fn()

  constructor() {
    FakeHls.instances.push(this)
  }

  on(event: string, cb: (event: string, data: unknown) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }

  trigger(event: string, data: unknown = {}) {
    for (const cb of this.listeners.get(event) ?? []) cb(event, data)
  }
}

vi.mock('hls.js/light', () => ({ default: FakeHls }))

beforeEach(() => {
  mockMatchMedia(false)
  mockCanPlayType(false)
  // happy-dom implements <video>.play()/.pause() as no-ops that don't reject, but we still want
  // to assert they were called without depending on that implementation detail.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  HTMLMediaElement.prototype.pause = vi.fn()
  FakeHls.instances = []
  FakeHls.isSupportedResult = true
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HeroVideo', () => {
  it('renders nothing without a clip URL', async () => {
    const wrapper = await mountSuspended(HeroVideo, { props: { clipUrl: '', paused: false } })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(wrapper.find('video').exists()).toBe(false)
  })

  it('renders nothing under prefers-reduced-motion', async () => {
    mockMatchMedia(true)
    const wrapper = await mountSuspended(HeroVideo, {
      props: { clipUrl: CLIP_URL, paused: false },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(wrapper.find('video').exists()).toBe(false)
  })

  it('renders the video (after going idle) with the toggle button', async () => {
    const wrapper = await mountSuspended(HeroVideo, {
      props: { clipUrl: CLIP_URL, paused: false },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const video = wrapper.get('video')
    expect(video.attributes('src')).toBe(CLIP_URL)
    expect(video.attributes('muted')).toBeDefined()
    expect(video.attributes('loop')).toBeDefined()
    expect(video.attributes('playsinline')).toBeDefined()
    expect(video.attributes('preload')).toBe('none')

    const button = wrapper.get('button')
    expect(button.attributes('aria-pressed')).toBe('false')
  })

  it('toggling the button emits update:paused and calls pause()/play() on the element', async () => {
    const wrapper = await mountSuspended(HeroVideo, {
      props: { clipUrl: CLIP_URL, paused: false },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:paused')?.[0]).toEqual([true])

    await wrapper.setProps({ paused: true })
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')

    await wrapper.setProps({ paused: false })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('cancels the deferred idle/timeout callback on unmount, so it never renders afterwards', async () => {
    // happy-dom has no requestIdleCallback, so the component falls back to setTimeout — assert
    // the fallback timer is cleared rather than left to fire after the component is gone.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const wrapper = await mountSuspended(HeroVideo, {
      props: { clipUrl: CLIP_URL, paused: false },
    })

    wrapper.unmount()
    expect(clearTimeoutSpy).toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(wrapper.find('video').exists()).toBe(false)
  })

  describe('HLS clips', () => {
    it('sets src directly and never imports hls.js when the browser supports HLS natively', async () => {
      mockCanPlayType(true)
      const wrapper = await mountSuspended(HeroVideo, {
        props: { clipUrl: HLS_URL, paused: false },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))

      const video = wrapper.get('video')
      expect(video.attributes('src')).toBe(HLS_URL)
      expect(FakeHls.instances).toHaveLength(0)
    })

    it('imports hls.js, attaches it, and caps the level at 720p when native HLS is unsupported', async () => {
      const wrapper = await mountSuspended(HeroVideo, {
        props: { clipUrl: HLS_URL, paused: false },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      await new Promise((resolve) => setTimeout(resolve, 0))

      // hls.js drives playback via its own API instead of the `src` attribute.
      const video = wrapper.get('video')
      expect(video.attributes('src')).toBeUndefined()

      expect(FakeHls.instances).toHaveLength(1)
      const instance = FakeHls.instances[0]!
      expect(instance.loadSource).toHaveBeenCalledWith(HLS_URL)
      expect(instance.attachMedia).toHaveBeenCalledWith(video.element)

      instance.trigger(FakeHls.Events.MANIFEST_PARSED)
      // levels: [1080, 720, 480] -> index 1 is the highest level at or under 720p.
      expect(instance.autoLevelCapping).toBe(1)
    })

    it('hides the video (poster stays) on a fatal hls.js error, and destroys the instance', async () => {
      const wrapper = await mountSuspended(HeroVideo, {
        props: { clipUrl: HLS_URL, paused: false },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const instance = FakeHls.instances[0]!
      instance.trigger(FakeHls.Events.ERROR, { fatal: true })
      await wrapper.vm.$nextTick()

      expect(wrapper.find('video').exists()).toBe(false)
      expect(instance.destroy).toHaveBeenCalled()
    })

    it('destroys the hls.js instance on unmount', async () => {
      const wrapper = await mountSuspended(HeroVideo, {
        props: { clipUrl: HLS_URL, paused: false },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const instance = FakeHls.instances[0]!
      wrapper.unmount()
      expect(instance.destroy).toHaveBeenCalled()
    })
  })

  it('mp4 clips are unaffected: src is set directly and hls.js is never imported', async () => {
    const wrapper = await mountSuspended(HeroVideo, { props: { clipUrl: CLIP_URL, paused: false } })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(wrapper.get('video').attributes('src')).toBe(CLIP_URL)
    expect(FakeHls.instances).toHaveLength(0)
  })
})
