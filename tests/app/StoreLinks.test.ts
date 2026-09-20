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

  it('shows the Steam price and discount inline with the store name', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          {
            store: 'steam',
            url: 'https://store.steampowered.com/app/292030/',
            priceUah: 337,
            discountPercent: 75,
          },
        ],
      },
    })
    const link = wrapper.get('a')
    const text = link.text().replace(/\s+/g, ' ')
    expect(text).toContain('Steam')
    expect(text).toContain('337')
    expect(text).toContain('₴')
    expect(text).toContain('−75%')
  })

  it('shows the Steam price with no discount chip when there is no sale', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          {
            store: 'steam',
            url: 'https://store.steampowered.com/app/292030/',
            priceUah: 1349,
            discountPercent: 0,
          },
        ],
      },
    })
    const link = wrapper.get('a')
    const text = link.text().replace(/\s+/g, ' ')
    expect(text).toContain('Steam')
    expect(text).toContain('349')
    expect(text).toContain('₴')
    expect(text).not.toContain('%')
  })

  it('shows "Безкоштовно" for a free offer with an explicit isFree flag, not "0 ₴"', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          {
            store: 'steam',
            url: 'https://store.steampowered.com/app/292030/',
            priceUah: 0,
            discountPercent: null,
            isFree: true,
          },
        ],
      },
    })
    const link = wrapper.get('a')
    expect(link.text()).toContain('Безкоштовно')
    expect(link.text()).not.toContain('₴')
  })

  it('also treats a 0 ₴ offer as free when isFree is missing (older/partial data)', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          { store: 'steam', url: 'https://store.steampowered.com/app/292030/', priceUah: 0 },
        ],
      },
    })
    const link = wrapper.get('a')
    expect(link.text()).toContain('Безкоштовно')
    expect(link.text()).not.toContain('₴')
  })

  it('leaves a store link plain when it has no price (also true for every non-Steam store today)', async () => {
    const wrapper = await mountSuspended(StoreLinks, {
      props: {
        offers: [
          { store: 'steam', url: 'https://store.steampowered.com/app/292030/' },
          { store: 'gog', url: 'https://www.gog.com/x' },
        ],
      },
    })
    const links = wrapper.findAll('a')
    expect(links.map((link) => link.text())).toEqual(['Steam', 'GOG'])
  })
})
