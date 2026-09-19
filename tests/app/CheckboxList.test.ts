import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CheckboxList from '~/components/filters/CheckboxList.vue'

const options = [
  { value: 4, label: 'PC' },
  { value: 7, label: 'Nintendo Switch' },
]

describe('CheckboxList', () => {
  it('reflects the model as pressed toggle chips and emits the toggled list', async () => {
    const wrapper = await mountSuspended(CheckboxList, {
      props: { legend: 'Platform', options, modelValue: [4] },
    })
    const chips = wrapper.findAll('button')
    expect(chips[0]!.attributes('aria-pressed')).toBe('true')
    expect(chips[1]!.attributes('aria-pressed')).toBe('false')

    await chips[1]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[4, 7]])

    await chips[0]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[]])

    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Platform')
  })
})
