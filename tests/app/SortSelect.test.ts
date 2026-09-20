import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SortSelect from '~/components/SortSelect.vue'

describe('SortSelect', () => {
  it('offers the three price sorts beside the rest', async () => {
    const wrapper = await mountSuspended(SortSelect, { props: { modelValue: 'POPULARITY_DESC' } })
    const options = wrapper.findAll('option')
    expect(options.map((option) => option.attributes('value'))).toEqual([
      'POPULARITY_DESC',
      'RATING_DESC',
      'METACRITIC_DESC',
      'RELEASED_DESC',
      'RELEASED_ASC',
      'NAME_ASC',
      'PRICE_ASC',
      'PRICE_DESC',
      'DISCOUNT_DESC',
    ])
    expect(options.map((option) => option.text()).slice(-3)).toEqual([
      'Спочатку дешевші',
      'Спочатку дорожчі',
      'Найбільша знижка',
    ])
  })

  it('emits the chosen sort', async () => {
    const wrapper = await mountSuspended(SortSelect, { props: { modelValue: 'POPULARITY_DESC' } })
    await wrapper.get('select').setValue('DISCOUNT_DESC')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['DISCOUNT_DESC'])
  })

  it('drops the price sorts while the index reports stale prices', async () => {
    const wrapper = await mountSuspended(SortSelect, {
      props: { modelValue: 'NAME_ASC', indexStale: true },
    })
    const values = wrapper.findAll('option').map((option) => option.attributes('value'))
    expect(values).toEqual([
      'POPULARITY_DESC',
      'RATING_DESC',
      'METACRITIC_DESC',
      'RELEASED_DESC',
      'RELEASED_ASC',
      'NAME_ASC',
    ])
  })

  it('shows the order the server actually used when the chosen sort was dropped', async () => {
    const wrapper = await mountSuspended(SortSelect, {
      props: { modelValue: 'DISCOUNT_DESC', indexStale: true, ignored: true },
    })
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('POPULARITY_DESC')
  })

  it('says in words which sort was not applied, beside the select', async () => {
    const wrapper = await mountSuspended(SortSelect, {
      props: { modelValue: 'DISCOUNT_DESC', indexStale: true, ignored: true },
    })
    const note = wrapper.get('[data-test="sort-ignored"]')
    expect(note.text()).toBe('«Найбільша знижка» не застосовано')
  })

  it('has no note when the sort was applied', async () => {
    const wrapper = await mountSuspended(SortSelect, { props: { modelValue: 'PRICE_ASC' } })
    expect(wrapper.find('[data-test="sort-ignored"]').exists()).toBe(false)
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('PRICE_ASC')
  })
})
