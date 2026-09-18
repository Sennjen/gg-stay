import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DefaultLayout from '~/layouts/default.vue'

describe('default layout', () => {
  it('shows navigation, the locale switcher and RAWG attribution', async () => {
    const wrapper = await mountSuspended(DefaultLayout, { slots: { default: () => 'page body' } })
    expect(wrapper.text()).toContain('page body')
    expect(wrapper.get('a[href="/games"]').text()).toBe('Каталог')
    expect(wrapper.get('a[href="/en"]').text()).toBe('English')
    const attribution = wrapper.get('footer a[href="https://rawg.io"]')
    expect(attribution.text()).toBe('RAWG')
    expect(attribution.attributes('rel')).toContain('noopener')
  })
})
