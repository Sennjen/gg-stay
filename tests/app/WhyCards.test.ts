import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import WhyCards from '~/components/WhyCards.vue'

// Locale files are compiled to message-function ASTs by vue-i18n's build plugin when imported
// as modules, so plain strings are read straight off disk instead (see the vue-i18n JSON loader
// note in `useFormatters`/other tests that import locale JSON structurally, not by value).
function readLocale(name: string) {
  const path = resolve(process.cwd(), `i18n/locales/${name}.json`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}
const uk = readLocale('uk')
const en = readLocale('en')

describe('WhyCards', () => {
  it('renders a display-face section title and exactly three cards', async () => {
    const wrapper = await mountSuspended(WhyCards)
    expect(wrapper.get('h2').classes()).toContain('font-display-heading')
    expect(wrapper.get('h2').text()).toBe(uk.why.title)
    expect(wrapper.findAll('article')).toHaveLength(3)
  })

  it('shows a title and one-sentence description per card, from the uk locale', async () => {
    const wrapper = await mountSuspended(WhyCards)
    const text = wrapper.text()
    for (const card of Object.values(uk.why.cards)) {
      expect(text).toContain(card.title)
      expect(text).toContain(card.description)
    }
  })

  it('renders every card in both locales (parity check via the en fixture)', () => {
    expect(Object.keys(en.why.cards).sort()).toEqual(Object.keys(uk.why.cards).sort())
  })

  it('gives each card a hand-written inline svg icon, hidden from assistive tech', async () => {
    const wrapper = await mountSuspended(WhyCards)
    const icons = wrapper.findAll('svg')
    expect(icons).toHaveLength(3)
    for (const icon of icons) {
      expect(icon.attributes('aria-hidden')).toBe('true')
    }
  })
})
