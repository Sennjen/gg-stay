import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PlatformIcons from '~/components/PlatformIcons.vue'

describe('PlatformIcons', () => {
  it('renders one icon per family, in a labelled list', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX'] },
    })
    expect(wrapper.get('ul').attributes('aria-label')).toBe('Платформи')
    expect(wrapper.findAll('li')).toHaveLength(3)
    expect(wrapper.text()).toContain('ПК')
    expect(wrapper.text()).toContain('PlayStation')
    expect(wrapper.text()).toContain('Xbox')
  })

  it('keeps enum order and never shows OTHER', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['OTHER', 'NINTENDO', 'MOBILE'] },
    })
    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(wrapper.text()).not.toContain('OTHER')
  })

  it('caps at five icons and shows a mono "+N" overflow', async () => {
    const wrapper = await mountSuspended(PlatformIcons, {
      props: { families: ['PC', 'PLAYSTATION', 'XBOX', 'NINTENDO', 'MOBILE', 'PC'] },
    })
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(6)
    const overflow = items.at(-1)!
    expect(overflow.text()).toBe('+1')
    expect(overflow.find('.font-numeric').exists()).toBe(true)
  })

  it('gives each icon an accessible name', async () => {
    const wrapper = await mountSuspended(PlatformIcons, { props: { families: ['PC'] } })
    expect(wrapper.find('.sr-only').text()).toBe('ПК')
  })
})
