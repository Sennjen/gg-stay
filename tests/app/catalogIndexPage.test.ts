import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readBody } from 'h3'
import CatalogPage from '~/pages/games/index.vue'
import { useFiltersStore } from '~/stores/filters'

/**
 * The catalog page against a stubbed BFF: what the index's own answer fields turn into on screen.
 * The drawer is opened through the store, exactly as the top-bar trigger does it, because the
 * "Показати N ігор" button is the one place the index's total has to show up while filtering.
 */

interface GamesAnswer {
  total?: number
  indexedOnly?: boolean
  indexStale?: boolean
  indexUpdatedAt?: string | null
  ignoredFilters?: string[]
}

let answer: GamesAnswer = {}

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: async (event) => {
    const body = (await readBody(event)) as { query: string }
    if (body.query.includes('CatalogTaxonomies')) return { data: { genres: [] } }
    return {
      data: {
        games: {
          total: answer.total ?? 0,
          page: 1,
          pageSize: 20,
          indexedOnly: answer.indexedOnly ?? false,
          indexStale: answer.indexStale ?? false,
          indexUpdatedAt: answer.indexUpdatedAt ?? null,
          ignoredFilters: answer.ignoredFilters ?? [],
          items: [],
        },
      },
    }
  },
})

async function renderCatalog(route: string, next: GamesAnswer) {
  answer = next
  const wrapper = await mountSuspended(CatalogPage, { route })
  await flushPromises()
  await nextTick()
  return wrapper
}

afterEach(() => {
  useFiltersStore().$reset()
  answer = {}
})

describe('the catalog on the index path', () => {
  it('says what the search covers, and how old the prices are', async () => {
    const wrapper = await renderCatalog('/games?priceMaxUah=300', {
      total: 7,
      indexedOnly: true,
      indexUpdatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    })
    const note = wrapper.get('[data-test="index-note"]')
    expect(note.text()).toContain('Пошук серед 3 000 найпопулярніших ігор')
    expect(note.text()).toContain('Ціни оновлено 2 години тому')
  })

  it('says nothing about the index when RAWG answered', async () => {
    const wrapper = await renderCatalog('/games', { total: 7 })
    expect(wrapper.find('[data-test="index-note"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="stale-banner"]').exists()).toBe(false)
  })

  it('counts every index filter in the drawer badge and gives each one a chip', async () => {
    const wrapper = await renderCatalog(
      '/games?free=1&onSaleMinPercent=50&ukrainianLocalisation=TEXT',
      { total: 3, indexedOnly: true },
    )
    expect(wrapper.text()).toContain('Фільтри (3)')
    const chips = wrapper.findAll('button[aria-label^="Прибрати"]')
    expect(chips.map((chip) => chip.attributes('aria-label'))).toEqual([
      'Прибрати Безкоштовно',
      'Прибрати від 50 %',
      'Прибрати Українська: текст',
    ])
  })

  it('keeps the chip row when every filter on the page was declined, with no badge', async () => {
    const wrapper = await renderCatalog('/games?priceMaxUah=300', {
      total: 9,
      ignoredFilters: ['priceMaxUah'],
    })
    // Nothing is being applied, so there is no count to show — but the filter is in the URL, so
    // it must still be on screen and removable.
    expect(wrapper.text()).not.toContain('Фільтри (')
    expect(wrapper.text()).toContain('Фільтри')
    const struck = wrapper.findAll('[data-test="ignored-chip"]')
    expect(struck).toHaveLength(1)
    // Still removable: the chip carries its own remove control. (What the click then does to the
    // URL is `useGameFilters`' job and is pinned in its own suite — `mountSuspended` mounts
    // against a router detached from the app's real one, see tests/app/useGameFilters.test.ts.)
    expect(struck[0]!.get('button[aria-label]').attributes('aria-label')).toBe('Прибрати до 300 ₴')
  })

  it('offers the index total on the drawer button while an index filter is set', async () => {
    await renderCatalog('/games?free=1', { total: 12, indexedOnly: true })
    useFiltersStore().panelOpen = true
    await nextTick()
    await nextTick()
    expect(document.body.textContent).toContain('Показати 12 ігор')
  })

  describe('when the prices have gone stale', () => {
    it('raises the banner, hides the price sections and strikes the price chip through', async () => {
      const wrapper = await renderCatalog('/games?priceMaxUah=300&ukrainianLocalisation=TEXT', {
        total: 4,
        indexedOnly: true,
        indexStale: true,
        ignoredFilters: ['priceMaxUah'],
      })
      expect(wrapper.get('[data-test="stale-banner"]').text()).toContain(
        'Ціни тимчасово не оновлюються',
      )

      const struck = wrapper.findAll('[data-test="ignored-chip"]')
      expect(struck).toHaveLength(1)
      expect(struck[0]!.text()).toContain('не застосовано: ціни тимчасово не оновлюються')
      // Two filters in the URL, one of them declined: the badge counts the one that is actually
      // shaping the list, and the declined one stays on screen, struck through and removable.
      expect(wrapper.text()).toContain('Фільтри (1)')
      expect(wrapper.text()).not.toContain('Фільтри (2)')
      expect(struck[0]!.find('button[aria-label]').exists()).toBe(true)
      expect(wrapper.findAll('button[aria-label^="Прибрати"]')).toHaveLength(2)

      useFiltersStore().panelOpen = true
      await nextTick()
      await nextTick()
      const sections = Array.from(document.body.querySelectorAll('button[aria-expanded]')).map(
        (button) => button.textContent?.trim(),
      )
      expect(sections).not.toContain('Ціна')
      expect(sections).not.toContain('Знижка')
      expect(sections).toContain('Українська локалізація')
    })

    it('takes the price sorts off the select and names the one that was dropped', async () => {
      const wrapper = await renderCatalog('/games?sort=DISCOUNT_DESC', {
        total: 4,
        indexStale: true,
        ignoredFilters: ['sort'],
      })
      const values = wrapper.findAll('option').map((option) => option.attributes('value'))
      expect(values).not.toContain('DISCOUNT_DESC')
      expect(wrapper.get('[data-test="sort-ignored"]').text()).toBe(
        '«Найбільша знижка» не застосовано',
      )
    })
  })
})
