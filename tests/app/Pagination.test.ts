import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Pagination from '~/components/Pagination.vue'

describe('Pagination', () => {
  it('disables "previous" on the first page and emits the next page', async () => {
    const wrapper = await mountSuspended(Pagination, { props: { page: 1, hasNext: true } })
    const [prev, next] = wrapper.findAll('button')
    expect(prev!.attributes('disabled')).toBeDefined()
    await next!.trigger('click')
    expect(wrapper.emitted('change')).toEqual([[2]])
  })

  it('disables "next" on the last page and emits the previous page', async () => {
    const wrapper = await mountSuspended(Pagination, { props: { page: 3, hasNext: false } })
    const [prev, next] = wrapper.findAll('button')
    expect(next!.attributes('disabled')).toBeDefined()
    await prev!.trigger('click')
    expect(wrapper.emitted('change')).toEqual([[2]])
  })
})
