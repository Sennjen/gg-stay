import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FilterPanel from '~/components/FilterPanel.vue'
import { useFiltersStore } from '~/stores/filters'
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

describe('FilterPanel: made in Ukraine', () => {
  afterEach(() => {
    useFiltersStore().$reset()
  })

  function toggleOf(wrapper: Awaited<ReturnType<typeof mount>>) {
    return wrapper.get('[data-test="made-in-ukraine-toggle"]')
  }

  it('sits in its own "Походження" section, right after the localisation one', async () => {
    const titles = sectionTitles(await mount())
    expect(titles.indexOf('Походження')).toBe(titles.indexOf('Українська локалізація') + 1)
  })

  it('stays collapsed until it is on, like every other section', async () => {
    const heading = (wrapper: Awaited<ReturnType<typeof mount>>) =>
      wrapper.findAll('button[aria-expanded]').find((button) => button.text() === 'Походження')!
    expect(heading(await mount()).attributes('aria-expanded')).toBe('false')
    expect(heading(await mount({ madeInUkraine: true })).attributes('aria-expanded')).toBe('true')
  })

  it('is a pressed-or-not toggle that says what it does in words', async () => {
    const off = await mount()
    expect(toggleOf(off).text()).toBe('Зроблено в Україні')
    expect(toggleOf(off).attributes('aria-pressed')).toBe('false')
    expect(off.text()).toContain(
      // "(або працювала)": the list includes studios that have since closed.
      'Ігри студій, заснованих в Україні, де працює (або працювала) їхня основна команда.',
    )

    const on = await mount({ madeInUkraine: true })
    expect(toggleOf(on).attributes('aria-pressed')).toBe('true')
    expect(toggleOf(on).classes()).toContain('bg-accent')
  })

  it('turns the filter on, and off again', async () => {
    const off = await mount()
    await toggleOf(off).trigger('click')
    expect(off.emitted('change')![0]).toEqual([{ madeInUkraine: true }])

    const on = await mount({ madeInUkraine: true })
    await toggleOf(on).trigger('click')
    expect(on.emitted('change')![0]).toEqual([{ madeInUkraine: undefined }])
  })

  it('stays open under the pointer when it is switched off', async () => {
    // The section opened on its own because it held a value; switching the only control in it off
    // must not fold it away from under the pointer, so a second press turns it back on.
    const wrapper = await mount({ madeInUkraine: true })
    await toggleOf(wrapper).trigger('click')
    await wrapper.setProps({ filter: {} })
    const heading = wrapper
      .findAll('button[aria-expanded]')
      .find((button) => button.text() === 'Походження')!
    expect(heading.attributes('aria-expanded')).toBe('true')
    expect(toggleOf(wrapper).isVisible()).toBe(true)
  })

  it('stays while the prices are stale, because it does not depend on them', async () => {
    expect(sectionTitles(await mount({}, true))).toContain('Походження')
  })
})
