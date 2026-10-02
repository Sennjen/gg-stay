import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'

/**
 * `useAsk` must call the endpoint through `useRequestFetch()`. On the server that fetch forwards
 * the visitor's request headers (`x-forwarded-for` among them), so the endpoint's per-address rate
 * limit sees the visitor; a bare `$fetch` from the server render would put every visitor in one
 * shared bucket. (On the client `useRequestFetch()` is plain `$fetch`.) The SSR suite checks the
 * forwarding end to end; this pins the call site.
 */

const { requestFetch } = vi.hoisted(() => ({
  requestFetch: vi.fn(async () => ({
    mode: 'fallback',
    interpretation: null,
    filter: { search: 'co-op' },
    catalogUrl: '/games?search=co-op',
    items: [],
    tookMs: 1,
  })),
}))

mockNuxtImport('useRequestFetch', () => () => requestFetch)

const Host = defineComponent({
  async setup() {
    return await useAsk('co-op')
  },
  template: '<span />',
})

describe('useAsk', () => {
  it('asks through the request fetch, which forwards the visitor headers on the server', async () => {
    const wrapper = await mountSuspended(Host)
    await flushPromises()
    expect(requestFetch).toHaveBeenCalledWith('/api/ask', {
      method: 'POST',
      body: { q: 'co-op', locale: 'uk' },
    })
    wrapper.unmount()
  })
})
