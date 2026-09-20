import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import type { DOMWrapper } from '@vue/test-utils'
import PriceFilter, { OWN_AMOUNT_DEBOUNCE_MS } from '~/components/filters/PriceFilter.vue'

/**
 * The "Ціна" section: four ready-made choices and a hand-typed amount. Every control carries a
 * visible label — the number input included, which is why the test reads the label's own text
 * rather than an `aria-label`.
 */
describe('PriceFilter', () => {
  it('names the group and labels the own-amount input visibly', async () => {
    const wrapper = await mountSuspended(PriceFilter, { props: {} })
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Ціна')

    const input = wrapper.get('input')
    const label = wrapper.get(`label[for="${input.attributes('id')}"]`)
    expect(label.text()).toBe('Своя сума, ₴')
    expect(label.classes()).not.toContain('sr-only')
    expect(input.attributes('inputmode')).toBe('numeric')
    expect(input.attributes('min')).toBe('1')
  })

  it('offers free and the three hryvnia steps, with the hryvnia written by the formatter', async () => {
    const wrapper = await mountSuspended(PriceFilter, { props: {} })
    const labels = wrapper.findAll('[role="group"] button').map((button) => button.text())
    expect(labels).toEqual(['Безкоштовно', 'до 300 ₴', 'до 600 ₴', 'до 1 000 ₴'])
  })

  it('marks the chosen step pressed and clears it when it is pressed again', async () => {
    const wrapper = await mountSuspended(PriceFilter, { props: { priceMaxUah: 600 } })
    const buttons = wrapper.findAll('[role="group"] button')
    expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ])

    await buttons[2]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ priceMaxUah: undefined }])
  })

  it('choosing a price clears free, and choosing free clears the price', async () => {
    const priced = await mountSuspended(PriceFilter, { props: { free: true } })
    await priced.findAll('[role="group"] button')[1]!.trigger('click')
    expect(priced.emitted('change')![0]).toEqual([{ priceMaxUah: 300, free: undefined }])

    const free = await mountSuspended(PriceFilter, { props: { priceMaxUah: 300 } })
    await free.findAll('[role="group"] button')[0]!.trigger('click')
    expect(free.emitted('change')![0]).toEqual([{ free: true, priceMaxUah: undefined }])
  })

  it('pressing free again clears it', async () => {
    const wrapper = await mountSuspended(PriceFilter, { props: { free: true } })
    await wrapper.findAll('[role="group"] button')[0]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ free: undefined }])
  })

  it('shows the active amount in the input, whichever way it was set', async () => {
    const wrapper = await mountSuspended(PriceFilter, { props: { priceMaxUah: 450 } })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('450')

    await wrapper.setProps({ priceMaxUah: undefined })
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('')
  })

  describe('the own amount', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    async function type(wrapper: { get: (selector: string) => DOMWrapper }, value: string) {
      await wrapper.get('input').setValue(value)
      await nextTick()
    }

    it('waits for the typing to stop before it changes the filter', async () => {
      const wrapper = await mountSuspended(PriceFilter, { props: {} })
      await type(wrapper, '4')
      await type(wrapper, '45')
      await type(wrapper, '450')
      expect(wrapper.emitted('change')).toBeUndefined()

      vi.advanceTimersByTime(OWN_AMOUNT_DEBOUNCE_MS)
      expect(wrapper.emitted('change')![0]).toEqual([{ priceMaxUah: 450, free: undefined }])
      expect(wrapper.emitted('change')).toHaveLength(1)
    })

    it('clears the filter when the field is emptied', async () => {
      const wrapper = await mountSuspended(PriceFilter, { props: { priceMaxUah: 450 } })
      await type(wrapper, '')
      vi.advanceTimersByTime(OWN_AMOUNT_DEBOUNCE_MS)
      expect(wrapper.emitted('change')![0]).toEqual([{ priceMaxUah: undefined }])
    })

    it('ignores an amount outside 1…100 000 instead of writing it to the URL', async () => {
      const wrapper = await mountSuspended(PriceFilter, { props: {} })
      for (const value of ['0', '-3', '1000001']) {
        await type(wrapper, value)
        vi.advanceTimersByTime(OWN_AMOUNT_DEBOUNCE_MS)
      }
      expect(wrapper.emitted('change')).toBeUndefined()
    })

    it('does not echo the value back when the prop is what changed', async () => {
      const wrapper = await mountSuspended(PriceFilter, { props: {} })
      await wrapper.setProps({ priceMaxUah: 300 })
      vi.advanceTimersByTime(OWN_AMOUNT_DEBOUNCE_MS)
      expect(wrapper.emitted('change')).toBeUndefined()
    })
  })
})
