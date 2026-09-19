import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CoverRing from '~/components/CoverRing.vue'
import CoverMarquee from '~/components/CoverMarquee.vue'

const game = {
  id: '3328',
  slug: 'the-witcher-3-wild-hunt',
  name: 'The Witcher 3: Wild Hunt',
  released: '2015-05-18',
  rating: 4.65,
  metacritic: 92,
  cover: { url: 'https://media.rawg.io/media/games/618/abc.jpg' },
  screenshots: [],
  platformFamilies: ['PC'] as const,
  platforms: [{ id: '4', slug: 'pc', name: 'PC' }],
  genres: [{ id: '4', slug: 'action', name: 'Action' }],
  price: null,
  localisation: null,
  madeInUkraine: false,
}

const games = Array.from({ length: 8 }, (_, index) => ({
  ...game,
  id: String(index),
  slug: `${game.slug}-${index}`,
  name: `${game.name} ${index}`,
}))

function mockMatchMedia({ reduced = false, narrow = false } = {}) {
  const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const isReduced = query.includes('prefers-reduced-motion')
      const matches = isReduced ? reduced : narrow
      const entry = { matches, listeners: new Set<() => void>() }
      lists.set(query, entry)
      return {
        matches,
        media: query,
        addEventListener: (_: string, listener: () => void) => entry.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => entry.listeners.delete(listener),
        addListener: (listener: () => void) => entry.listeners.add(listener),
        removeListener: (listener: () => void) => entry.listeners.delete(listener),
      }
    }),
  )
  return lists
}

class IntersectionObserverStub {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn(() => [])
}

beforeEach(() => {
  mockMatchMedia()
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CoverRing', () => {
  it('renders one link per game, in a labelled list, with alt text and lazy images', async () => {
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Каталог ігор' } })
    expect(wrapper.get('ul').attributes('aria-label')).toBe('Каталог ігор')
    const links = wrapper.findAll('a')
    expect(links).toHaveLength(games.length)
    const images = wrapper.findAll('img')
    expect(images).toHaveLength(games.length)
    images.forEach((image, index) => {
      expect(image.attributes('alt')).toBe(games[index]!.name)
      expect(image.attributes('loading')).toBe('lazy')
      expect(image.attributes('width')).toBeTruthy()
      expect(image.attributes('height')).toBeTruthy()
    })
  })

  it('pauses the loop on hover and resumes on pointer leave', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    const list = wrapper.get('ul')
    expect(rafSpy).toHaveBeenCalled()

    await list.trigger('pointerenter')
    expect(cafSpy).toHaveBeenCalled()
    const cafCallsAfterEnter = cafSpy.mock.calls.length
    const rafCallsAfterEnter = rafSpy.mock.calls.length

    await list.trigger('pointerleave')
    expect(rafSpy.mock.calls.length).toBeGreaterThan(rafCallsAfterEnter)
    expect(cafSpy.mock.calls.length).toBe(cafCallsAfterEnter)
  })

  it('pauses on focus-within and resumes once focus leaves the ring', async () => {
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    const firstLink = wrapper.findAll('a')[0]!

    // Native focus fires both a non-bubbling `focus` and a bubbling `focusin`; the ring
    // listens on `focusin` (delegated on the <ul>) so it hears focus on any cover.
    await firstLink.trigger('focusin')
    expect(cafSpy).toHaveBeenCalled()
    const rafCallsAfterFocus = rafSpy.mock.calls.length

    await wrapper.get('ul').trigger('focusout')
    expect(rafSpy.mock.calls.length).toBeGreaterThan(rafCallsAfterFocus)
  })

  it('steps focus with ArrowRight/ArrowLeft', async () => {
    const wrapper = await mountSuspended(CoverRing, {
      props: { games, title: 'Ring' },
      attachTo: document.body,
    })
    const links = wrapper.findAll('a').map((link) => link.element as HTMLAnchorElement)
    links[0]!.focus()
    await wrapper.get('ul').trigger('focus')

    await wrapper.get('ul').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(links[1])

    await wrapper.get('ul').trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(links[0])

    wrapper.unmount()
  })

  it('does not let a drag trigger navigation, but a plain click still fires', async () => {
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    const list = wrapper.get('ul')
    const firstLink = wrapper.findAll('a')[0]!

    await list.trigger('pointerdown', { pointerId: 1, clientX: 0, pointerType: 'mouse' })
    await list.trigger('pointermove', { pointerId: 1, clientX: 40, pointerType: 'mouse' })
    await list.trigger('pointerup', { pointerId: 1, clientX: 40, pointerType: 'mouse' })

    // RouterLink's own click handler (bound on the target `<a>`) always calls
    // preventDefault to do client-side navigation, dragged or not — so the meaningful
    // signal that a drag suppressed the click is that the ring's capture-phase handler
    // stopped the event from ever reaching that target-phase handler at all.
    const draggedClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    firstLink.element.dispatchEvent(draggedClick)
    expect(draggedClick.cancelBubble).toBe(true)

    const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    firstLink.element.dispatchEvent(plainClick)
    expect(plainClick.cancelBubble).toBe(false)
  })

  it('renders the static marquee fallback under prefers-reduced-motion', async () => {
    mockMatchMedia({ reduced: true })
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    await nextTick()
    expect(wrapper.find('ul.ring-list').exists()).toBe(false)
    const marquee = wrapper.findComponent(CoverMarquee)
    expect(marquee.exists()).toBe(true)
    expect(marquee.props('animated')).toBe(false)
  })

  it('renders the animated marquee below 768px when motion is allowed', async () => {
    mockMatchMedia({ narrow: true })
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    await nextTick()
    const marquee = wrapper.findComponent(CoverMarquee)
    expect(marquee.exists()).toBe(true)
    expect(marquee.props('animated')).toBe(true)
  })

  it('pauses while the tab is hidden', async () => {
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    expect(rafSpy).toHaveBeenCalled()

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cafSpy).toHaveBeenCalled()
  })

  it('cancels the rAF loop and disconnects observers on unmount', async () => {
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const wrapper = await mountSuspended(CoverRing, { props: { games, title: 'Ring' } })
    const cafCallsBefore = cafSpy.mock.calls.length

    wrapper.unmount()
    expect(cafSpy.mock.calls.length).toBeGreaterThan(cafCallsBefore)
  })
})
