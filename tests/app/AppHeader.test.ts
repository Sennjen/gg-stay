import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import AppHeader from '~/components/AppHeader.vue'

// `mountSuspended` mounts with its own router, detached from any router
// driven via a top-level `useRouter()` (see the header comment of
// tests/app/useGameFilters.test.ts) — the route for the mounted component is
// set through the `route` mount option instead.

describe('AppHeader', () => {
  it('renders the logo, the catalog link, the locale switcher and the header search', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })

    expect(wrapper.get('a[href="/"]').text()).toContain('GG Stay')
    expect(wrapper.get('a[href="/games"]').text()).toBe('Каталог')
    expect(wrapper.get('nav[aria-label="Мова"] a[href="/en/games"]').text()).toBe('English')
    expect(wrapper.get('input[role="combobox"]').exists()).toBe(true)
  })

  it('links the ask page from the primary navigation, beside the catalog', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })
    const nav = wrapper.get('nav[aria-label="Основна навігація"]')
    expect(nav.findAll('a').map((link) => [link.text(), link.attributes('href')])).toEqual([
      ['Каталог', '/games'],
      ['AI-підбір', '/ask'],
    ])
  })

  it('puts a still, decorative 20 px Gege face before the ask link text', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })
    const link = wrapper.get('nav[aria-label="Основна навігація"] a[href="/ask"]')
    const face = link.get('svg')
    expect(face.attributes('width')).toBe('20')
    expect(face.attributes('aria-hidden')).toBe('true')
    expect(face.classes()).not.toContain('gege--animated')
    // The face comes first; the accessible name is the text, which the hidden drawing adds nothing to.
    expect(link.element.firstElementChild).toBe(face.element)
    expect(link.text()).toBe('AI-підбір')
  })

  it('names the ask link in English on the English site', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/en/games' })
    expect(wrapper.get('a[href="/en/ask"]').text()).toBe('AI picks')
  })

  it('gives the header bar a fixed height, shared via --header-h with sections that must run underneath it', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })

    const bar = wrapper.get('header > div')
    expect(bar.classes()).toContain('h-[var(--header-h)]')
  })

  it('renders the solid bar by default, on a non-landing route', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })

    const header = wrapper.get('header')
    expect(header.classes()).toContain('bg-surface-1/80')
    expect(header.classes()).not.toContain('bg-transparent')
  })

  it('renders the transparent bar on the landing route before any scroll', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/' })

    const header = wrapper.get('header')
    expect(header.classes()).toContain('bg-transparent')
  })

  it('switches to the solid bar once the landing route scrolls past the top', async () => {
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
    const wrapper = await mountSuspended(AppHeader, { route: '/' })
    expect(wrapper.get('header').classes()).toContain('bg-transparent')

    Object.defineProperty(window, 'scrollY', { value: 120, writable: true, configurable: true })
    window.dispatchEvent(new Event('scroll'))
    await nextTick()

    const header = wrapper.get('header')
    expect(header.classes()).toContain('bg-surface-1/80')
    expect(header.classes()).not.toContain('bg-transparent')
  })
})
