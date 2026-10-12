import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppFooter from '~/components/AppFooter.vue'

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

    // RAWG for the games; Steam, GOG and the Microsoft Store for what they charge.
    expect(wrapper.get('footer').text()).toContain(
      'Дані про ігри надають RAWG, Steam, GOG і Microsoft Store.',
    )
    for (const [href, name] of [
      ['https://rawg.io', 'RAWG'],
      ['https://store.steampowered.com', 'Steam'],
      ['https://www.gog.com', 'GOG'],
      ['https://www.microsoft.com/store', 'Microsoft Store'],
    ]) {
      const link = wrapper.get(`footer a[href="${href}"]`)
      expect(link.text()).toBe(name)
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.attributes('target')).toBe('_blank')
    }
  })
})
