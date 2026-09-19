import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import HeroVideo from '~/components/HeroVideo.vue'

const CLIP_URL = 'https://media.rawg.io/media/movies/1/movie480.mp4'

function mockMatchMedia(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  mockMatchMedia(false)
  // happy-dom implements <video>.play()/.pause() as no-ops that don't reject, but we still want
  // to assert they were called without depending on that implementation detail.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  HTMLMediaElement.prototype.pause = vi.fn()
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
})
