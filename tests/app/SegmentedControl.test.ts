import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SegmentedControl from '~/components/SegmentedControl.vue'

const options = [
  { value: 70, label: '70+' },
  { value: 80, label: '80+' },
  { value: 90, label: '90+' },
]

describe('SegmentedControl', () => {
  it('renders "any" plus the options as a radio group, with modelValue checked', async () => {
    const wrapper = await mountSuspended(SegmentedControl, {
      props: { legend: 'Metacritic', anyLabel: 'Any', options, modelValue: 80 },
    })
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios).toHaveLength(4)
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ])
    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('Metacritic')
  })

  it('selects "any" (undefined) on click', async () => {
    const wrapper = await mountSuspended(SegmentedControl, {
      props: { legend: 'Metacritic', anyLabel: 'Any', options, modelValue: 80 },
    })
    await wrapper.findAll('[role="radio"]')[0]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([undefined])
  })

  it('moves selection with the arrow keys, wrapping at the ends', async () => {
    const wrapper = await mountSuspended(SegmentedControl, {
      props: { legend: 'Metacritic', anyLabel: 'Any', options, modelValue: undefined },
    })
    const first = wrapper.findAll('[role="radio"]')[0]!
    await first.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([70])

    await first.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([90])

    await first.trigger('keydown', { key: 'End' })
    expect(wrapper.emitted('update:modelValue')![2]).toEqual([90])

    await first.trigger('keydown', { key: 'Home' })
    expect(wrapper.emitted('update:modelValue')![3]).toEqual([undefined])
  })
})
