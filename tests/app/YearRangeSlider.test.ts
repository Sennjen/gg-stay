import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import YearRangeSlider from '~/components/YearRangeSlider.vue'

describe('YearRangeSlider', () => {
  it('emits nothing on drag ("input"), one patch on release ("change")', async () => {
    const wrapper = await mountSuspended(YearRangeSlider, {
      props: { minYear: 1970, maxYear: 2028 },
    })
    const fromRange = wrapper.find('input[type="range"]').element as HTMLInputElement

    // `wrapper.setValue()` fires both `input` and `change`; dispatch `input` on its own
    // to reproduce a mid-drag frame, which must not commit a filter change yet.
    fromRange.value = '2000'
    fromRange.dispatchEvent(new Event('input'))
    await nextTick()
    expect(wrapper.emitted('change')).toBeUndefined()

    fromRange.dispatchEvent(new Event('change'))
    await nextTick()
    expect(wrapper.emitted('change')).toEqual([[{ yearFrom: 2000, yearTo: undefined }]])
  })

  it('the "from" handle cannot cross past "to"', async () => {
    const wrapper = await mountSuspended(YearRangeSlider, {
      props: { yearFrom: 1990, yearTo: 2000, minYear: 1970, maxYear: 2028 },
    })
    const [fromRange] = wrapper.findAll('input[type="range"]')

    await fromRange!.setValue('2050')

    expect(wrapper.emitted('change')![0]).toEqual([{ yearFrom: 2000, yearTo: 2000 }])
  })

  it('the "to" handle cannot cross past "from"', async () => {
    const wrapper = await mountSuspended(YearRangeSlider, {
      props: { yearFrom: 1990, yearTo: 2000, minYear: 1970, maxYear: 2028 },
    })
    const [, toRange] = wrapper.findAll('input[type="range"]')

    await toRange!.setValue('1900')

    expect(wrapper.emitted('change')![0]).toEqual([{ yearFrom: 1990, yearTo: 1990 }])
  })

  it('disables both range inputs and number inputs when "upcoming" is set', async () => {
    const wrapper = await mountSuspended(YearRangeSlider, {
      props: { upcoming: true, minYear: 1970, maxYear: 2028 },
    })
    for (const input of wrapper.findAll('input[type="range"], input[type="number"]')) {
      expect(input.attributes('disabled')).toBeDefined()
    }
  })

  it('checking "upcoming" clears the year range', async () => {
    const wrapper = await mountSuspended(YearRangeSlider, {
      props: { yearFrom: 1990, yearTo: 2000, minYear: 1970, maxYear: 2028 },
    })
    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(wrapper.emitted('change')![0]).toEqual([
      { upcoming: true, yearFrom: undefined, yearTo: undefined },
    ])
  })
})
