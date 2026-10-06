import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick } from 'vue'
import { readBody, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import { clearNuxtData } from '#app'
import AskPage from '~/pages/ask.vue'
import { forgetAskAnswers } from '~/composables/useAsk'
import { askStubResponse } from '~~/tests/fixtures/askPage/stub'
import {
  BROKEN_QUERY,
  EMPTY_QUERY,
  FALLBACK_QUERY,
  FULL_QUERY,
  LIKE_QUERY,
  MARKUP_QUERY,
  NOTHING_QUERY,
  PRICE_ONLY_QUERY,
  PRICE_ONLY_SILENT_QUERY,
  RATE_LIMITED_QUERY,
  STALE_QUERY,
  STRUCTURED_ANSWER,
  STRUCTURED_QUERY,
  UNRANKED_QUERY,
} from '~~/tests/fixtures/askPage/answers'

/**
 * The ask page against a recorded stand-in for `POST /api/ask` (`tests/fixtures/askPage/stub.ts`):
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
/** Every GraphQL document the page sent, so a test can tell which ones a render needs. */
const graphql: string[] = []

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: async (event) => {
    const body = (await readBody(event)) as { query: string }
    graphql.push(body.query)
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
  vi.useRealTimers()
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  requests.length = 0
  graphql.length = 0
  forgetAskAnswers()
  clearNuxtData()
})

describe('the ask page, idle', () => {
  it('has a heading, a labelled text field with a limit and a counter, and a submit button', async () => {
    const wrapper = await renderAsk('/ask')
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.get('h1').text()).toBe('Опиши гру, як сказав би другові')

    const field = wrapper.get('textarea')
    const label = wrapper.get(`label[for="${field.attributes('id')}"]`)
    expect(label.text()).toBe('Яку гру шукаєш?')
    expect(field.attributes('maxlength')).toBe('200')
    const counter = wrapper.get(`#${field.attributes('aria-describedby')!.split(' ')[0]}`)
    expect(plain(counter.text())).toBe('0 із 200 символів')

    expect(wrapper.get('button[type="submit"]').text()).toBe('Підібрати')
  })

  it('opens with Gege, idle, saying what to write in his bubble', async () => {
    const wrapper = await renderAsk('/ask')
    const intro = wrapper.get('[data-test="ask-intro"]')
    expect(intro.get('svg').attributes('data-mood')).toBe('idle')
    expect(intro.get('svg').attributes('width')).toBe('100')
    // The page's one heading is the bubble's title.
    expect(intro.get('h1').text()).toBe('Опиши гру, як сказав би другові')
    expect(intro.get('p').text()).toBe(
      'Жанр, настрій, з ким граєш, скільки готовий витратити. Я знайду ігри й поясню, чому саме вони.',
    )
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

  it('names its search landmark by the field label', async () => {
    const wrapper = await renderAsk('/ask')
    const form = wrapper.get('form[role="search"]')
    expect(wrapper.get(`#${form.attributes('aria-labelledby')}`).text()).toBe('Яку гру шукаєш?')
  })

  it('asks for a few words instead of sending an empty question', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(requests).toEqual([])
    const field = wrapper.get('textarea')
    expect(field.attributes('aria-invalid')).toBe('true')
    const message = wrapper.get('[data-test="ask-empty-question"]')
    expect(message.text()).toBe('Напиши кілька слів про гру, яку шукаєш.')
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

  it("says the answer comes from the index, in the catalog's own words", async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const note = wrapper.get('[data-test="ask-results"] [data-test="index-note"]')
    expect(plain(note.text())).toBe(
      'Пошук серед 3 000 найпопулярніших ігор і всіх ігор українських студій — ціни й мови ми знаємо лише для них.',
    )
    // Text only: an answer has no price-run time, so no "prices updated" line.
    expect(note.find('[data-test="prices-updated"]').exists()).toBe(false)
  })

  it('says nothing about the index when the answer did not come from it', async () => {
    const wrapper = await renderAsk(askUrl(FALLBACK_QUERY))
    expect(wrapper.find('[data-test="ask-results"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="index-note"]').exists()).toBe(false)
  })

  it('shows the interpretation, the understood filter and a link to it in the catalog', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const results = wrapper.get('[data-test="ask-results"]')
    expect(results.get('h2').text()).toBe('Результати')
    // In his voice, inside his bubble.
    const bubble = results.get('[data-test="ask-answer"]')
    expect(plain(bubble.get('[data-test="ask-interpretation"]').text())).toBe(
      'Зрозумів так: Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
    )
    expect(bubble.find('[data-test="ask-filter"]').exists()).toBe(true)
    expect(bubble.find('[data-test="ask-count"]').exists()).toBe(true)
    expect(bubble.find('[data-test="index-note"]').exists()).toBe(true)
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

  it('lists the games as rows in order, each with the reason it fits under its name', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const items = wrapper.findAll('[data-test="ask-item"]')
    expect(items.map((item) => item.get('[data-test="card-title"]').text())).toEqual([
      'Overcooked! 2',
      'It Takes Two',
      'Stardew Valley',
    ])
    expect(items.map((item) => plain(item.get('[data-test="ask-reason"]').text()))).toEqual(
      STRUCTURED_ANSWER.items.map((item) => item.reason),
    )
    // The reason is a primary line, not a caption: the text colour, at the body size.
    const reason = items[0]!.get('[data-test="ask-reason"]')
    expect(reason.classes()).toContain('text-fg')
    expect(reason.classes().some((name) => /^text-(xs|sm)$/.test(name))).toBe(false)
    // Under the results' own h2, and the name is the link to the game's page.
    const title = items[0]!.get('[data-test="card-title"]')
    expect(title.element.tagName).toBe('H3')
    expect(title.get('a').attributes('href')).toBe('/games/overcooked-2')
  })

  it('shows the facts and the price of each game in its row', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const [first, second] = wrapper.findAll('[data-test="ask-item"]')
    expect(plain(first!.get('[data-test="ask-meta"]').text())).toContain('2020')
    expect(first!.get('[data-test="ask-meta"] [role="img"]').attributes('aria-label')).toContain(
      '84',
    )
    expect(plain(first!.get('[data-test="price"]').text())).toContain('−60%')
    expect(first!.find('[data-test="localisation"]').exists()).toBe(true)
    // A game without a price has no price block at all.
    expect(second!.find('[data-test="ask-price"]').exists()).toBe(false)
  })

  it('counts exactly the rows it renders: eight games are eight rows, all in the document', async () => {
    const wrapper = await renderAsk(askUrl(FULL_QUERY))
    const rows = wrapper.findAll('[data-test="ask-item"]')
    const counted = Number(/\d+/.exec(wrapper.get('[data-test="ask-count"]').text())![0])
    expect(counted).toBe(8)
    expect(rows).toHaveLength(counted)
    // Every one is a whole row — a name that links somewhere — and none is hidden.
    for (const row of rows) {
      expect(row.get('[data-test="card-title"] a').attributes('href')).toMatch(/^\/games\//)
      expect(row.attributes('hidden')).toBeUndefined()
      expect(row.classes()).not.toContain('hidden')
    }
    expect(plain(wrapper.get('[data-test="ask-live"]').text())).toBe('Підібрав 8 ігор')
  })

  it('keeps the form above the answer, with the question in it', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const form = wrapper.get('form[role="search"]').element
    const results = wrapper.get('[data-test="ask-results"]').element
    expect(form.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(STRUCTURED_QUERY)
    expect(wrapper.get('button[type="submit"]').text()).toBe('Підібрати')
    // Still one heading, now a plain line: Gege has moved down to the answer.
    expect(wrapper.findAll('h1')).toHaveLength(1)
    expect(wrapper.find('[data-test="ask-intro"]').exists()).toBe(false)
  })

  it('has Gege pleased with his picks for a moment, then idle again', async () => {
    // Only the timeouts are faked, and from before the mount: the moment starts when he is mounted.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    const mood = () => wrapper.get('[data-test="ask-answer"] svg').attributes('data-mood')
    expect(mood()).toBe('happy')
    await vi.advanceTimersByTimeAsync(1499)
    expect(mood()).toBe('happy')
    await vi.advanceTimersByTimeAsync(1)
    expect(mood()).toBe('idle')
  })

  it('says how many games it picked, visibly and in a live region', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect(plain(wrapper.get('[data-test="ask-count"]').text())).toBe('Підібрав 3 гри')
    const live = wrapper.get('[data-test="ask-live"]')
    expect(live.attributes('role')).toBe('status')
    expect(plain(live.text())).toBe('Підібрав 3 гри')
  })

  it('in fallback, says calmly that the AI part did not run and shows the plain search', async () => {
    const wrapper = await renderAsk(askUrl(FALLBACK_QUERY))
    const note = wrapper.get('[data-test="ask-answer"] [data-test="ask-fallback-note"]')
    // Nothing of his to be pleased with.
    expect(wrapper.get('[data-test="ask-answer"] svg').attributes('data-mood')).toBe('idle')
    expect(note.text()).toBe('ШІ-розбір зараз недоступний — показую звичайний пошук')
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
      'ШІ-розбір зараз недоступний — показую звичайний пошук. Знайшов 2 гри',
    )
  })

  it('when nothing matched, says so and still offers the filter in the catalog', async () => {
    const wrapper = await renderAsk(askUrl(EMPTY_QUERY))
    const empty = wrapper.get('[data-test="ask-empty"]')
    expect(empty.text()).toContain('Нічого не підібрав')
    expect(empty.text()).toContain('Спробуй описати інакше')
    expect(wrapper.get('[data-test="ask-answer"] svg').attributes('data-mood')).toBe('idle')
    expect(wrapper.find('[data-test="ask-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ask-item"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="ask-catalog-link"]').attributes('href')).toMatch(
      /^\/games\?search=/,
    )
    expect(plain(wrapper.get('[data-test="ask-live"]').text())).toBe('Нічого не підібрав')
  })

  it('when rate limited, explains when to try again', async () => {
    const wrapper = await renderAsk(askUrl(RATE_LIMITED_QUERY))
    const alert = wrapper.get('[data-test="ask-error"]')
    expect(alert.attributes('role')).toBe('alert')
    expect(plain(alert.text())).toContain('Забагато запитів поспіль. Спробуй ще раз за 42 секунди.')
    expect(wrapper.find('[data-test="ask-item"]').exists()).toBe(false)
    // Gege says it, idle.
    const speech = wrapper.get('[data-test="ask-results"] [data-test="gege-speech"]')
    expect(speech.get('svg').attributes('data-mood')).toBe('idle')
    expect(speech.find('[data-test="ask-error"]').exists()).toBe(true)
  })

  it('when the answer failed, offers to try again, and trying again asks again', async () => {
    const wrapper = await renderAsk(askUrl(BROKEN_QUERY))
    const alert = wrapper.get('[data-test="ask-error"]')
    expect(plain(alert.text())).toContain('Не вдалося підібрати ігри. Спробуй ще раз.')
    expect(requests).toHaveLength(1)
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(requests).toHaveLength(2)
  })

  it('explains a question the endpoint refused as too long', async () => {
    const wrapper = await renderAsk(askUrl('а'.repeat(201)))
    expect(requests).toHaveLength(1)
    expect(plain(wrapper.get('[data-test="ask-error"]').text())).toContain(
      'Запит задовгий: щонайбільше 200 символів. Скороти його й спробуй ще раз.',
    )
  })
})

describe('the ask page, answers the catalog could not fully apply', () => {
  it("strikes the declined filters through with the catalog's reason, and names a declined sort", async () => {
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

  it("takes the reason from the answer's indexStale when only a price was declined", async () => {
    const stale = await renderAsk(askUrl(PRICE_ONLY_QUERY))
    expect(stale.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: ціни тимчасово не оновлюються',
    )
    expect(stale.find('[data-test="stale-banner"]').exists()).toBe(true)
    // One request per render: the answer carries the freshness, no catalog query asks for it.
    expect(graphql.some((query) => query.includes('indexStale'))).toBe(false)

    const silent = await renderAsk(askUrl(PRICE_ONLY_SILENT_QUERY))
    expect(silent.get('[data-test="ignored-chip"]').text()).toContain(
      'не застосовано: дані про ціни зараз недоступні',
    )
    expect(silent.find('[data-test="stale-banner"]').exists()).toBe(false)
  })

  it('marks nothing, and raises no banner, when everything was applied', async () => {
    const wrapper = await renderAsk(askUrl(STRUCTURED_QUERY))
    expect(wrapper.find('[data-test="stale-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ignored-chip"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ask-sort-ignored"]').exists()).toBe(false)
  })

  it('renders an unranked answer as rows without a reason: no reason line, no empty element', async () => {
    const wrapper = await renderAsk(askUrl(UNRANKED_QUERY))
    const items = wrapper.findAll('[data-test="ask-item"]')
    expect(items).toHaveLength(3)
    expect(wrapper.find('[data-test="ask-reason"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Чому підходить')
    for (const item of items) {
      expect(item.element.children).toHaveLength(1)
      expect(item.element.children[0]!.getAttribute('data-test')).toBe('ask-row')
      expect(item.findAll('p').every((line) => line.text() !== '')).toBe(true)
    }
    expect(plain(wrapper.get('[data-test="ask-count"]').text())).toBe('Підібрав 3 гри')
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
      'Нічого не підібрав',
      'Спробуй описати інакше — конкретніше або менш суворо.',
    ])
    expect(wrapper.find('[data-test="ask-catalog-link"]').exists()).toBe(false)
  })

  it('keeps the link, and the hint that points to it, when there is a filter to open', async () => {
    const wrapper = await renderAsk(askUrl(EMPTY_QUERY))
    expect(wrapper.get('[data-test="ask-empty"]').text()).toContain('відкрий фільтр у каталозі')
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
    for (const file of [
      'app/pages/ask.vue',
      'app/components/ask/AskResultRow.vue',
      'app/components/ask/AskWaiting.vue',
      'app/components/GegeSpeech.vue',
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf-8')
      expect(source, file).not.toMatch(/v-html|innerHTML/)
    }
  })
})

/** The route the app's router is on: the page navigates it, so this is where `q` lands. */
const currentQuery = () => useRouter().currentRoute.value.query.q

/**
 * Lets the page work until `done` holds without letting any time pass: for the tests that count
 * the waiting lines on a fake clock, which a polling wait would move.
 */
async function turns(done: () => boolean) {
  for (let turn = 0; turn < 200 && !done(); turn += 1) {
    // A real turn of the event loop (`setImmediate` is not faked) and whatever is due at once.
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
  }
  expect(done()).toBe(true)
}

/** Waits until `check` holds, then lets the page settle. */
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

  it('shows Gege thinking over a busy skeleton while the answer is on its way', async () => {
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
      // The lines are counted on a fake clock, to the millisecond; only the timeouts are faked, so
      // the navigation and the request still run.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await wrapper.get('form').trigger('submit')
      await turns(() => wrapper.find('[data-test="ask-loading"]').exists())

      const results = wrapper.get('[data-test="ask-results"]')
      expect(results.attributes('aria-busy')).toBe('true')
      expect(results.findAll('[data-test="skeleton"]')).toHaveLength(3)
      expect(results.get('[data-test="ask-loading"] svg').attributes('data-mood')).toBe('thinking')
      expect(results.get('[data-test="ask-waiting-line"]').text()).toBe('Читаю запит…')
      // Announced once, by the page's status region; the line that changes is not a live region.
      const live = wrapper.get('[data-test="ask-live"]')
      expect(live.text()).toBe('Читаю запит…')
      expect(
        results
          .get('[data-test="ask-loading"]')
          .element.querySelector('[aria-live], [role="status"]'),
      ).toBeNull()
      // The form stays, with the question in it.
      expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(STRUCTURED_QUERY)

      // The line follows the clock, and the announcement does not follow the line.
      const line = () => wrapper.get('[data-test="ask-waiting-line"]').text()
      await vi.advanceTimersByTimeAsync(1999)
      expect(line()).toBe('Читаю запит…')
      await vi.advanceTimersByTimeAsync(1)
      expect(line()).toBe('Шукаю ігри…')
      expect(live.text()).toBe('Читаю запит…')
      await vi.advanceTimersByTimeAsync(2000)
      expect(line()).toBe('Пояснюю вибір…')

      // A second question sent during the wait starts its own: the lines begin again.
      await wrapper.get('textarea').setValue(FULL_QUERY)
      await wrapper.get('form').trigger('submit')
      await turns(() => currentQuery() === FULL_QUERY)
      expect(line()).toBe('Читаю запит…')
      await vi.advanceTimersByTimeAsync(2000)
      expect(line()).toBe('Шукаю ігри…')

      vi.useRealTimers()
      release()
      await settle(() => expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(8))
      expect(wrapper.get('[data-test="ask-results"]').attributes('aria-busy')).toBeUndefined()
    } finally {
      release()
      registerEndpoint('/api/ask', { method: 'POST', handler: stub })
    }
  })

  it('drops the focus move when the visitor leaves for the plain page during the wait', async () => {
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

      await useRouter().push('/ask')
      await settle(() => expect(wrapper.find('[data-test="ask-intro"]').exists()).toBe(true))
      release()
      await flushPromises()

      // An answer reached through history afterwards is not one the visitor just asked for.
      await useRouter().push(askUrl(STRUCTURED_QUERY))
      await settle(() => expect(wrapper.findAll('[data-test="ask-item"]')).toHaveLength(3))
      expect(document.activeElement?.tagName).not.toBe('H2')
    } finally {
      release()
      registerEndpoint('/api/ask', { method: 'POST', handler: stub })
    }
  })

  it('reads the outcome with the heading that takes focus', async () => {
    const wrapper = await renderAsk('/ask')
    const described = () =>
      (wrapper.get('[data-test="ask-results"] h2').attributes('aria-describedby') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => plain(document.getElementById(id)!.textContent!))

    await wrapper.get('textarea').setValue(STRUCTURED_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(document.activeElement?.tagName).toBe('H2'))
    expect(described()).toEqual(['Підібрав 3 гри'])
    // The list is in the section the heading names; it does not repeat the name.
    expect(
      wrapper.get('[data-test="ask-item"]').element.parentElement!.hasAttribute('aria-labelledby'),
    ).toBe(false)

    await wrapper.get('textarea').setValue(FALLBACK_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(wrapper.find('[data-test="ask-fallback-note"]').exists()).toBe(true))
    expect(described()).toEqual([
      'ШІ-розбір зараз недоступний — показую звичайний пошук',
      'Знайшов 2 гри',
    ])

    await wrapper.get('textarea').setValue(EMPTY_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(wrapper.find('[data-test="ask-empty"]').exists()).toBe(true))
    expect(described()).toEqual(['Нічого не підібрав'])

    // A failure is an alert, spoken by itself.
    await wrapper.get('textarea').setValue(BROKEN_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(wrapper.find('[data-test="ask-error"]').exists()).toBe(true))
    expect(
      wrapper.get('[data-test="ask-results"] h2').attributes('aria-describedby'),
    ).toBeUndefined()
  })

  it('keeps keyboard focus on the page when an example is pressed from the keyboard', async () => {
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
      const example = wrapper.get('[data-test="ask-examples"]').findAll('button')[0]!
      ;(example.element as HTMLButtonElement).focus()
      // A click with no pointer behind it: Enter or Space on the button.
      await example.trigger('click', { detail: 0 })
      await settle(() => expect(wrapper.find('[data-test="ask-loading"]').exists()).toBe(true))

      // The chips are gone; focus is in the field, which holds the example's question.
      expect(wrapper.find('[data-test="ask-examples"]').exists()).toBe(false)
      const field = wrapper.get('textarea').element as HTMLTextAreaElement
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe('кооператив для двох на Switch до 500 грн')
    } finally {
      release()
      registerEndpoint('/api/ask', { method: 'POST', handler: stub })
    }
  })

  it('does not raise the field for an example that was tapped or clicked', async () => {
    const wrapper = await renderAsk('/ask')
    const example = wrapper.get('[data-test="ask-examples"]').findAll('button')[0]!
    ;(example.element as HTMLButtonElement).focus()
    await example.trigger('click', { detail: 1 })
    await flushPromises()
    expect(document.activeElement).not.toBe(wrapper.get('textarea').element)
  })
})

describe('the ask page, going back and forward', () => {
  const titles = (wrapper: Awaited<ReturnType<typeof renderAsk>>) =>
    wrapper.findAll('[data-test="card-title"]').map((title) => title.text())

  it('renders an answer it already has on Back and Forward, without asking again', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('textarea').setValue(STRUCTURED_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(titles(wrapper)).toContain('Overcooked! 2'))
    await wrapper.get('textarea').setValue(FALLBACK_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(titles(wrapper)).toContain('Hades'))
    expect(requests).toHaveLength(2)

    useRouter().back()
    await settle(() => expect(titles(wrapper)).toContain('Overcooked! 2'))
    expect(currentQuery()).toBe(STRUCTURED_QUERY)
    // Rendered straight from memory: no skeleton on the way.
    expect(wrapper.find('[data-test="ask-loading"]').exists()).toBe(false)

    useRouter().forward()
    await settle(() => expect(titles(wrapper)).toContain('Hades'))
    expect(requests).toHaveLength(2)
  })

  it('still asks when a question is sent again from the form', async () => {
    const wrapper = await renderAsk('/ask')
    for (const question of [STRUCTURED_QUERY, FALLBACK_QUERY, STRUCTURED_QUERY]) {
      await wrapper.get('textarea').setValue(question)
      await wrapper.get('form').trigger('submit')
      await settle(() => expect(currentQuery()).toBe(question))
    }
    await settle(() => expect(requests).toHaveLength(3))
    expect(titles(wrapper)).toContain('Overcooked! 2')
  })

  it('keeps a failed answer out of memory, so going back to it asks again', async () => {
    const wrapper = await renderAsk('/ask')
    await wrapper.get('textarea').setValue(BROKEN_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(wrapper.find('[data-test="ask-error"]').exists()).toBe(true))
    await wrapper.get('textarea').setValue(STRUCTURED_QUERY)
    await wrapper.get('form').trigger('submit')
    await settle(() => expect(titles(wrapper)).toContain('Overcooked! 2'))

    useRouter().back()
    await settle(() => expect(requests).toHaveLength(3))
  })
})
