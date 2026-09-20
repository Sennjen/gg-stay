import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import LocalisationBadge from '~/components/LocalisationBadge.vue'

describe('LocalisationBadge', () => {
  it('renders nothing without a localisation prop', async () => {
    const wrapper = await mountSuspended(LocalisationBadge, { props: { localisation: null } })
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('renders nothing when neither text nor audio is true', async () => {
    const wrapper = await mountSuspended(LocalisationBadge, {
      props: { localisation: { text: false, audio: false } },
    })
    expect(wrapper.find('[data-test="localisation"]').exists()).toBe(false)
  })

  it('shows UA with no speaker glyph for text-only localisation', async () => {
    const wrapper = await mountSuspended(LocalisationBadge, {
      props: { localisation: { text: true, audio: false } },
    })
    const badge = wrapper.get('[data-test="localisation"]')
    expect(badge.text()).toBe('UA')
    expect(badge.find('svg').exists()).toBe(false)
    expect(badge.attributes('aria-label')).toBe('Українська: текст')
    expect(badge.attributes('title')).toBe('Українська: текст')
  })

  it('shows UA with a speaker glyph for audio localisation', async () => {
    const wrapper = await mountSuspended(LocalisationBadge, {
      props: { localisation: { text: true, audio: true } },
    })
    const badge = wrapper.get('[data-test="localisation"]')
    expect(badge.find('svg').exists()).toBe(true)
    expect(badge.find('svg').attributes('aria-hidden')).toBe('true')
    expect(badge.attributes('aria-label')).toBe('Українська: текст і озвучка')
    expect(badge.attributes('title')).toBe('Українська: текст і озвучка')
  })

  it('exposes a single accessible name, not separate fragments', async () => {
    const wrapper = await mountSuspended(LocalisationBadge, {
      props: { localisation: { text: true, audio: true } },
    })
    const badge = wrapper.get('[data-test="localisation"]')
    expect(badge.attributes('role')).toBe('img')
  })
})
