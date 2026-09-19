import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent } from 'vue'

/**
 * Counts that agree with a noun must go through plural forms, in both locales: Ukrainian has a
 * one/few/many rule (i18n/i18n.config.ts) and English a singular/plural one, and "1 результатів"
 * or "Show 1 games" is the kind of thing a visitor notices immediately. 21 is the interesting
 * Ukrainian case — it takes the *singular* form, unlike 11.
 */
const Probe = defineComponent({
  setup() {
    const { t, setLocale } = useI18n()
    return { t, setLocale }
  },
  template: '<span />',
})

async function probe() {
  const wrapper = await mountSuspended(Probe)
  const vm = wrapper.vm as unknown as {
    t: (key: string, named: Record<string, unknown>, options: { plural: number }) => string
    setLocale: (code: 'uk' | 'en') => Promise<void>
  }
  return {
    async translate(locale: 'uk' | 'en', key: string, count: number) {
      await vm.setLocale(locale)
      return vm.t(key, { count }, { plural: count })
    },
  }
}

describe('plural forms', () => {
  const cases: [string, Record<number, string>, Record<number, string>][] = [
    [
      'search.resultsAnnouncement',
      {
        1: '1 результат',
        2: '2 результати',
        5: '5 результатів',
        21: '21 результат',
      },
      { 1: '1 result', 2: '2 results', 5: '5 results', 21: '21 results' },
    ],
    [
      'drawer.showResults',
      {
        1: 'Показати 1 гру',
        2: 'Показати 2 гри',
        5: 'Показати 5 ігор',
        21: 'Показати 21 гру',
      },
      { 1: 'Show 1 game', 2: 'Show 2 games', 5: 'Show 5 games', 21: 'Show 21 games' },
    ],
    [
      'game.ratingsCount',
      { 1: '1 оцінка', 2: '2 оцінки', 5: '5 оцінок', 21: '21 оцінка' },
      { 1: '1 rating', 2: '2 ratings', 5: '5 ratings', 21: '21 ratings' },
    ],
  ]

  it.each(cases)('%s', async (key, ukForms, enForms) => {
    const { translate } = await probe()
    for (const [count, expected] of Object.entries(ukForms)) {
      expect(await translate('uk', key, Number(count))).toBe(expected)
    }
    for (const [count, expected] of Object.entries(enForms)) {
      expect(await translate('en', key, Number(count))).toBe(expected)
    }
  })
})
