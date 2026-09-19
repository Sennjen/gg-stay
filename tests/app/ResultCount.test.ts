import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ResultCount from '~/components/ResultCount.vue'

describe('ResultCount', () => {
  it('renders the count locale-grouped and is a polite live region', async () => {
    const wrapper = await mountSuspended(ResultCount, { props: { total: 900934 } })
    expect(wrapper.text()).not.toContain('900934')
    expect(wrapper.find('.font-numeric').text()).toBe('900 934')
    expect(wrapper.get('[aria-live="polite"]').exists()).toBe(true)
  })

  it('ticks briefly when the total changes, then settles', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await mountSuspended(ResultCount, { props: { total: 100 } })
      const numberEl = () => wrapper.find('.font-numeric')

      expect(numberEl().classes()).not.toContain('-translate-y-0.5')

      await wrapper.setProps({ total: 90 })
      expect(numberEl().classes()).toContain('-translate-y-0.5')

      vi.advanceTimersByTime(150)
      await nextTick()
      expect(numberEl().classes()).not.toContain('-translate-y-0.5')
    } finally {
      vi.useRealTimers()
    }
  })
})
