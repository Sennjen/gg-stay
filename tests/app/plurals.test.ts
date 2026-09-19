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
 * Settles a component whose update depends on an awaited dynamic import (`printDocument` loads the
 * graphql printer on demand), which takes an unpredictable number of microtask turns the first
 * time it runs. Polls instead of guessing a fixed number of flushes.
 */
async function waitFor(condition: () => boolean, turns = 50) {
  for (let turn = 0; turn < turns; turn++) {
    if (condition()) return
    await flushPromises()
    await nextTick()
  }
  expect(condition(), 'condition never became true').toBe(true)
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
      await vi.advanceTimersByTimeAsync(250)
      await flushPromises()
      vi.useRealTimers()

      const announcement = () =>
        wrapper
          .findAll('[aria-live="polite"]')
          .map((node) => node.text())
          .join(' ')
      await waitFor(() => announcement().trim().length > 0)
      expect(announcement()).toContain(EXPECTED.search[locale][count])
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
  })
})
