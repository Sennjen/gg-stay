import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createError } from 'h3'
import { clearNuxtData } from '#app'
import GegeGreeter from '~/components/GegeGreeter.vue'
import GegeMascot from '~/components/GegeMascot.vue'

/**
 * The landing greeter against a stubbed BFF. The component teleports itself to `<body>`, so every
 * query here is made on the document, not on the wrapper.
 *
 * The clock: a test mounts with the tab reported hidden, so the component arms no timer on the
 * real clock; once the deal request has settled the test switches to fake timers and shows the
 * tab. From there the two seconds are counted on the fake clock, to the millisecond.
 */

const PORTAL = {
  id: '4200',
  slug: 'portal-2',
  name: 'Portal 2',
  cover: null,
  price: { bestUah: 1225, regularUah: 4900, discountPercent: 75 },
}

type DealAnswer = typeof PORTAL | { [K in keyof typeof PORTAL]: (typeof PORTAL)[K] | null } | null

let answer: DealAnswer = PORTAL
let fail = false
let requests = 0

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: () => {
    requests += 1
    if (fail) throw createError({ statusCode: 500, statusMessage: 'down' })
    return { data: { dealOfTheDay: answer } }
  },
})

let wrapper: VueWrapper | undefined
let visibility: 'visible' | 'hidden' = 'hidden'

const greeter = () => document.body.querySelector<HTMLElement>('[data-test="gege-greeter"]')
const bubble = () => document.body.querySelector<HTMLElement>('[data-test="gege-bubble"]')
const toggle = () => document.body.querySelector<HTMLButtonElement>('[data-test="gege-toggle"]')
const within = (selector: string) => bubble()?.querySelector<HTMLElement>(selector) ?? null
/**
 * The bubble's sentences as a reader gets them: one space wherever the markup breaks a line. The
 * no-break spaces inside a price are part of the copy and are kept.
 */
const lines = () =>
  [...(bubble()?.querySelectorAll('p') ?? [])].map((p) =>
    p.textContent!.replace(/[ \t\n]+/g, ' ').replace(/^ | $/g, ''),
  )

function showTab(state: 'visible' | 'hidden') {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Mounts behind a hidden tab and waits, on the real clock, for the deal request to settle. */
async function mountGreeter(route = '/') {
  visibility = 'hidden'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  wrapper = (await mountSuspended(GegeGreeter, { route })) as VueWrapper
  const settled = () => (wrapper!.vm as unknown as { dealSettled: boolean }).dealSettled
  const deadline = Date.now() + 5000
  while (!settled() && Date.now() < deadline) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(settled()).toBe(true)
  vi.useFakeTimers()
  return wrapper
}

/** Mounts, shows the tab and lets the two seconds pass: Gege is up with his bubble. */
async function mountRisen(route = '/') {
  const mounted = await mountGreeter(route)
  showTab('visible')
  await vi.advanceTimersByTimeAsync(2000)
  expect(bubble()).not.toBeNull()
  return mounted
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await flushPromises()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  clearNuxtData()
  answer = PORTAL
  fail = false
  requests = 0
})

describe('GegeGreeter', () => {
  describe('the rise', () => {
    it('renders nothing until the tab has been visible for two seconds', async () => {
      await mountGreeter()
      expect(greeter()).toBeNull()

      showTab('visible')
      await vi.advanceTimersByTimeAsync(1999)
      expect(greeter()).toBeNull()

      await vi.advanceTimersByTimeAsync(1)
      expect(greeter()?.dataset.phase).toBe('open')
      expect(bubble()).not.toBeNull()
      // He came up by himself, which is the only time the entrance is played.
      expect(greeter()!.classList.contains('gege-greeter--rose')).toBe(true)
    })

    it('counts nothing while the tab is hidden', async () => {
      await mountGreeter()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(greeter()).toBeNull()
    })

    it('starts the two seconds over when the tab is hidden part-way', async () => {
      await mountGreeter()
      showTab('visible')
      await vi.advanceTimersByTimeAsync(1500)
      showTab('hidden')
      await vi.advanceTimersByTimeAsync(5000)
      expect(greeter()).toBeNull()

      showTab('visible')
      await vi.advanceTimersByTimeAsync(1999)
      expect(greeter()).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(bubble()).not.toBeNull()
    })

    it('asks for the deal once', async () => {
      await mountRisen()
      expect(requests).toBe(1)
    })

    it('stops counting when the page is left', async () => {
      const mounted = await mountGreeter()
      showTab('visible')
      await vi.advanceTimersByTimeAsync(1000)
      mounted.unmount()
      wrapper = undefined
      await vi.advanceTimersByTimeAsync(5000)
      expect(greeter()).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('the bubble', () => {
    it('is a labelled, non-modal region that takes no focus and announces nothing', async () => {
      await mountRisen()
      const region = greeter()!
      expect(region.tagName).toBe('ASIDE')
      expect(region.getAttribute('aria-label')).toBe('Ґеґе, помічник із підбору ігор')
      expect(region.parentElement).toBe(document.body)
      expect(region.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull()
      expect(region.querySelector('[role="dialog"], [aria-modal]')).toBeNull()
      expect(region.contains(document.activeElement)).toBe(false)
    })

    it('names the deal, links it to its game page and states the price', async () => {
      await mountRisen()
      expect(lines()).toEqual([
        'Привіт, я Ґеґе! Сьогодні Portal 2 −75% за 1 225 ₴.',
        'Можу підібрати ще багато цікавих ігор — без довгого пошуку в каталозі.',
      ])
      const link = within('[data-test="gege-deal"] a')!
      expect(link.textContent).toBe('Portal 2')
      expect(link.getAttribute('href')).toBe('/games/portal-2')
    })

    it('offers «Давай», a link to the ask page, and «Не зараз», a button', async () => {
      await mountRisen()
      const accept = within('[data-test="gege-accept"]')!
      expect(accept.tagName).toBe('A')
      expect(accept.textContent!.trim()).toBe('Давай')
      expect(accept.getAttribute('href')).toBe('/ask')
      const decline = within('[data-test="gege-decline"]')!
      expect(decline.tagName).toBe('BUTTON')
      expect(decline.textContent!.trim()).toBe('Не зараз')
      expect(within('[data-test="gege-close"]')!.getAttribute('aria-label')).toBe('Закрити')
    })

    it('shows Gege peeking, and swaying only while the bubble is open', async () => {
      const mounted = await mountRisen()
      const mascot = mounted.findComponent(GegeMascot)
      expect(mascot.props()).toMatchObject({ mood: 'peek', animated: true })
      await click(within('[data-test="gege-decline"]'))
      expect(mascot.props()).toMatchObject({ mood: 'peek', animated: false })
    })

    it.each([
      ['there is no deal', () => (answer = null)],
      ['the deal has no price', () => (answer = { ...PORTAL, price: null })],
      [
        'the deal is not discounted',
        () => (answer = { ...PORTAL, price: { ...PORTAL.price, discountPercent: 0 } }),
      ],
      ['the request fails', () => (fail = true)],
    ])('only says hello when %s', async (_case, arrange) => {
      arrange()
      await mountRisen()
      expect(lines()).toEqual([
        'Привіт, я Ґеґе!',
        'Можу підібрати ще багато цікавих ігор — без довгого пошуку в каталозі.',
      ])
      expect(within('[data-test="gege-deal"]')).toBeNull()
      expect(within('[data-test="gege-accept"]')!.getAttribute('href')).toBe('/ask')
    })
  })

  describe('dismissal', () => {
    it.each([
      ['«Не зараз»', () => click(within('[data-test="gege-decline"]'))],
      ['the close control', () => click(within('[data-test="gege-close"]'))],
      ['a click on Gege himself', () => click(toggle())],
      [
        'Escape with focus inside',
        async () => {
          const decline = within('[data-test="gege-decline"]')!
          decline.focus()
          decline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await flushPromises()
        },
      ],
    ])('by %s leaves only the grip, a button that opens the bubble again', async (_way, act) => {
      await mountRisen()
      expect(toggle()!.getAttribute('aria-expanded')).toBe('true')

      await act()
      expect(bubble()).toBeNull()
      expect(greeter()!.dataset.phase).toBe('grip')
      const grip = toggle()!
      expect(grip.tagName).toBe('BUTTON')
      expect(grip.getAttribute('aria-label')).toBe('Ґеґе: AI-підбір')
      expect(grip.getAttribute('aria-expanded')).toBe('false')

      await click(grip)
      expect(greeter()!.dataset.phase).toBe('open')
      expect(lines()[0]).toContain('Portal 2')
      expect(toggle()!.getAttribute('aria-controls')).toBe(bubble()!.id)
    })

    it('hands focus to the grip when the control that had it goes away', async () => {
      await mountRisen()
      const decline = within('[data-test="gege-decline"]')!
      decline.focus()
      await click(decline)
      expect(document.activeElement).toBe(toggle())
    })

    it('leaves focus alone when it was somewhere else on the page', async () => {
      await mountRisen()
      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()
      within('[data-test="gege-decline"]')!.click()
      await flushPromises()
      expect(document.activeElement).toBe(outside)
      outside.remove()
    })

    it('ignores Escape pressed outside the greeter', async () => {
      await mountRisen()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
      expect(bubble()).not.toBeNull()
    })
  })

  describe('session memory', () => {
    it('does not rise by himself again in a session he was dismissed in', async () => {
      const first = await mountRisen()
      await click(within('[data-test="gege-decline"]'))
      first.unmount()
      vi.useRealTimers()
      clearNuxtData()

      await mountGreeter()
      // The grip is there at once, with no entrance, and the bubble stays shut however long the
      // tab is looked at.
      expect(greeter()!.dataset.phase).toBe('grip')
      expect(greeter()!.classList.contains('gege-greeter--rose')).toBe(false)
      showTab('visible')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(bubble()).toBeNull()

      await click(toggle())
      expect(lines()[0]).toBe('Привіт, я Ґеґе! Сьогодні Portal 2 −75% за 1 225 ₴.')
    })

    it('rises again in the next session', async () => {
      const first = await mountRisen()
      await click(within('[data-test="gege-decline"]'))
      first.unmount()
      vi.useRealTimers()
      clearNuxtData()
      window.sessionStorage.clear()

      await mountRisen()
      expect(greeter()!.dataset.phase).toBe('open')
    })

    it('behaves as on a first visit when storage refuses to be read or written', async () => {
      const denied = () => {
        throw new DOMException('denied', 'SecurityError')
      }
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied)

      await mountRisen()
      await click(within('[data-test="gege-decline"]'))
      expect(greeter()!.dataset.phase).toBe('grip')
      await click(toggle())
      expect(bubble()).not.toBeNull()
    })

    it('behaves as on a first visit when there is no storage at all', async () => {
      vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError')
      })
      await mountRisen()
      await click(within('[data-test="gege-close"]'))
      expect(greeter()!.dataset.phase).toBe('grip')
    })
  })

  // Last: the route decides the locale, and it stays switched for whatever mounts next.
  describe('in English', () => {
    it('greets, states the deal and links both ways under /en', async () => {
      await mountRisen('/en')
      expect(greeter()!.getAttribute('aria-label')).toBe('Gege, the game-picking helper')
      expect(toggle()!.getAttribute('aria-label')).toBe('Gege: AI picks')
      expect(lines()).toEqual([
        "Hi, I'm Gege! Today Portal 2 is −75% at 1,225 ₴.",
        'I can pick many more games for you — without a long search through the catalog.',
      ])
      expect(within('[data-test="gege-deal"] a')!.getAttribute('href')).toBe('/en/games/portal-2')
      expect(within('[data-test="gege-accept"]')!.getAttribute('href')).toBe('/en/ask')
      expect(within('[data-test="gege-decline"]')!.textContent!.trim()).toBe('Not now')
    })
  })
})
