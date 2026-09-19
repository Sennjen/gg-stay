import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { readBody } from 'h3'
import HeaderSearch from '~/components/HeaderSearch.vue'

// `mountSuspended` mounts with its own router, detached from any router driven
// via a top-level `useRouter()` (see the header comment of
// tests/app/useGameFilters.test.ts). Navigation triggered from inside the
// mounted component is observed on the SAME instance via the component's own
// `route` binding (`wrapper.vm.route`, exposed because HeaderSearch uses
// `<script setup>`) — `wrapper.vm.$route` resolves to a different app.

function games(names: string[]) {
  return names.map((name, index) => ({
    id: String(index),
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    released: '2015-05-18',
    rating: 4,
    metacritic: 80,
    cover: null,
    platforms: [],
    genres: [],
    price: null,
    localisation: null,
    madeInUkraine: false,
  }))
}

function mockGamesEndpoint(names: string[]) {
  const calls: string[] = []
  registerEndpoint('/api/graphql', {
    method: 'POST',
    handler: async (event) => {
      const body = (await readBody(event)) as { variables: { filter: { search: string } } }
      calls.push(body.variables.filter.search)
      return { data: { games: { items: games(names) } } }
    },
  })
  return calls
}

async function typeAndSettle(input: DOMWrapper<Element>, value: string) {
  await input.setValue(value)
  await vi.advanceTimersByTimeAsync(250)
  await flushPromises()
}

describe('HeaderSearch', () => {
  // Fake timers are enabled only after `mountSuspended` resolves: Nuxt's own
  // async setup (i18n, router) relies on real timers/microtasks to settle,
  // and enabling fake timers beforehand hangs the mount indefinitely.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exposes ARIA combobox attributes', async () => {
    mockGamesEndpoint(['The Witcher 3'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')

    expect(input.attributes('aria-autocomplete')).toBe('list')
    expect(input.attributes('aria-expanded')).toBe('false')
    expect(input.attributes('aria-controls')).toBeTruthy()

    await typeAndSettle(input, 'witcher')

    expect(input.attributes('aria-expanded')).toBe('true')
    const listbox = wrapper.get(`#${input.attributes('aria-controls')}`)
    expect(listbox.attributes('role')).toBe('listbox')
    expect(wrapper.findAll('li[role="option"]').length).toBeGreaterThan(0)
  })

  it('shows a loading row, then result rows with a thumbnail, title and year', async () => {
    mockGamesEndpoint(['The Witcher 3'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')

    await input.setValue('witcher')
    expect(wrapper.text()).toContain('Завантаження')

    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(wrapper.text()).toContain('The Witcher 3')
    expect(wrapper.text()).toContain('2015')
    expect(wrapper.text()).toContain('Усі результати для «witcher»')
  })

  it('shows the empty row when the search has no matches', async () => {
    mockGamesEndpoint([])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    await typeAndSettle(wrapper.get('input[role="combobox"]'), 'zzz')

    expect(wrapper.text()).toContain('Нічого не знайдено')
  })

  it('shows a quiet error row without a stack trace when the request fails', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: () => {
        throw new Error('network down')
      },
    })
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    await typeAndSettle(wrapper.get('input[role="combobox"]'), 'zzz')

    expect(wrapper.text()).toContain('Не вдалося завантажити результати')
    expect(wrapper.text()).not.toContain('network down')
    expect(wrapper.text()).not.toContain('Error')
  })

  it('does not open the dropdown below the minimum length', async () => {
    mockGamesEndpoint(['The Witcher 3'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    await input.setValue('w')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(input.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('ul[role="listbox"]').exists()).toBe(false)
  })

  it('moves the highlight with ArrowDown/ArrowUp and wraps at both ends', async () => {
    mockGamesEndpoint(['Alpha', 'Beta'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    await typeAndSettle(input, 'a')
    await input.setValue('al')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    // Two suggestion rows + the "all results" row = 3 options.
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('li')[0]!.attributes('id'),
    )

    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('li')[1]!.attributes('id'),
    )

    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('li')[2]!.attributes('id'),
    )

    // Wraps back to the first option.
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('li')[0]!.attributes('id'),
    )

    // ArrowUp from the first option wraps to the last.
    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(input.attributes('aria-activedescendant')).toBe(
      wrapper.findAll('li')[2]!.attributes('id'),
    )
  })

  // Navigation itself is triggered with real timers: `router.push` here
  // performs a real Nuxt page navigation (the test app has real pages), which
  // never settles while fake timers are active. The dropdown/debounce state
  // leading up to it is still driven and asserted under fake timers above.

  it('Enter with no highlighted row navigates to the catalog search (uk)', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    await typeAndSettle(wrapper.get('input[role="combobox"]'), 'alpha')

    vi.useRealTimers()
    await wrapper.get('input[role="combobox"]').trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(wrapper.vm.route.fullPath).toBe('/games?search=alpha'))
  })

  it('Enter with no highlighted row navigates to the catalog search (en)', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/en/games' })
    vi.useFakeTimers()
    await typeAndSettle(wrapper.get('input[role="combobox"]'), 'alpha')

    vi.useRealTimers()
    await wrapper.get('input[role="combobox"]').trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(wrapper.vm.route.fullPath).toBe('/en/games?search=alpha'))
  })

  it('Enter on a highlighted row navigates to that game', async () => {
    mockGamesEndpoint(['The Witcher 3'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    await typeAndSettle(input, 'witcher')
    await input.trigger('keydown', { key: 'ArrowDown' })

    vi.useRealTimers()
    await input.trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(wrapper.vm.route.fullPath).toBe('/games/the-witcher-3'))
  })

  it('Escape closes the dropdown and keeps the text', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    await typeAndSettle(input, 'alpha')
    expect(input.attributes('aria-expanded')).toBe('true')

    await input.trigger('keydown', { key: 'Escape' })

    expect(input.attributes('aria-expanded')).toBe('false')
    expect((input.element as HTMLInputElement).value).toBe('alpha')
  })

  it('closes the dropdown on an outside click', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, {
      route: '/games',
      attachTo: document.body,
    })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    await typeAndSettle(input, 'alpha')
    expect(input.attributes('aria-expanded')).toBe('true')

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(input.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('prefills the term from the catalog route search param without opening the dropdown or fetching', async () => {
    const calls = mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games?search=witcher' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')

    expect((input.element as HTMLInputElement).value).toBe('witcher')
    expect(input.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('ul[role="listbox"]').exists()).toBe(false)

    // Give any accidental debounced fetch a chance to fire before asserting none did.
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(calls).toEqual([])
  })

  it('opens the dropdown and fetches once the user edits a pre-filled term', async () => {
    const calls = mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games?search=witcher' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')

    await typeAndSettle(input, 'witcher2')

    expect(input.attributes('aria-expanded')).toBe('true')
    expect(calls).toEqual(['witcher2'])
  })

  it('opens the dropdown and fetches for a pre-filled term on the first ArrowDown, without requiring a prior fetch', async () => {
    const calls = mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games?search=witcher' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')
    expect(input.attributes('aria-expanded')).toBe('false')

    await input.trigger('keydown', { key: 'ArrowDown' })

    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(input.attributes('aria-expanded')).toBe('true')
    expect(calls).toEqual(['witcher'])
  })

  it('focusing the input alone does not open the dropdown for a pre-filled term', async () => {
    const calls = mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, { route: '/games?search=witcher' })
    vi.useFakeTimers()
    const input = wrapper.get('input[role="combobox"]')

    await input.trigger('focus')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(input.attributes('aria-expanded')).toBe('false')
    expect(calls).toEqual([])
  })

  it('on mobile, Escape collapses the expanded input and returns focus to the toggle button', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, {
      route: '/games',
      attachTo: document.body,
    })
    vi.useFakeTimers()
    await wrapper.get('button[aria-label]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.mobileExpanded).toBe(true)

    const input = wrapper.get('input[role="combobox"]')
    await input.trigger('keydown', { key: 'Escape' })
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.mobileExpanded).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('button[aria-label]').element)
    wrapper.unmount()
  })

  it('on mobile, an outside click collapses the expanded input and returns focus to the toggle button', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, {
      route: '/games',
      attachTo: document.body,
    })
    vi.useFakeTimers()
    await wrapper.get('button[aria-label]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.mobileExpanded).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.mobileExpanded).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('button[aria-label]').element)
    wrapper.unmount()
  })

  it('collapses the expanded mobile input on a route change without stealing focus', async () => {
    mockGamesEndpoint(['Alpha'])
    const wrapper = await mountSuspended(HeaderSearch, {
      route: '/games',
      attachTo: document.body,
    })
    vi.useFakeTimers()
    await wrapper.get('button[aria-label]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.mobileExpanded).toBe(true)
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.focus()

    vi.useRealTimers()
    await wrapper.vm.router.push('/games/the-witcher-3')
    await flushPromises()

    expect(wrapper.vm.mobileExpanded).toBe(false)
    expect(document.activeElement).not.toBe(wrapper.get('button[aria-label]').element)
    wrapper.unmount()
  })
})
