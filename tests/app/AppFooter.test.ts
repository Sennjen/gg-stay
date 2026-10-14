import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { STORE_OPTIONS } from '#shared/catalog'
import AppFooter from '~/components/AppFooter.vue'

/**
 * A locale's footer messages as they are written in the file. Read from disk: the i18n module
 * compiles an imported locale file, and a compiled message is not the string it was.
 */
function footerMessages(locale: 'uk' | 'en'): Record<string, string> {
  const path = resolve(process.cwd(), `i18n/locales/${locale}.json`)
  return (JSON.parse(readFileSync(path, 'utf-8')) as { footer: Record<string, string> }).footer
}

describe('AppFooter', () => {
  it('shows the logo, description, nav links, GitHub, the locale switcher and the ownership line', async () => {
    const wrapper = await mountSuspended(AppFooter, { route: '/games' })

    expect(wrapper.get('footer a[href="/"]').text()).toContain('GG Stay')
    expect(wrapper.text()).toContain(
      'Ігри для українського гравця: зручні фільтри, українська мова інтерфейсу.',
    )

    const nav = wrapper.get('nav[aria-label="Підвал сайту"]')
    expect(nav.get('a[href="/games"]').text()).toBe('Каталог')

    const newReleases = nav.get('a[href="/games?sort=RELEASED_DESC"]')
    expect(newReleases.text()).toBe('Нові релізи')

    const github = wrapper.get('a[href="https://github.com/Sennjen/gg-stay"]')
    expect(github.text()).toContain('GitHub')
    expect(github.attributes('rel')).toContain('noopener')
    expect(github.attributes('target')).toBe('_blank')

    // Its own landmark name: the header carries a "Мова" navigation too, and two navigation
    // landmarks with one name are indistinguishable in a screen reader's landmark list.
    const language = wrapper.get('nav[aria-label="Мова сайту (внизу сторінки)"]')
    expect(language.get('a[href="/en/games"]').text()).toBe('English')
    expect(wrapper.find('nav[aria-label="Мова"]').exists()).toBe(false)

    expect(wrapper.get('footer').text()).toContain('Назви та зображення належать їхнім власникам.')
  })

  it('names every source of the site’s data, each as a link to the source itself', async () => {
    const wrapper = await mountSuspended(AppFooter, { route: '/games' })

    // RAWG for the games; Steam, GOG, the Xbox Store and the PlayStation Store for what they charge.
    expect(wrapper.get('footer').text()).toContain(
      'Дані про ігри надають RAWG, Steam, GOG, Xbox Store і PlayStation Store.',
    )
    for (const [href, name] of [
      ['https://rawg.io', 'RAWG'],
      ['https://store.steampowered.com', 'Steam'],
      ['https://www.gog.com', 'GOG'],
      ['https://www.xbox.com', 'Xbox Store'],
      ['https://store.playstation.com/uk-ua/', 'PlayStation Store'],
    ]) {
      const link = wrapper.get(`footer a[href="${href}"]`)
      expect(link.text()).toBe(name)
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.attributes('target')).toBe('_blank')
    }
  })

  it('names them the same way in English', async () => {
    const wrapper = await mountSuspended(AppFooter, { route: '/en/games' })
    expect(wrapper.get('footer').text()).toContain(
      'Game data provided by RAWG, Steam, GOG, Xbox Store and PlayStation Store.',
    )
    expect(wrapper.get('footer a[href="https://www.xbox.com"]').text()).toBe('Xbox Store')
  })

  /**
   * A store has one name on the site: the one the store filter and a game page's row take from
   * `STORE_OPTIONS`. The footer's names are in the locale files, so they are held to that table
   * here — "Xbox Store", and not the "Microsoft Store" its prices are read from.
   */
  it('calls each store by the name the store filter gives it, in both locales', () => {
    const nameOf = (slug: string) => STORE_OPTIONS.find((store) => store.slug === slug)!.name
    for (const locale of ['uk', 'en'] as const) {
      const footer = footerMessages(locale)
      expect(footer.steam).toBe(nameOf('steam'))
      expect(footer.gog).toBe(nameOf('gog'))
      expect(footer.xbox).toBe(nameOf('xbox-store'))
      expect(footer.playstation).toBe(nameOf('playstation-store'))
      expect(JSON.stringify(footer)).not.toContain('Microsoft')
    }
  })
})
