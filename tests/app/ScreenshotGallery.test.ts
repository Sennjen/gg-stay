import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import ScreenshotGallery from '~/components/ScreenshotGallery.vue'

const images = [
  { url: 'https://media.rawg.io/media/screenshots/1/full1.jpg', width: 1920, height: 1080 },
  { url: 'https://media.rawg.io/media/screenshots/2/full2.jpg', width: 1920, height: 1080 },
  { url: 'https://media.rawg.io/media/screenshots/3/full3.jpg', width: 1920, height: 1080 },
]

const manyImages = Array.from({ length: 13 }, (_, index) => ({
  url: `https://media.rawg.io/media/screenshots/${index}/full${index}.jpg`,
  width: 1920,
  height: 1080,
}))

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
function activeDot(dialog: ReturnType<VueWrapper['find']>) {
  return dialog.findAll('[aria-current="true"]')[0]!
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

  it('opens the lightbox on click, with a labelled dialog and one dot per screenshot', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toContain('The Witcher 3')

    const dots = dialog.findAll('[aria-label^="Скріншот"]')
    expect(dots).toHaveLength(3)
    expect(dots[0]!.attributes('aria-label')).toBe('Скріншот 1 з 3')
    expect(activeDot(dialog).text()).toBe('')
    expect(activeDot(dialog).attributes('aria-label')).toBe('Скріншот 1 з 3')
  })

  it('opens the lightbox on Enter and on Space', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })

    await wrapper.findAll('button')[1]!.trigger('keydown.enter')
    await waitForDialog(wrapper)
    expect(activeDot(wrapper.find('[role="dialog"]')).attributes('aria-label')).toBe(
      'Скріншот 2 з 3',
    )

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await waitForNoDialog(wrapper)

    await wrapper.findAll('button')[2]!.trigger('keydown.space')
    await waitForDialog(wrapper)
    expect(activeDot(wrapper.find('[role="dialog"]')).attributes('aria-label')).toBe(
      'Скріншот 3 з 3',
    )
  })

  it('navigates with the arrow keys and wraps at both ends', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const dialog = () => wrapper.find('[role="dialog"]')

    expect(activeDot(dialog()).attributes('aria-label')).toBe('Скріншот 1 з 3')

    await dialog().trigger('keydown', { key: 'ArrowLeft' })
    expect(activeDot(dialog()).attributes('aria-label')).toBe('Скріншот 3 з 3')

    await dialog().trigger('keydown', { key: 'ArrowRight' })
    await dialog().trigger('keydown', { key: 'ArrowRight' })
    expect(activeDot(dialog()).attributes('aria-label')).toBe('Скріншот 2 з 3')
  })

  it('jumps to a screenshot when its dot is clicked', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const dialog = wrapper.find('[role="dialog"]')

    const dots = dialog.findAll('[aria-label^="Скріншот"]')
    await dots[2]!.trigger('click')
    expect(activeDot(wrapper.find('[role="dialog"]')).attributes('aria-label')).toBe(
      'Скріншот 3 з 3',
    )
  })

  it('announces the current position in a visually hidden live region', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const live = wrapper.find('[aria-live="polite"]')
    expect(live.classes()).toContain('sr-only')
    expect(live.text()).toBe('1 з 3')

    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('[aria-live="polite"]').text()).toBe('2 з 3')
  })

  it('falls back to compact "n / total" text instead of dots above 12 screenshots', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images: manyImages, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const dialog = wrapper.find('[role="dialog"]')

    expect(dialog.findAll('[aria-label^="Скріншот"]')).toHaveLength(0)
    expect(dialog.find('.font-numeric').text()).toBe('1 / 13')
  })

  it('gives the arrows and close button a 44px hit area and accessible names', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const dialog = wrapper.find('[role="dialog"]')

    const prev = dialog.find('[aria-label="Попередній скріншот"]')
    const next = dialog.find('[aria-label="Наступний скріншот"]')
    expect(prev.classes()).toEqual(expect.arrayContaining(['h-11', 'w-11']))
    expect(next.classes()).toEqual(expect.arrayContaining(['h-11', 'w-11']))

    const closeButton = dialog
      .findAll('button')
      .find((button) => button.text().includes('Закрити'))!
    expect(closeButton.classes()).toEqual(expect.arrayContaining(['h-11', 'w-11']))
    expect(closeButton.find('.sr-only').text()).toBe('Закрити')
  })

  it('keeps the dots inside the Tab focus trap', async () => {
    const wrapper = await mountSuspended(ScreenshotGallery, {
      props: { images, title: 'The Witcher 3' },
      attachTo: document.body,
    })
    await wrapper.findAll('button')[0]!.trigger('click')
    await waitForDialog(wrapper)
    const dialog = wrapper.find('[role="dialog"]')

    const focusable = dialog.findAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    expect(focusable[focusable.length - 1]!.attributes('aria-label')).toBe('Скріншот 3 з 3')
    wrapper.unmount()
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

    const closeButton = wrapper
      .find('[role="dialog"]')
      .findAll('button')
      .find((button) => button.text().includes('Закрити'))!
    await closeButton.trigger('click')
    await waitForNoDialog(wrapper)
  })
})
