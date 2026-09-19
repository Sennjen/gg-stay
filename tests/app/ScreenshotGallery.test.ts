import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import ScreenshotGallery from '~/components/ScreenshotGallery.vue'

const images = [
  { url: 'https://media.rawg.io/media/screenshots/1/full1.jpg', width: 1920, height: 1080 },
  { url: 'https://media.rawg.io/media/screenshots/2/full2.jpg', width: 1920, height: 1080 },
  { url: 'https://media.rawg.io/media/screenshots/3/full3.jpg', width: 1920, height: 1080 },
]

// The lightbox is a lazily loaded chunk (`defineAsyncComponent`); its dynamic import resolves
// over a real macrotask the first time it runs, so wait for it instead of a single microtask flush.
function waitForDialog(wrapper: VueWrapper) {
  return vi.waitFor(() => {
    if (!wrapper.find('[role="dialog"]').exists()) throw new Error('dialog not open yet')
  })
}
function waitForNoDialog(wrapper: VueWrapper) {
  return vi.waitFor(() => {
    if (wrapper.find('[role="dialog"]').exists()) throw new Error('dialog still open')
  })
}

describe('ScreenshotGallery', () => {
  it('renders nothing when there are no images', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images: [], title: 'The Witcher 3' },
    })
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('renders one lazy thumbnail per image with an explicit-size, indexed alt text', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    const thumbnails = wrapper.findAll('img')
    expect(thumbnails).toHaveLength(3)
    expect(thumbnails[0]!.attributes('alt')).toBe('The Witcher 3 — скріншот 1')
    expect(thumbnails[1]!.attributes('alt')).toBe('The Witcher 3 — скріншот 2')
    expect(thumbnails[0]!.attributes('loading')).toBe('lazy')
    expect(thumbnails[0]!.attributes('width')).toBe('480')
    expect(thumbnails[0]!.attributes('height')).toBe('270')
  })

  it('has no dialog before a thumbnail is activated', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('opens the lightbox on click, with a labelled dialog and a mono counter', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toContain('The Witcher 3')
    expect(dialog.find('.font-numeric').text()).toBe('1 / 3')
  })

  it('opens the lightbox on Enter and on Space', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })

    await wrapper.findAll('button')[1]!.trigger('keydown.enter')
    await waitForDialog(wrapper)
    expect(wrapper.find('[role="dialog"]').find('.font-numeric').text()).toBe('2 / 3')

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await waitForNoDialog(wrapper)

    await wrapper.findAll('button')[2]!.trigger('keydown.space')
    await waitForDialog(wrapper)
    expect(wrapper.find('[role="dialog"]').find('.font-numeric').text()).toBe('3 / 3')
  })

  it('navigates with the arrow keys and wraps at both ends', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)

    const counter = () => wrapper.find('[role="dialog"]').find('.font-numeric').text()
    expect(counter()).toBe('1 / 3')

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(counter()).toBe('3 / 3')

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'ArrowRight' })
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'ArrowRight' })
    expect(counter()).toBe('2 / 3')
  })

  it('closes on Escape and returns focus to the thumbnail that opened it', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
      attachTo: document.body,
    })
    const thumbnail = wrapper.findAll('button')[1]!
    await thumbnail.trigger('click')
    await waitForDialog(wrapper)

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await waitForNoDialog(wrapper)

    expect(document.activeElement).toBe(thumbnail.element)
    wrapper.unmount()
  })

  it('closes on the close button', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)

    const closeButton = wrapper.findAll('button').find((button) => button.text() === 'Закрити')!
    await closeButton.trigger('click')
    await waitForNoDialog(wrapper)
  })
})
