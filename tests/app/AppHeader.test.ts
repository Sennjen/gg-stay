import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppHeader from '~/components/AppHeader.vue'

// `mountSuspended` mounts with its own router, detached from any router
// driven via a top-level `useRouter()` (see the header comment of
// tests/app/useGameFilters.test.ts) — the route for the mounted component is
// set through the `route` mount option instead.

describe('AppHeader', () => {
  it('renders the logo, the catalog link, the locale switcher and a search link with an accessible name', async () => {
    const wrapper = await mountSuspended(AppHeader, { route: '/games' })

    expect(wrapper.get('a[href="/"]').text()).toContain('gg stay')
    expect(wrapper.get('a[href="/games"]').text()).toBe('Каталог')
    expect(wrapper.get('a[href="/en/games"]').text()).toBe('English')
    expect(wrapper.get('a[aria-label="Пошук ігор"]').exists()).toBe(true)
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
})
