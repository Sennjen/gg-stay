import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MetacriticBadge from '~/components/MetacriticBadge.vue'

describe('MetacriticBadge', () => {
  it.each([
    [49, 'bad'],
    [50, 'mixed'],
    [74, 'mixed'],
    [75, 'good'],
    [100, 'good'],
  ])('scores %i in the %s band', async (score, band) => {
    const wrapper = await mountSuspended(MetacriticBadge, { props: { score } })
    expect(wrapper.attributes('data-band')).toBe(band)
  })

  it('shows the score in tabular mono numerals', async () => {
    const wrapper = await mountSuspended(MetacriticBadge, { props: { score: 92 } })
    expect(wrapper.text()).toContain('92')
    expect(wrapper.classes()).toContain('font-numeric')
  })

  it('exposes an accessible label with the score', async () => {
    const wrapper = await mountSuspended(MetacriticBadge, { props: { score: 92 } })
    expect(wrapper.attributes('aria-label')).toBe('Metacritic 92')
  })

  it('shows no visible caption by default (catalog card usage stays unchanged)', async () => {
    const wrapper = await mountSuspended(MetacriticBadge, { props: { score: 92 } })
    expect(wrapper.text()).toBe('92')
    expect(wrapper.attributes('data-band')).toBe('good')
  })

  it('shows a visible "Metacritic" caption before the chip when caption is set', async () => {
    const wrapper = await mountSuspended(MetacriticBadge, { props: { score: 92, caption: true } })
    expect(wrapper.text()).toContain('Metacritic')
    expect(wrapper.text()).toContain('92')
    expect(wrapper.find('[role="img"]').attributes('data-band')).toBe('good')
    expect(wrapper.find('[role="img"]').attributes('aria-label')).toBe('Metacritic 92')
  })
})
