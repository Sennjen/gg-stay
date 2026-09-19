import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PlatformIcons from '~/components/PlatformIcons.vue'

describe('PlatformIcons', () => {
  it('renders one text label per family, in a labelled list', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX'] },
    })
    expect(wrapper.get('ul').attributes('aria-label')).toBe('Платформи')
    expect(wrapper.findAll('li')).toHaveLength(3)
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('ПК')
    expect(wrapper.text()).toContain('PlayStation')
    expect(wrapper.text()).toContain('Xbox')
  })

  it('keeps enum order and never shows OTHER', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['OTHER', 'NINTENDO', 'MOBILE'] },
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('Nintendo')
    expect(items[1]!.text()).toContain('Мобільні')
    expect(wrapper.text()).not.toContain('OTHER')
  })

  it('caps at the default of five labels and shows a mono "+N" overflow with a listing title', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO', 'MOBILE', 'PC'] },
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(6)
    const overflow = items.at(-1)!
    expect(overflow.text()).toContain('+1')
    expect(overflow.find('.font-numeric').text()).toBe('1')
    expect(overflow.attributes('title')).toBe('ПК')
    expect(overflow.find('[aria-label]').attributes('aria-label')).toBe('ПК')
  })

  it('accepts a lower max (as the catalog card passes) and truncates sooner', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO'], max: 3 },
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(4)
    expect(items.at(-1)!.text()).toContain('+1')
  })

  it('every label is plain visible text, so it is accessible without extra markup', async () => {
    const wrapper = await mountSuspended(PlatformIcons, { props: { families: ['PC'] } })
    expect(wrapper.find('.sr-only').exists()).toBe(false)
    expect(wrapper.text()).toContain('ПК')
  })

  it('never shrinks or wraps a label mid-word, so a narrow row clips whole labels, not letters', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO', 'MOBILE', 'PC'] },
    })
    for (const item of wrapper.findAll('li')) {
      expect(item.classes()).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']))
    }
  })

  describe('responsive mode (used by the catalog card)', () => {
    const fiveFamilies = ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO', 'MOBILE'] as const

    it('renders one <ul> per variant, each hidden from assistive technology', async () => {
      const wrapper = await mountSuspended(PlatformIcons, {
        props: { families: fiveFamilies, responsive: true },
      })
      const lists = wrapper.findAll('ul')
      expect(lists).toHaveLength(3)
      for (const list of lists) {
        expect(list.attributes('aria-hidden')).toBe('true')
      }
    })

    it('shows the right "+N" for each variant with five families (1, 2 and 3 labels shown)', async () => {
      const wrapper = await mountSuspended(PlatformIcons, {
        props: { families: fiveFamilies, responsive: true },
      })
      const lists = wrapper.findAll('ul')
      expect(lists[0]!.findAll('li')).toHaveLength(2) // 1 label + "+4"
      expect(lists[0]!.text()).toContain('+4')
      expect(lists[1]!.findAll('li')).toHaveLength(3) // 2 labels + "+3"
      expect(lists[1]!.text()).toContain('+3')
      expect(lists[2]!.findAll('li')).toHaveLength(4) // 3 labels + "+2"
      expect(lists[2]!.text()).toContain('+2')
    })

    it('never shows "+N" in any variant for a single-platform game', async () => {
      const wrapper = await mountSuspended(PlatformIcons, {
        props: { families: ['PC'], responsive: true },
      })
      for (const list of wrapper.findAll('ul')) {
        expect(list.text()).not.toContain('+')
        expect(list.findAll('li')).toHaveLength(1)
      }
    })

    it('exposes the full platform list once, for assistive technology, regardless of width', async () => {
      const wrapper = await mountSuspended(PlatformIcons, {
        props: { families: fiveFamilies, responsive: true },
      })
      const accessibleLabel = wrapper.find('.sr-only')
      expect(accessibleLabel.text()).toBe('Платформи: ПК, PlayStation, Xbox, Nintendo, Мобільні')
    })

    it('carries a distinct container-query class per variant, tied to the card meta block width', async () => {
      const wrapper = await mountSuspended(PlatformIcons, {
        props: { families: fiveFamilies, responsive: true },
      })
      const lists = wrapper.findAll('ul')
      expect(lists[0]!.classes()).toContain('@min-[200px]:hidden')
      expect(lists[1]!.classes()).toEqual(
        expect.arrayContaining(['hidden', '@min-[200px]:flex', '@min-[280px]:hidden']),
      )
      expect(lists[2]!.classes()).toEqual(expect.arrayContaining(['hidden', '@min-[280px]:flex']))
    })
  })
})
