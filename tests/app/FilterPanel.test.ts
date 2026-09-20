import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FilterPanel from '~/components/FilterPanel.vue'
import type { CatalogFilter } from '~/utils/filterUrl'

const base = { genres: [{ slug: 'rpg', name: 'RPG' }], maxYear: 2028 }

function mount(filter: CatalogFilter = {}, indexStale = false) {
  return mountSuspended(FilterPanel, { props: { ...base, filter, indexStale } })
}

/** The heading button of every collapsible section, in the order the drawer lists them. */
function sectionTitles(wrapper: Awaited<ReturnType<typeof mount>>): string[] {
  return wrapper.findAll('button[aria-expanded]').map((button) => button.text().trim())
}

describe('FilterPanel: the index sections', () => {
  it('lists price, discount and Ukrainian localisation as collapsible sections', async () => {
    const wrapper = await mount()
    const titles = sectionTitles(wrapper)
    expect(titles).toContain('Ціна')
    expect(titles).toContain('Знижка')
    expect(titles).toContain('Українська локалізація')
  })

  it('keeps them collapsed until they hold a value, like every other section', async () => {
    const closed = await mount()
    const collapsed = closed
      .findAll('button[aria-expanded]')
      .filter((button) => ['Ціна', 'Знижка', 'Українська локалізація'].includes(button.text()))
    expect(collapsed.map((button) => button.attributes('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
    ])

    const open = await mount({
      priceMaxUah: 300,
      onSaleMinPercent: 50,
      ukrainianLocalisation: 'TEXT',
    })
    const expanded = open
      .findAll('button[aria-expanded]')
      .filter((button) => ['Ціна', 'Знижка', 'Українська локалізація'].includes(button.text()))
    expect(expanded.map((button) => button.attributes('aria-expanded'))).toEqual([
      'true',
      'true',
      'true',
    ])
  })

  it('offers "не важливо" beside the three localisation levels', async () => {
    const wrapper = await mount({ ukrainianLocalisation: 'AUDIO' })
    const group = wrapper.get('[role="radiogroup"][aria-label="Українська локалізація"]')
    const radios = group.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.text())).toEqual([
      'Не важливо',
      'Будь-яка',
      'Текст',
      'Озвучка',
    ])
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual([
      'false',
      'false',
      'false',
      'true',
    ])
  })

  it('passes the localisation level straight through as a filter patch', async () => {
    const wrapper = await mount()
    const radios = wrapper
      .get('[role="radiogroup"][aria-label="Українська локалізація"]')
      .findAll('[role="radio"]')
    await radios[2]!.trigger('click')
    expect(wrapper.emitted('change')![0]).toEqual([{ ukrainianLocalisation: 'TEXT' }])

    await radios[0]!.trigger('click')
    expect(wrapper.emitted('change')![1]).toEqual([{ ukrainianLocalisation: undefined }])
  })

  it('hides price and discount while the index reports stale prices, and keeps localisation', async () => {
    const wrapper = await mount({}, true)
    const titles = sectionTitles(wrapper)
    expect(titles).not.toContain('Ціна')
    expect(titles).not.toContain('Знижка')
    expect(titles).toContain('Українська локалізація')
  })
})
