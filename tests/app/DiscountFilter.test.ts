import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DiscountFilter from '~/components/filters/DiscountFilter.vue'

describe('DiscountFilter', () => {
  it('names the group and offers the three steps', async () => {
    const wrapper = await mountSuspended(DiscountFilter, { props: {} })
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Знижка')
    expect(wrapper.findAll('button').map((button) => button.text())).toEqual([
      'від 25 %',
      'від 50 %',
      'від 75 %',
    ])
  })

  it('is a single choice: picking one replaces the other', async () => {
    const wrapper = await mountSuspended(DiscountFilter, { props: { onSaleMinPercent: 25 } })
    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])

    await buttons[2]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ onSaleMinPercent: 75 }])
  })

  it('clicking the chosen step again clears it', async () => {
    const wrapper = await mountSuspended(DiscountFilter, { props: { onSaleMinPercent: 50 } })
    await wrapper.findAll('button')[1]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ onSaleMinPercent: undefined }])
  })

  it('shows a value that is not one of the steps as its own pressed chip', async () => {
    // `onSaleMinPercent=33` is a legitimate shared link: the section has to show it rather than
    // look empty while the filter is counted and applied.
    const wrapper = await mountSuspended(DiscountFilter, { props: { onSaleMinPercent: 33 } })
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(4)
    expect(buttons[3]!.text()).toBe('від 33 %')
    expect(buttons[3]!.attributes('aria-pressed')).toBe('true')
  })
})
