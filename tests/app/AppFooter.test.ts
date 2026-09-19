import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppFooter from '~/components/AppFooter.vue'

describe('AppFooter', () => {
  it('shows the logo, description, nav links, GitHub, the locale switcher and attribution', async () => {
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

    expect(wrapper.get('a[href="/en/games"]').text()).toBe('English')

    expect(wrapper.get('footer').text()).toContain('Дані про ігри надають RAWG і Steam.')
    const rawgLink = wrapper.get('footer a[href="https://rawg.io"]')
    expect(rawgLink.text()).toBe('RAWG')
    expect(rawgLink.attributes('rel')).toContain('noopener')
    const steamLink = wrapper.get('footer a[href="https://store.steampowered.com"]')
    expect(steamLink.text()).toBe('Steam')
    expect(steamLink.attributes('rel')).toContain('noopener')
    expect(wrapper.get('footer').text()).toContain('Назви та зображення належать їхнім власникам.')
  })
})
