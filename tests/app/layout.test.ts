import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DefaultLayout from '~/layouts/default.vue'

describe('default layout', () => {
  it('shows navigation, the locale switcher and RAWG + Steam attribution', async () => {
    const wrapper = await mountSuspended(DefaultLayout, { slots: { default: () => 'page body' } })
    expect(wrapper.text()).toContain('page body')
    expect(wrapper.get('header a[href="/games"]').text()).toBe('Каталог')
    expect(wrapper.get('footer a[href="/en"]').text()).toBe('English')
    expect(wrapper.get('footer').text()).toContain('Дані про ігри надають RAWG і Steam.')
    const rawgLink = wrapper.get('footer a[href="https://rawg.io"]')
    expect(rawgLink.text()).toBe('RAWG')
    expect(rawgLink.attributes('rel')).toContain('noopener')
    const steamLink = wrapper.get('footer a[href="https://store.steampowered.com"]')
    expect(steamLink.text()).toBe('Steam')
    expect(steamLink.attributes('rel')).toContain('noopener')
  })

  it('wraps the page body in the single main landmark the skip link targets', async () => {
    const wrapper = await mountSuspended(DefaultLayout, { slots: { default: () => 'page body' } })
    const mains = wrapper.findAll('main')
    expect(mains).toHaveLength(1)
    expect(mains[0]!.attributes('id')).toBe('main-content')
    expect(mains[0]!.text()).toContain('page body')
    expect(wrapper.get('a[href="#main-content"]').exists()).toBe(true)
  })
})
