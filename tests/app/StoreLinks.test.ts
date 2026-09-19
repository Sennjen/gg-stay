import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import StoreLinks from '~/components/StoreLinks.vue'

describe('StoreLinks', () => {
  it('renders safe external links with store display names', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          { store: 'steam', url: 'https://store.steampowered.com/app/292030/' },
          { store: 'mystery-store', url: 'https://example.com/x' },
        ],
      },
    })
    const links = wrapper.findAll('a')
    expect(links.map((link) => link.text())).toEqual(['Steam', 'mystery-store'])
    expect(links[0]!.attributes('href')).toBe('https://store.steampowered.com/app/292030/')
    expect(links[0]!.attributes('rel')).toBe('noopener noreferrer')
    expect(links[0]!.attributes('target')).toBe('_blank')
  })

  it('renders nothing without offers', async () => {
    const wrapper = await mountSuspended(StoreLinks, { props: { offers: [] } })
    expect(wrapper.find('section').exists()).toBe(false)
  })
})
