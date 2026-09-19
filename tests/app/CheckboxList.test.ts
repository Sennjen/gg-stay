import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CheckboxList from '~/components/filters/CheckboxList.vue'

const options = [
  { value: 4, label: 'PC' },
  { value: 7, label: 'Nintendo Switch' },
]

describe('CheckboxList', () => {
  it('reflects the model and emits the toggled list', async () => {
    const wrapper = await mountSuspended(CheckboxList, {
      props: { legend: 'Platform', options, modelValue: [4] },
    })
    const boxes = wrapper.findAll('input[type="checkbox"]')
    expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true)
    await boxes[1]!.setValue(true)
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[4, 7]])
    await boxes[0]!.setValue(false)
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[]])
    expect(wrapper.get('legend').text()).toBe('Platform')
  })
})
