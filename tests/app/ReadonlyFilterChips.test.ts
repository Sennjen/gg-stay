import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ReadonlyFilterChips from '~/components/ReadonlyFilterChips.vue'

/** `formatUah` joins the amount and the ₴ with a no-break space; compared as a plain one. */
const plain = (text: string) => text.replace(/\s+/g, ' ')
/** A chip's parts (the label, then the reason when there is one), read as one line. */
const parts = (chip: { element: Element }) =>
  plain(Array.from(chip.element.children, (part) => part.textContent ?? '').join(' ')).trim()

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

describe('ReadonlyFilterChips, for filters the answer could not apply', () => {
  it('strikes them through with the reason beside them in words, as the catalog does', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: {
        filter: { priceMaxUah: 300, ukrainianLocalisation: 'TEXT', developers: ['frogwares'] },
        genres: [],
        label: 'Фільтр',
        ignored: ['priceMaxUah', 'developers'],
        indexStale: true,
      },
    })
    const struck = wrapper.findAll('[data-test="ignored-chip"]')
    expect(struck.map(parts)).toEqual([
      'frogwares не застосовано: не працює разом із фільтрами ціни',
      'до 300 ₴ не застосовано: ціни тимчасово не оновлюються',
    ])
    for (const chip of struck) expect(chip.find('s').exists()).toBe(true)
    // The applied filter is a plain chip, and nothing anywhere is a control.
    expect(wrapper.findAll('li')).toHaveLength(3)
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('says the price data is unavailable when the index did not answer', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: {
        filter: { madeInUkraine: true },
        genres: [],
        label: 'Фільтр',
        ignored: ['madeInUkraine'],
      },
    })
    expect(parts(wrapper.get('[data-test="ignored-chip"]'))).toBe(
      'Зроблено в Україні не застосовано: дані про ціни зараз недоступні',
    )
  })
})

describe('ReadonlyFilterChips, for a whole question as the search', () => {
  // In fallback the whole question becomes the search chip: up to 100 characters that must wrap
  // inside a 375 px column rather than push the page sideways.
  const question =
    'хочу атмосферну гру з гарним сюжетом про подорож у часі для двох гравців на дивані ввечері'

  it('lets the chip wrap, clamped to two lines, with the whole question still its name', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: { filter: { search: question }, genres: [], label: 'Звичайний пошук:' },
    })
    const chip = wrapper.get('li')
    const label = chip.get('[data-test="chip-text"]')
    expect(label.classes()).toEqual(expect.arrayContaining(['line-clamp-2', 'min-w-0']))
    expect(chip.classes()).toEqual(expect.arrayContaining(['max-w-full', 'min-w-0']))
    // Nothing between the list and the text forbids a line break.
    for (
      let node: Element | null = label.element;
      node && node.tagName !== 'UL';
      node = node.parentElement
    ) {
      expect(node.className).not.toContain('whitespace-nowrap')
      expect(node.className).not.toContain('shrink-0')
    }
    // The clamp hides lines, not text: the full question is in the DOM and in the title.
    expect(label.text()).toBe(`«${question}»`)
    expect(label.attributes('title')).toBe(`«${question}»`)
  })

  it('keeps the short value chips on one line', async () => {
    const wrapper = await mountSuspended(ReadonlyFilterChips, {
      props: { filter: { priceMaxUah: 500 }, genres: [], label: 'Фільтр' },
    })
    expect(wrapper.get('li > *').classes()).toContain('whitespace-nowrap')
    expect(wrapper.find('[data-test="chip-text"]').exists()).toBe(false)
  })
})
