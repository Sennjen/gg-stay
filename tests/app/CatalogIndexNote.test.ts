import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CatalogIndexNote from '~/components/CatalogIndexNote.vue'
import CatalogStaleBanner from '~/components/CatalogStaleBanner.vue'

const NOW = '2026-09-20T12:00:00.000Z'

describe('CatalogIndexNote', () => {
  it('says what the search covers, with the count in the mono face', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, { props: { now: NOW } })
    expect(wrapper.text()).toContain(
      'Пошук серед 3 000 найпопулярніших ігор — ціни й мови ми знаємо лише для них.',
    )
    expect(wrapper.get('.font-numeric').text()).toBe('3 000')
  })

  it('dates the prices from the timestamp and the passed-in now, never from a clock', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, {
      props: { now: NOW, updatedAt: '2026-09-20T07:00:00.000Z' },
    })
    expect(wrapper.get('[data-test="prices-updated"]').text()).toBe('Ціни оновлено 5 годин тому')
  })

  it('uses the Ukrainian singular for a one-hour-old price', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, {
      props: { now: NOW, updatedAt: '2026-09-20T11:00:00.000Z' },
    })
    expect(wrapper.get('[data-test="prices-updated"]').text()).toBe('Ціни оновлено 1 годину тому')
  })

  it('says "just now" rather than "0 hours ago"', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, {
      props: { now: NOW, updatedAt: '2026-09-20T11:50:00.000Z' },
    })
    expect(wrapper.get('[data-test="prices-updated"]').text()).toBe('Ціни оновлено щойно')
  })

  it('leaves the age line out when the answer carried no timestamp', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, { props: { now: NOW, updatedAt: null } })
    expect(wrapper.find('[data-test="prices-updated"]').exists()).toBe(false)
  })

  it('renders in English too', async () => {
    const wrapper = await mountSuspended(CatalogIndexNote, {
      props: { now: NOW, updatedAt: '2026-09-20T07:00:00.000Z' },
      route: '/en/games',
    })
    expect(wrapper.text()).toContain('Searching the 3,000 most popular games')
    expect(wrapper.get('[data-test="prices-updated"]').text()).toBe('Prices updated 5 hours ago')
  })
})

describe('CatalogStaleBanner', () => {
  it('explains that prices are withheld and that the price controls went with them', async () => {
    const wrapper = await mountSuspended(CatalogStaleBanner)
    expect(wrapper.text()).toContain('Ціни тимчасово не оновлюються')
    expect(wrapper.text()).toContain('фільтри й сортування за ціною зараз вимкнені')
  })
})
