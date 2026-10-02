import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick } from 'vue'
import { readBody, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import { clearNuxtData } from '#app'
import AskPage from '~/pages/ask.vue'
import { askStubResponse } from '~~/tests/fixtures/askPage/stub'
import {
  BROKEN_QUERY,
  EMPTY_QUERY,
  FALLBACK_QUERY,
  LIKE_QUERY,
  MARKUP_QUERY,
  NOTHING_QUERY,
  PRICE_ONLY_QUERY,
  RATE_LIMITED_QUERY,
  STALE_QUERY,
  STRUCTURED_ANSWER,
  STRUCTURED_QUERY,
  UNRANKED_QUERY,
} from '~~/tests/fixtures/askPage/answers'

/**
 * The ask page against a recorded stand-in for `POST /api/ask` (`tests/fixtures/ask/stub.ts`):
 * every state the page can be in, reached the way a visitor reaches it — from a URL with `q`
 * (which is also what the server renders) or from the form.
 */

const requests: unknown[] = []

async function stub(event: H3Event) {
  const body = await readBody(event)
  requests.push(body)
  const response = askStubResponse(body)
  setResponseStatus(event, response.status)
  if (response.headers) setResponseHeaders(event, response.headers)
  return response.body
}

registerEndpoint('/api/ask', { method: 'POST', handler: stub })
/** What the catalog reports about the price index, as the page's freshness probe reads it. */
let indexStale = false

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: async (event) => {
    const body = (await readBody(event)) as { query: string }
    if (body.query.includes('AskIndexFreshness')) return { data: { games: { indexStale } } }
    return { data: { genres: [{ id: '5', slug: 'rpg', name: 'Рольові' }] } }
  },
})

const mounted: { unmount: () => void }[] = []

async function renderAsk(route: string) {
  const wrapper = await mountSuspended(AskPage, { route, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  await nextTick()
  return wrapper
}

const askUrl = (query: string) => `/ask?q=${encodeURIComponent(query)}`
const plain = (text: string) => text.replace(/\s+/g, ' ').trim()

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  requests.length = 0
  indexStale = false
  clearNuxtData()
})

describe('the ask page, idle', () => {
  it('has a heading, a labelled text field with a limit and a counter, and a submit button', async () => {
    const wrapper = await renderAsk('/ask')
    expect(wrapper.get('h1').text()).toBe('Опишіть гру словами')

    const field = wrapper.get('textarea')
    const label = wrapper.get(`label[for="${field.attributes('id')}"]`)
    expect(label.text()).toBe('Яку гру шукаєте?')
    expect(field.attributes('maxlength')).toBe('200')
    const counter = wrapper.get(`#${field.attributes('aria-describedby')!.split(' ')[0]}`)
    expect(plain(counter.text())).toBe('0 із 200 символів')

    expect(wrapper.get('button[type="submit"]').text()).toBe('Підібрати ігри')
  })

  it('offers the three example questions as buttons', async () => {
    const wrapper = await renderAsk('/ask')
    const examples = wrapper.get('[data-test="ask-examples"]')
    expect(examples.findAll('button').map((button) => button.text())).toEqual([
      'кооператив для двох на Switch до 500 грн',
      'атмосферний горор українською',
      'щось як Hades, але коротше',
    ])
  })

  it('sends nothing and shows no results until there is a question', async () => {
    const wrapper = await renderAsk('/ask')
    expect(requests).toEqual([])
    expect(wrapper.find('[data-test="ask-results"]').exists()).toBe(false)
  })

  it('counts the characters as they are typed', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('textarea').setValue('щось темне')
    expect(plain(wrapper.get('[data-test="ask-counter"]').text())).toBe('10 із 200 символів')
  })

  it('asks for a few words instead of sending an empty question', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(requests).toEqual([])
    const field = wrapper.get('textarea')
    expect(field.attributes('aria-invalid')).toBe('true')
    const message = wrapper.get('[data-test="ask-empty-question"]')
    expect(message.text()).toBe('Напишіть кілька слів про гру, яку шукаєте.')
    expect(field.attributes('aria-describedby')).toContain(message.attributes('id'))
    expect(document.activeElement).toBe(field.element)
  })
})

describe('the ask page, answered from the URL', () => {
  it('fills the field with the question and asks for it in the page locale', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(STRUCTURED_QUERY)
    expect(requests).toEqual([{ q: STRUCTURED_QUERY, locale: 'uk' }])
  })

  it('shows the interpretation, the understood filter and a link to it in the catalog', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const results = wrapper.get('[data-test="ask-results"]')
    expect(results.get('h2').text()).toBe('Результати')
    expect(results.get('[data-test="ask-interpretation"]').text()).toContain(
      'Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
    )
    const chips = results.get('[data-test="ask-filter"] ul')
    expect(plain(results.get('[data-test="ask-filter"]').text())).toMatch(/^Зрозумілий фільтр:/)
    expect(chips.findAll('li').map((chip) => plain(chip.text()))).toEqual([
      'Nintendo Switch',
      'Локальний кооператив',
      'до 500 ₴',
    ])
    const link = results.get('[data-test="ask-catalog-link"]')
    expect(link.text()).toBe('Відкрити в каталозі')
    expect(link.attributes('href')).toBe('/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500')
    expect(results.find('[data-test="ask-fallback-note"]').exists()).toBe(false)
  })

  it('lists the cards in order, each with the reason it fits under it', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const items = wrapper.findAll('[data-test="ask-item"]')
    expect(items.map((item) => item.get('[data-test="card-title"]').text())).toEqual([
      'Overcooked! 2',
      'It Takes Two',
      'Stardew Valley',
    ])
    expect(items.map((item) => plain(item.get('[data-test="ask-reason"]').text()))).toEqual(
      STRUCTURED_ANSWER.items.map((item) => `Чому підходить: ${item.reason}`),
    )
    // Under the results' own h2.
    expect(items[0]!.get('[data-test="card-title"]').element.tagName).toBe('H3')
  })

  it('says how many games it picked, visibly and in a live region', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect(plain(wrapper.get('[data-test="ask-count"]').text())).toBe('Підібрали 3 гри')
    const live = wrapper.get('[data-test="ask-live"]')
    expect(live.attributes('role')).toBe('status')
    expect(plain(live.text())).toBe('Підібрали 3 гри')
  })

  it('in fallback, says calmly that the AI part did not run and shows the plain search', async () => {
    const wrapper = await renderAsk(askUrl(FALLBACK_QUERY))
    const note = wrapper.get('[data-test="ask-fallback-note"]')
    expect(note.text()).toBe('ШІ-розбір зараз недоступний — показуємо звичайний пошук')
    expect(note.attributes('role')).toBeUndefined()
    expect(wrapper.find('[data-test="ask-interpretation"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="ask-reason"]').exists()).toBe(false)
    // Nothing was "understood" here: the filter is the plain search the question became.
    const filter = wrapper.get('[data-test="ask-filter"]')
    expect(filter.get('span').text()).toBe('Звичайний пошук:')
    expect(filter.findAll('li').map((chip) => chip.text())).toEqual([`«${FALLBACK_QUERY}»`])
    const href = new URL(
      wrapper.get('[data-test="ask-catalog-link"]').attributes('href')!,
      'http://site.test',
    )
    expect(href.pathname).toBe('/games')
    expect(Object.fromEntries(href.searchParams)).toEqual({ search: FALLBACK_QUERY })
    expect(plain(wrapper.get('[data-test="ask-live"]').text())).toBe(
      'ШІ-розбір зараз недоступний — показуємо звичайний пошук. Знайшли 2 гри',
    )
  })

  it('when nothing matched, says so and still offers the filter in the catalog', async () => {
    const wrapper = await renderAsk(askUrl(EMPTY_QUERY))
    const empty = wrapper.get('[data-test="ask-empty"]')
    expect(empty.text()).toContain('Нічого не підібрали')
    expect(empty.text()).toContain('Спробуйте описати інакше')
    expect(wrapper.find('[data-test="ask-item"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="ask-catalog-link"]').attributes('href')).toMatch(
      /^\/games\?search=/,
    )
    expect(plain(wrapper.get('[data-test="ask-live"]').text())).toBe('Нічого не підібрали')
  })

  it('when rate limited, explains when to try again', async () => {
    const wrapper = await renderAsk(askUrl(RATE_LIMITED_QUERY))
    const alert = wrapper.get('[data-test="ask-error"]')
    expect(alert.attributes('role')).toBe('alert')
    expect(plain(alert.text())).toContain(
      'Забагато запитів поспіль. Спробуйте ще раз за 42 секунди.',
    )
    expect(wrapper.find('[data-test="ask-item"]').exists()).toBe(false)
  })

  it('when the answer failed, offers to try again, and trying again asks again', async () => {
    const wrapper = await renderAsk(askUrl(BROKEN_QUERY))
    const alert = wrapper.get('[data-test="ask-error"]')
    expect(plain(alert.text())).toContain('Не вдалося підібрати ігри. Спробуйте ще раз.')
    expect(requests).toHaveLength(1)
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(requests).toHaveLength(2)
  })

  it('explains a question the endpoint refused as too long', async () => {
    const wrapper = await renderAsk(askUrl('а'.repeat(201)))
    expect(requests).toHaveLength(1)
    expect(plain(wrapper.get('[data-test="ask-error"]').text())).toContain(
      'Запит задовгий: щонайбільше 200 символів. Скоротіть його й спробуйте ще раз.',
    )
  })
})

describe('the ask page, answers the catalog could not fully apply', () => {
  it("strikes the declined filters through with the catalog's reason, and names a declined sort", async () => {
    indexStale = true
    const wrapper = await renderAsk(askUrl(STALE_QUERY))
    const filter = wrapper.get('[data-test="ask-filter"]')
    const struck = filter.findAll('[data-test="ignored-chip"]')
    expect(struck).toHaveLength(1)
    expect(plain(struck[0]!.get('s').text())).toBe('до 300 ₴')
    expect(struck[0]!.text()).toContain('не застосовано: ціни тимчасово не оновлюються')
    expect(plain(wrapper.get('[data-test="ask-sort-ignored"]').text())).toBe(
      '«Спочатку дешевші» не застосовано',
    )
    // The catalog's banner says what stale prices mean, as it does above the catalog's grid.
    expect(wrapper.get('[data-test="stale-banner"]').text()).toContain(
      'Ціни тимчасово не оновлюються',
    )
    // The link still opens the whole understood filter: the catalog strikes the same chips there.
    expect(wrapper.get('[data-test="ask-catalog-link"]').attributes('href')).toBe(
      '/games?priceMaxUah=300&ukrainianLocalisation=TEXT&sort=PRICE_ASC',
    )
  })

  it('reads the freshness from the catalog, not from the answer, when only a price was declined', async () => {
    indexStale = true
    const stale = await renderAsk(askUrl(PRICE_ONLY_QUERY))
    expect(stale.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: ціни тимчасово не оновлюються',
    )
    stale.unmount()
    clearNuxtData()

    indexStale = false
    const silent = await renderAsk(askUrl(PRICE_ONLY_QUERY))
    expect(silent.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: дані про ціни зараз недоступні',
    )
    expect(silent.find('[data-test="stale-banner"]').exists()).toBe(false)
  })

  it('marks nothing, and raises no banner, when everything was applied', async () => {
    indexStale = true
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect(wrapper.find('[data-test="stale-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ignored-chip"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ask-sort-ignored"]').exists()).toBe(false)
  })

  it('renders an unranked answer as cards alone: no reason lines, no empty elements', async () => {
    const wrapper = await renderAsk(askUrl(UNRANKED_QUERY))
    const items = wrapper.findAll('[data-test="ask-item"]')
    expect(items).toHaveLength(3)
    expect(wrapper.find('[data-test="ask-reason"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Чому підходить')
    for (const item of items) {
      expect(item.element.children).toHaveLength(1)
      expect(item.element.children[0]!.getAttribute('data-test')).toBe('game-card')
    }
    expect(plain(wrapper.get('[data-test="ask-count"]').text())).toBe('Підібрали 3 гри')
  })
})

describe('the ask page, answers with nothing the catalog can filter by', () => {
  it('offers no catalog link and no empty filter row for a "like X" answer', async () => {
    const wrapper = await renderAsk(askUrl(LIKE_QUERY))
    expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(3)
    // The link would open the whole catalog, which shows none of these games.
    expect(wrapper.find('[data-test="ask-catalog-link"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ask-filter-row"]').exists()).toBe(false)
  })

  it('does not send the visitor to a filter that does not exist when nothing matched', async () => {
    const wrapper = await renderAsk(askUrl(NOTHING_QUERY))
    const empty = wrapper.get('[data-test="ask-empty"]')
    expect(empty.findAll('p').map((line) => plain(line.text()))).toEqual([
      'Нічого не підібрали',
      'Спробуйте описати інакше — конкретніше або менш суворо.',
    ])
    expect(wrapper.find('[data-test="ask-catalog-link"]').exists()).toBe(false)
  })

  it('keeps the link, and the hint that points to it, when there is a filter to open', async () => {
    const wrapper = await renderAsk(askUrl(EMPTY_QUERY))
    expect(wrapper.get('[data-test="ask-empty"]').text()).toContain('відкрийте фільтр у каталозі')
    expect(wrapper.find('[data-test="ask-catalog-link"]').exists()).toBe(true)
  })
})

describe('the ask page, text written by the model', () => {
  it('shows markup in the interpretation and the reasons as text, never as markup', async () => {
    const wrapper = await renderAsk(askUrl(MARKUP_QUERY))
    expect(wrapper.get('[data-test="ask-interpretation"]').text()).toContain(
      '<b>жирно</b><script>alert("ask")</script>',
    )
    expect(wrapper.get('[data-test="ask-reason"]').text()).toContain('<img src=x onerror=alert(1)>')
    const results = wrapper.get('[data-test="ask-results"]').element
    expect(results.querySelector('b, script, img[src="x"]')).toBeNull()
  })

  it('renders them by text interpolation only: the page has no v-html', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/pages/ask.vue'), 'utf-8')
    expect(source).not.toMatch(/v-html|innerHTML/)
  })
})

/** The route the app's router is on: the page navigates it, so this is where `q` lands. */
const currentQuery = () => useRouter().currentRoute.value.query.q

/** Waits until the page has asked `count` questions in all and the answer has rendered. */
async function settle(check: () => void) {
  await vi.waitFor(check, { timeout: 2000, interval: 20 })
  await flushPromises()
  await nextTick()
}

describe('the ask page, asked from the form', () => {
  it('puts the trimmed question in the URL, answers it and moves focus to the results', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('textarea').setValue(`  ${STRUCTURED_QUERY} `)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(3))

    expect(currentQuery()).toBe(STRUCTURED_QUERY)
    expect(requests).toEqual([{ q: STRUCTURED_QUERY, locale: 'uk' }])
    await settle(() => expect(document.activeElement?.tagName).toBe('H2'))
    expect(document.activeElement?.textContent?.trim()).toBe('Результати')
  })

  it('asks an example question with one press', async () => {
    const wrapper = await renderAsk('/ask')
    const example = wrapper.get('[data-test="ask-examples"]').findAll('button')[2]!
    await example.trigger('click')
    await settle(() => expect(wrapper.find('[data-test="ask-fallback-note"]').exists()).toBe(true))

    expect(currentQuery()).toBe(FALLBACK_QUERY)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(FALLBACK_QUERY)
  })

  it('sends on Enter, and leaves Shift+Enter to break the line', async () => {
    const wrapper = await renderAsk('/ask')
    const field = wrapper.get('textarea')
    await field.setValue(STRUCTURED_QUERY)
    await field.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
    expect(requests).toEqual([])

    await field.trigger('keydown', { key: 'Enter' })
    await settle(() => expect(requests).toHaveLength(1))
  })

  it('asks the same question again when it is sent again', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect(requests).toHaveLength(1)
    // A first load from a link moves no focus: the visitor did not just ask anything.
    expect(document.activeElement?.tagName).not.toBe('H2')

    await wrapper.get('form').trigger('submit')
    await settle(() => expect(requests).toHaveLength(2))
    await settle(() => expect(document.activeElement?.tagName).toBe('H2'))
  })

  it('shows a busy skeleton while the answer is on its way', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerEndpoint('/api/ask', {
      method: 'POST',
      handler: async (event) => {
        await gate
        return stub(event)
      },
    })
    try {
      const wrapper = await renderAsk('/ask')
      await wrapper.get('textarea').setValue(STRUCTURED_QUERY)
      await wrapper.get('form').trigger('submit')
      await settle(() => expect(wrapper.find('[data-test="ask-loading"]').exists()).toBe(true))

      const results = wrapper.get('[data-test="ask-results"]')
      expect(results.attributes('aria-busy')).toBe('true')
      expect(results.findAll('[data-test="skeleton"]')).toHaveLength(3)
      expect(wrapper.get('[data-test="ask-live"]').text()).toBe('Підбираємо ігри…')

      release()
      await settle(() => expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(3))
      expect(wrapper.get('[data-test="ask-results"]').attributes('aria-busy')).toBeUndefined()
    } finally {
      release()
      registerEndpoint('/api/ask', { method: 'POST', handler: stub })
    }
  })
})
