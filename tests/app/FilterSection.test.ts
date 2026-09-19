import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FilterSection from '~/components/FilterSection.vue'

describe('FilterSection', () => {
  it('starts closed and inactive, and toggles open on click', async () => {
    const wrapper = await mountSuspended(FilterSection, {
      props: { sectionId: 'platform', title: 'Platform' },
      slots: { default: '<p>content</p>' },
    })
    const button = wrapper.get('button')
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('click')
    expect(button.attributes('aria-expanded')).toBe('true')

    await button.trigger('click')
    expect(button.attributes('aria-expanded')).toBe('false')
  })

  it('starts open when it holds an active filter', async () => {
    const wrapper = await mountSuspended(FilterSection, {
      props: { sectionId: 'genre', title: 'Genre', active: true },
      slots: { default: '<p>content</p>' },
    })
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true')
  })

  it('remembers an explicit close even if the section becomes active again', async () => {
    const wrapper = await mountSuspended(FilterSection, {
      props: { sectionId: 'year', title: 'Year', active: true },
      slots: { default: '<p>content</p>' },
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')

    // Toggling `active` off and back on again must not override the explicit close.
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  })
})
