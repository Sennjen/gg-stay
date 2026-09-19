import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ViewToggle from '~/components/ViewToggle.vue'
import { useFiltersStore } from '~/stores/filters'

describe('ViewToggle', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
    // The filters store is a singleton for the test file; reset it so one test's
    // view-mode change can't leak into the next test's "fresh mount" assumptions.
    useFiltersStore().$reset()
  })

  it('the store defaults to grid, matching the server render and first client render', () => {
    const store = useFiltersStore()
    expect(store.viewMode).toBe('grid')
  })

  it('applies a stored "list" preference only after mount', async () => {
    localStorage.setItem('gg-stay:view-mode', 'list')
    const wrapper = await mountSuspended(ViewToggle)
    const [gridButton, listButton] = wrapper.findAll('button')
    expect(listButton!.attributes('aria-pressed')).toBe('true')
    expect(gridButton!.attributes('aria-pressed')).toBe('false')
  })

  it('clicking a button switches the mode and persists it', async () => {
    const wrapper = await mountSuspended(ViewToggle)
    const [gridButton, listButton] = wrapper.findAll('button')
    expect(gridButton!.attributes('aria-pressed')).toBe('true')

    await listButton!.trigger('click')
    expect(listButton!.attributes('aria-pressed')).toBe('true')
    expect(localStorage.getItem('gg-stay:view-mode')).toBe('list')
  })

  it('silently ignores a broken localStorage instead of throwing', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      await expect(mountSuspended(ViewToggle)).resolves.toBeTruthy()
    } finally {
      getItem.mockRestore()
    }
  })
})
