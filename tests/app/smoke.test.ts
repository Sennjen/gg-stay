import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'

describe('home page', () => {
  it('renders the Ukrainian title by default', async () => {
    const wrapper = await mountSuspended(IndexPage)
    expect(wrapper.text()).toContain('каталог відеоігор')
  })
})
