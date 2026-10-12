import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PriceTag from '~/components/PriceTag.vue'

describe('PriceTag', () => {
  it('renders nothing when price is null', async () => {
    const wrapper = await mountSuspended(PriceTag, { props: { price: null } })
    expect(wrapper.find('[data-test="price"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('renders a regular price with no discount', async () => {
    const wrapper = await mountSuspended(PriceTag, {
      props: {
        price: {
          bestUah: 1349,
          regularUah: null,
          discountPercent: 0,
          isFree: false,
        },
      },
    })
    const el = wrapper.get('[data-test="price"]')
    expect(el.text().replace(/\s/g, ' ')).toBe('1 349 ₴')
    expect(wrapper.find('s').exists()).toBe(false)
  })

  it('renders a free game as a translated label, not a zero price', async () => {
    const wrapper = await mountSuspended(PriceTag, {
      props: {
        price: {
          bestUah: 0,
          regularUah: null,
          discountPercent: 0,
          isFree: true,
        },
      },
    })
    expect(wrapper.get('[data-test="price"]').text()).toBe('Безкоштовно')
    expect(wrapper.text()).not.toContain('₴')
  })

  it('renders a discount chip, the new price and the struck-through old price', async () => {
    const wrapper = await mountSuspended(PriceTag, {
      props: {
        price: {
          bestUah: 337,
          regularUah: 1349,
          discountPercent: 75,
          isFree: false,
        },
      },
    })
    const text = wrapper.get('[data-test="price"]').text().replace(/\s/g, ' ')
    expect(text).toContain('−75%')
    expect(text).toContain('337 ₴')
    expect(text).toContain('1 349 ₴')

    const old = wrapper.get('s')
    expect(old.text().replace(/\s/g, ' ')).toBe('1 349 ₴')
  })

  it('gives the struck-through old price an accessible "was" prefix for screen readers', async () => {
    const wrapper = await mountSuspended(PriceTag, {
      props: {
        price: {
          bestUah: 337,
          regularUah: 1349,
          discountPercent: 75,
          isFree: false,
        },
      },
    })
    const srOnly = wrapper.find('.sr-only')
    expect(srOnly.exists()).toBe(true)
    expect(srOnly.text()).toBe('було')
  })

  it('falls back to a plain price when discount is set but the regular price is missing', async () => {
    const wrapper = await mountSuspended(PriceTag, {
      props: {
        price: {
          bestUah: 337,
          regularUah: null,
          discountPercent: 75,
          isFree: false,
        },
      },
    })
    expect(wrapper.find('s').exists()).toBe(false)
    expect(wrapper.get('[data-test="price"]').text().replace(/\s/g, ' ')).toContain('337 ₴')
  })
})
