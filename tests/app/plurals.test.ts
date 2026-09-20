import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref, type WritableComputedRef } from 'vue'
import { readBody } from 'h3'
import FilterDrawer from '~/components/FilterDrawer.vue'
import GameScoreboard from '~/components/GameScoreboard.vue'
import HeaderSearch from '~/components/HeaderSearch.vue'
import { useFiltersStore } from '~/stores/filters'

/**
 * Counts that agree with a noun must go through plural forms, in both locales: Ukrainian has a
 * one/few/many rule (i18n/i18n.config.ts) and English a singular/plural one, and "1 результатів"
 * or "Show 1 games" is the kind of thing a visitor notices immediately. 21 is the interesting
 * Ukrainian case — it takes the *singular* form, unlike 11.
 *
 * These assertions are made against the RENDERED components, not against `t()` in isolation:
 * forgetting the plural selector at a call site is the actual failure mode, and a test that calls
 * `t(key, { count }, { plural: count })` itself proves only that the locale string is well formed.
 * Deleting `:plural` from `FilterDrawer`, `HeaderSearch` or `GameScoreboard` turns one of these red.
 */

const COUNTS = [1, 2, 5, 21] as const

/** The Ukrainian one/few/many forms, and the English singular/plural ones, per count. */
const EXPECTED = {
  drawer: {
    uk: { 1: 'Показати 1 гру', 2: 'Показати 2 гри', 5: 'Показати 5 ігор', 21: 'Показати 21 гру' },
    en: { 1: 'Show 1 game', 2: 'Show 2 games', 5: 'Show 5 games', 21: 'Show 21 games' },
  },
  search: {
    uk: { 1: '1 результат', 2: '2 результати', 5: '5 результатів', 21: '21 результат' },
    en: { 1: '1 result', 2: '2 results', 5: '5 results', 21: '21 results' },
  },
  ratings: {
    uk: { 1: '1 оцінка', 2: '2 оцінки', 5: '5 оцінок', 21: '21 оцінка' },
    en: { 1: '1 rating', 2: '2 ratings', 5: '5 ratings', 21: '21 ratings' },
  },
  priceUpdated: {
    uk: {
      1: 'оновлено 1 годину тому',
      2: 'оновлено 2 години тому',
      5: 'оновлено 5 годин тому',
      21: 'оновлено 21 годину тому',
    },
    en: {
      1: 'updated 1 hour ago',
      2: 'updated 2 hours ago',
      5: 'updated 5 hours ago',
      21: 'updated 21 hours ago',
    },
  },
} as const

/**
 * Switches the messages the components render with. `locale.value` rather than `setLocale()`:
 * `setLocale` also drives a route change, and `mountSuspended` mounts against a router detached
 * from the app's real one (see the header of tests/app/useGameFilters.test.ts), so the navigation
 * never settles. Only the messages matter here.
 */
const LocaleProbe = defineComponent({
  setup: () => ({ i18n: useI18n() }),
  template: '<span />',
})

type Composer = {
  locale: WritableComputedRef<string>
  setLocaleMessage: (locale: string, messages: Record<string, unknown>) => void
}

async function withComposer<T>(run: (i18n: Composer) => T): Promise<T> {
  const probe = await mountSuspended(LocaleProbe)
  const result = run((probe.vm as unknown as { i18n: Composer }).i18n)
  await nextTick()
  probe.unmount()
  return result
}

/**
 * Locale files are compiled to message-function ASTs by vue-i18n's build plugin when imported as
 * modules, so the English messages are read off disk as plain JSON and registered at runtime —
 * only the default locale's messages are present in this environment.
 */
beforeAll(async () => {
  const path = resolve(process.cwd(), 'i18n/locales/en.json')
  const messages = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  await withComposer((i18n) => i18n.setLocaleMessage('en', messages))
})

/**
 * Waits for the suggestion request to settle, once the debounce that gates it has already fired.
 * Nothing past that point (the dynamic `import()` that loads the graphql printer on demand,
 * the fetch itself) is driven by the component's own timers — but `vi.advanceTimersByTimeAsync(0)`
 * only fires timers already due on the FAKE clock, so if anything on that path (module transform,
 * fetch retry/backoff) ever schedules a real `setTimeout` with a nonzero delay, faking it freezes
 * that step forever: advancing "by 0" every turn never reaches it. That only bites under load,
 * which is exactly the flaky symptom. Real timers have no such ceiling, so switch to them here —
 * the debounce has already done its job — and poll on wall-clock time instead of a fixed turn
 * count.
 */
async function settleSuggestions(wrapper: { vm: object }) {
  const status = () => (wrapper.vm as { status: string }).status
  vi.useRealTimers()
  const deadline = Date.now() + 5000
  while (status() === 'loading' && Date.now() < deadline) {
    await flushPromises()
  }
}

async function switchLocale(locale: 'uk' | 'en') {
  await withComposer((i18n) => {
    i18n.locale.value = locale
  })
}

/** The catalog top bar's shape: a trigger outside the drawer, as in production. */
const DrawerHost = defineComponent({
  components: { FilterDrawer },
  props: { resultTotal: { type: Number, required: true } },
  setup() {
    const store = useFiltersStore()
    const triggerRef = ref<HTMLButtonElement>()
    return { store, triggerRef }
  },
  template: `
    <div>
      <button ref="triggerRef" type="button" @click="store.panelOpen = true">open</button>
      <FilterDrawer :result-total="resultTotal" :trigger-el="triggerRef" />
    </div>
  `,
})

afterEach(async () => {
  vi.useRealTimers()
  // The drawer only opens on a false -> true transition, and the store is a file-level singleton.
  useFiltersStore().$reset()
  document.body.style.overflow = ''
  await switchLocale('uk')
})

describe('plural forms at the call sites', () => {
  describe.each(['uk', 'en'] as const)('%s', (locale) => {
    it.each(COUNTS)('the filter drawer button reads correctly for %i', async (count) => {
      await switchLocale(locale)
      const host = await mountSuspended(DrawerHost, {
        props: { resultTotal: count },
        attachTo: document.body,
      })
      await host.get('button').trigger('click')
      await nextTick()

      // The drawer teleports to <body>, so read the document, not the wrapper's own subtree.
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog!.textContent).toContain(EXPECTED.drawer[locale][count])
      host.unmount()
    })

    it.each(COUNTS)('the search announcement reads correctly for %i', async (count) => {
      await switchLocale(locale)
      registerEndpoint('/api/graphql', {
        method: 'POST',
        handler: async (event) => {
          await readBody(event)
          return {
            data: {
              games: {
                items: Array.from({ length: count }, (_, index) => ({
                  id: String(index),
                  slug: `game-${index}`,
                  name: `Game ${index}`,
                  released: '2015-05-18',
                  metacritic: 80,
                  cover: null,
                  screenshots: [],
                  platformFamilies: [],
                })),
              },
            },
          }
        },
      })
      vi.useFakeTimers()
      const wrapper = await mountSuspended(HeaderSearch)
      await wrapper.get('input').setValue('witcher')
      // Only the debounce itself needs the fake clock, to fire it deterministically rather than
      // waiting out 250 real ms. `settleSuggestions` switches to real timers for everything after.
      await vi.advanceTimersByTimeAsync(250)
      await settleSuggestions(wrapper)

      const announcement = wrapper
        .findAll('[aria-live="polite"]')
        .map((node) => node.text())
        .join(' ')
      expect(announcement).toContain(EXPECTED.search[locale][count])
      wrapper.unmount()
    })

    it.each(COUNTS)('the scoreboard ratings count reads correctly for %i', async (count) => {
      await switchLocale(locale)
      const wrapper = await mountSuspended(GameScoreboard, {
        props: {
          game: {
            released: '2015-05-18',
            metacritic: 92,
            rating: 4.65,
            ratingsCount: count,
            platformFamilies: ['PC'] as const,
          },
        },
      })
      expect(wrapper.text()).toContain(EXPECTED.ratings[locale][count])
      wrapper.unmount()
    })

    it.each(COUNTS)(
      'the scoreboard "updated N hours ago" caption reads correctly for %i',
      async (count) => {
        await switchLocale(locale)
        const now = '2026-09-18T12:00:00.000Z'
        const updatedAt = new Date(Date.parse(now) - count * 3_600_000).toISOString()
        const wrapper = await mountSuspended(GameScoreboard, {
          props: {
            game: {
              released: null,
              metacritic: null,
              rating: null,
              ratingsCount: null,
              platformFamilies: [] as const,
              stores: [
                {
                  store: 'steam',
                  priceUah: 337,
                  regularPriceUah: 1349,
                  discountPercent: 75,
                  updatedAt,
                },
              ],
              localisation: null,
            },
            now,
          },
        })
        expect(wrapper.text()).toContain(EXPECTED.priceUpdated[locale][count])
        wrapper.unmount()
      },
    )
  })
})
