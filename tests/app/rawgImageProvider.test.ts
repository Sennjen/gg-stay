import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent } from 'vue'

/**
 * Verifies the custom `rawg` @nuxt/image provider end to end, through the
 * real Nuxt runtime: `useImage()` resolves the `rawg` provider registered in
 * nuxt.config.ts (image.providers.rawg -> app/providers/rawg.ts) and the
 * produced url must point at the CDN's resize path.
 */
describe('rawg image provider', () => {
  it('rewrites the resolved image url to the CDN resize path', async () => {
    const TestImage = defineComponent({
      setup() {
        const img = useImage()
        const url = img(
          'https://media.rawg.io/media/games/618/abc.jpg',
          { width: 300 },
          { provider: 'rawg' },
        )
        return { url }
      },
      template: `<div>{{ url }}</div>`,
    })
    const wrapper = await mountSuspended(TestImage)
    expect(wrapper.text()).toBe('https://media.rawg.io/media/resize/420/-/games/618/abc.jpg')
  })
})
