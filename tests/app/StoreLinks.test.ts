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

  it('renders each store link as a pill button with a decorative external-link icon', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: { offers: [{ store: 'steam', url: 'https://store.steampowered.com/app/292030/' }] },
    })
    const link = wrapper.get('a')
    expect(link.classes()).toContain('rounded-chip')
    const icon = link.find('svg')
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('aria-hidden')).toBe('true')
  })

  it('drops an offer whose url is not http(s), even if one reaches the component', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          { store: 'steam', url: 'javascript:alert(1)' },
          { store: 'gog', url: 'https://www.gog.com/x' },
        ],
      },
    })
    const links = wrapper.findAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.attributes('href')).toBe('https://www.gog.com/x')
  })

  it('renders nothing when every offer url is unsafe', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: { offers: [{ store: 'steam', url: 'data:text/html,x' }] },
    })
    expect(wrapper.find('section').exists()).toBe(false)
  })

  it('renders nothing without offers', async () => {
    const wrapper = await mountSuspended(StoreLinks, { props: { offers: [] } })
    expect(wrapper.find('section').exists()).toBe(false)
  })
})
