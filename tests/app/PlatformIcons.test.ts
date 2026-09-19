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
})
