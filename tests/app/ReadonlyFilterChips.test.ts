import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReadonlyFilterChips from '~/components/ReadonlyFilterChips.vue'

/** `formatUah` joins the amount and the ₴ with a no-break space; compared as a plain one. */
const plain = (text: string) => text.replace(/\s+/g, ' ')

describe('ReadonlyFilterChips', () => {
  it('names each filter in the words the catalog chips use, as a labelled list', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: {
        filter: { gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500, genres: ['rpg'] },
        genres: [{ slug: 'rpg', name: 'Рольові' }],
        label: 'Фільтр каталогу',
      },
    })
    // The label is on screen, not only announced: a row of chips with no caption is a row whose
    // meaning a visitor would have to guess.
    const list = wrapper.get('ul')
    const label = wrapper.get(`#${list.attributes('aria-labelledby')}`)
    expect(label.text()).toBe('Фільтр каталогу')
    expect(label.classes()).not.toContain('sr-only')
    expect(wrapper.findAll('li').map((chip) => plain(chip.text()))).toEqual([
      'Рольові',
      'Nintendo Switch',
      'Локальний кооператив',
      'до 500 ₴',
    ])
  })

  it('offers nothing to press: these chips describe a filter, they do not edit one', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: { filter: { free: true, madeInUkraine: true }, genres: [], label: 'Фільтр' },
    })
    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('sets only the bare number in the numeral face', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: { filter: { priceMaxUah: 500, yearFrom: 2015 }, genres: [], label: 'Фільтр' },
    })
    const numerals = wrapper.findAll('.font-numeric').map((node) => plain(node.text()))
    expect(numerals).toEqual(['2015', '500 ₴'])
  })

  it('renders nothing for an empty filter', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: { filter: {}, genres: [], label: 'Фільтр' },
    })
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })
})
