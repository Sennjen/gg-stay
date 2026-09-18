import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import EmptyState from '~/components/states/EmptyState.vue'
import ErrorState from '~/components/states/ErrorState.vue'
import LoadingState from '~/components/states/LoadingState.vue'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('LoadingState', () => {
  it('renders the requested number of skeletons and marks itself busy', async () => {
    const wrapper = await mountSuspended(LoadingState, { props: { count: 6 } })
    expect(wrapper.findAll('[data-test="skeleton"]')).toHaveLength(6)
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })
})

describe('EmptyState', () => {
  it('offers to clear filters only when some are active', async () => {
    const withFilters = await mountSuspended(EmptyState, { props: { activeCount: 2 } })
    await withFilters.get('button').trigger('click')
    expect(withFilters.emitted('clear')).toHaveLength(1)

    const without = await mountSuspended(EmptyState, { props: { activeCount: 0 } })
    expect(without.find('button').exists()).toBe(false)
    expect(without.text()).toContain('Нічого не знайдено')
  })
})

describe('ErrorState', () => {
  it('retries once automatically when rate limited', async () => {
    const wrapper = await mountSuspended(ErrorState, {
      props: { code: 'UPSTREAM_RATE_LIMITED', retryDelayMs: 20 },
    })
    expect(wrapper.text()).toContain('пробуємо ще раз')
    expect(wrapper.find('button').exists()).toBe(false)
    await wait(60)
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wait(60)
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('shows a manual retry button for other errors and never leaks details', async () => {
    const wrapper = await mountSuspended(ErrorState, { props: { code: 'UPSTREAM_TIMEOUT' } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.attributes('role')).toBe('alert')
  })

  it('falls back to the generic message for unknown codes', async () => {
    const wrapper = await mountSuspended(ErrorState, { props: { code: 'SOMETHING_ELSE' } })
    expect(wrapper.text()).toContain('Не вдалося отримати дані')
  })
})
