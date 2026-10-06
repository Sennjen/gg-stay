import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createSSRApp, defineComponent, h, ref, shallowRef } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PARTIAL_RETRY_DELAYS_MS, useRetryWhilePartial } from '~/composables/useRetryWhilePartial'

/**
 * The rule a page follows when its answer came back partial: when it asks again, what it does
 * with the answers, and that nothing of it outlives the page. Driven on a fake clock, against a
 * stand-in for what `useGql` hands a page — an answer, a key and a way to ask again.
 */

interface Answer {
  game: { name: string; partial: boolean } | null
}

const partialAnswer = (name = 'Portal 2'): Answer => ({ game: { name, partial: true } })
const wholeAnswer = (name = 'Portal 2'): Answer => ({ game: { name, partial: false } })

const [FIRST_WAIT, SECOND_WAIT] = PARTIAL_RETRY_DELAYS_MS as [number, number]

/** What one attempt is answered with: an answer, a failure, or whatever a case resolves it to. */
type Reply = Answer | null | Error | Promise<Answer | null>

function harness(shown: Answer | null | undefined, replies: Reply[] = []) {
  const data = shallowRef(shown)
  const key = ref('gql:Game:{"slug":"portal-2"}')
  const request = vi.fn(async () => {
    const reply = replies.shift()
    if (reply === undefined) throw new Error('an attempt nobody expected')
    if (reply instanceof Error) throw reply
    return reply
  })
  const Page = defineComponent({
    setup() {
      useRetryWhilePartial({ data, key, request }, (answer) => answer?.game?.partial)
      return () => h('p', data.value?.game?.name ?? '')
    },
  })
  return { data, key, request, Page }
}

const mounted: VueWrapper[] = []

function show(shown: Answer | null | undefined, replies: Reply[] = []) {
  const made = harness(shown, replies)
  const wrapper = mount(made.Page)
  mounted.push(wrapper)
  return { ...made, wrapper }
}

/** Moves the fake clock on and lets the attempt that became due run to its end. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.useRealTimers()
})

describe('a page whose answer is partial', () => {
  it('waits three seconds, and six after that', () => {
    expect(PARTIAL_RETRY_DELAYS_MS).toEqual([3_000, 6_000])
  })

  it('asks again three seconds after it is on screen, and not a millisecond sooner', async () => {
    const { request } = show(partialAnswer(), [wholeAnswer()])
    expect(vi.getTimerCount()).toBe(1)

    await advance(FIRST_WAIT - 1)
    expect(request).not.toHaveBeenCalled()
    await advance(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('puts a complete answer on the page in place of the partial one, and asks no more', async () => {
    const whole = wholeAnswer()
    const { data, request, wrapper } = show(partialAnswer(), [whole])

    await advance(FIRST_WAIT)
    expect(data.value).toBe(whole)
    expect(wrapper.text()).toBe('Portal 2')
    expect(vi.getTimerCount()).toBe(0)

    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks a second time six seconds after a second partial answer, and then stops', async () => {
    const shown = partialAnswer()
    const { data, request } = show(shown, [partialAnswer(), partialAnswer()])

    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await advance(SECOND_WAIT - 1)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)

    // Both attempts stayed partial: nothing is scheduled, nothing more is asked, and the page is
    // still the very answer it had.
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(data.value).toBe(shown)
  })

  it('takes the complete answer of the second attempt when the first stayed partial', async () => {
    const whole = wholeAnswer()
    const { data, request } = show(partialAnswer(), [partialAnswer(), whole])

    await advance(FIRST_WAIT)
    expect(data.value).not.toBe(whole)
    await advance(SECOND_WAIT)
    expect(data.value).toBe(whole)
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never puts another partial answer on the page', async () => {
    const shown = partialAnswer('The page the visitor is reading')
    const { data, wrapper } = show(shown, [
      partialAnswer('Built from other parts'),
      partialAnswer('And again'),
    ])

    await advance(FIRST_WAIT)
    expect(data.value).toBe(shown)
    await advance(SECOND_WAIT)
    expect(data.value).toBe(shown)
    expect(wrapper.text()).toBe('The page the visitor is reading')
  })

  it('counts the second wait from when the first attempt was answered, so it never asks twice at once', async () => {
    const slow = deferred<Answer | null>()
    const { request } = show(partialAnswer(), [slow.promise, wholeAnswer()])

    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)
    // The attempt is out for longer than the second wait: nothing is asked while it is.
    await advance(SECOND_WAIT + 4_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    slow.resolve(partialAnswer())
    await advance(SECOND_WAIT - 1)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('takes a failed attempt for an attempt: the page stays, and the next one still comes', async () => {
    const shown = partialAnswer()
    const whole = wholeAnswer()
    const { data, request } = show(shown, [new Error('offline'), whole])

    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)
    expect(data.value).toBe(shown)

    await advance(SECOND_WAIT)
    expect(request).toHaveBeenCalledTimes(2)
    expect(data.value).toBe(whole)
  })

  it('stops after two failed attempts, with the page as it was', async () => {
    const shown = partialAnswer()
    const { data, request } = show(shown, [new Error('offline'), new Error('offline')])

    await advance(FIRST_WAIT + SECOND_WAIT)
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(data.value).toBe(shown)
  })

  it.each([
    ['holds no answer at all', null],
    ['answers without the game', { game: null }],
  ])('does not take an attempt that %s for a complete answer', async (_what, empty) => {
    const shown = partialAnswer()
    const { data, request } = show(shown, [empty, empty])

    await advance(FIRST_WAIT + SECOND_WAIT)
    expect(request).toHaveBeenCalledTimes(2)
    expect(data.value).toBe(shown)
  })
})

describe('a page whose answer is not partial', () => {
  it.each([
    ['is whole', wholeAnswer()],
    ['has not arrived', undefined],
    ['is none', null],
    ['holds no game', { game: null }],
  ])('asks nothing when the answer %s', async (_what, shown) => {
    const { request } = show(shown)
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('what the asking leaves behind', () => {
  it('clears the wait when the visitor leaves the page', async () => {
    const { request, wrapper } = show(partialAnswer(), [wholeAnswer()])
    await advance(1_000)
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('clears the second wait as well', async () => {
    const { request, wrapper } = show(partialAnswer(), [partialAnswer(), wholeAnswer()])
    await advance(FIRST_WAIT)
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('drops the answer of an attempt that was out when the visitor left', async () => {
    const slow = deferred<Answer | null>()
    const shown = partialAnswer()
    const { data, request, wrapper } = show(shown, [slow.promise])
    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    slow.resolve(wholeAnswer())
    await advance(60_000)
    expect(data.value).toBe(shown)
    expect(vi.getTimerCount()).toBe(0)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('is deaf to answers that arrive after the visitor left', async () => {
    const { data, key, request, wrapper } = show(wholeAnswer())
    wrapper.unmount()

    // The answer and its key outlive the page that showed them; nobody is listening any more.
    key.value = 'gql:Game:{"slug":"half-life-2"}'
    data.value = partialAnswer('Half-Life 2')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('clears the wait when the page turns to another game, before that game has answered', async () => {
    const { key, request } = show(partialAnswer('Portal 2'), [wholeAnswer('Half-Life 2')])
    await advance(1_000)

    // The old answer is still on the page, as it is while the new one loads.
    key.value = 'gql:Game:{"slug":"half-life-2"}'
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('drops the answer of an attempt that was out when the page turned to another game', async () => {
    const slow = deferred<Answer | null>()
    const shown = partialAnswer('Portal 2')
    const { data, key, request } = show(shown, [slow.promise])
    await advance(FIRST_WAIT)

    key.value = 'gql:Game:{"slug":"half-life-2"}'
    await flushPromises()
    // The answer was asked for under the old game's name; it must not land on the new game's page.
    slow.resolve(wholeAnswer('Portal 2'))
    await advance(60_000)
    expect(data.value).toBe(shown)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('starts over for the other game’s own answer, with both attempts to spend', async () => {
    const { data, key, request } = show(partialAnswer('Portal 2'), [
      partialAnswer('Portal 2'),
      partialAnswer('Half-Life 2'),
      partialAnswer('Half-Life 2'),
    ])
    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)

    key.value = 'gql:Game:{"slug":"half-life-2"}'
    data.value = partialAnswer('Half-Life 2')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)

    await advance(FIRST_WAIT - 1)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    await advance(SECOND_WAIT)
    expect(request).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts over when a new answer arrives by another way, and drops the attempt that was out', async () => {
    const slow = deferred<Answer | null>()
    const { data, request } = show(partialAnswer(), [slow.promise, wholeAnswer()])
    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(1)

    // The page's own refresh put a new partial answer there while the attempt was still out.
    const refreshed = partialAnswer()
    data.value = refreshed
    await flushPromises()
    slow.resolve(wholeAnswer('Too late'))
    await flushPromises()
    expect(data.value).toBe(refreshed)

    await advance(FIRST_WAIT)
    expect(request).toHaveBeenCalledTimes(2)
    expect(data.value?.game?.name).toBe('Portal 2')
    expect(data.value?.game?.partial).toBe(false)
  })

  it('asks nothing for a complete answer that arrives by another way', async () => {
    const { data, request } = show(partialAnswer())
    await advance(1_000)

    data.value = wholeAnswer()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('a server render', () => {
  it('schedules nothing and asks nothing, however partial the answer', async () => {
    // Vue's development build sets a timer of its own the first time it builds the renderer a
    // server-rendered app uses. A render of nothing gets that out of the way, so what is counted
    // below is the page's alone.
    await renderToString(createSSRApp(defineComponent({ render: () => h('p') })))
    const before = vi.getTimerCount()
    const { request, Page } = harness(partialAnswer(), [wholeAnswer()])

    const html = await renderToString(createSSRApp(Page))
    expect(html).toContain('Portal 2')
    expect(vi.getTimerCount()).toBe(before)
    await advance(60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('is where the wait begins once its page has hydrated in the browser', async () => {
    await renderToString(createSSRApp(defineComponent({ render: () => h('p') })))
    const { request, Page } = harness(partialAnswer(), [wholeAnswer()])
    const container = document.createElement('div')
    container.innerHTML = await renderToString(createSSRApp(Page))
    const before = vi.getTimerCount()

    // The same page, mounted over the server's markup: this is when its three seconds start.
    const app = createSSRApp(Page)
    app.mount(container)
    try {
      expect(vi.getTimerCount()).toBe(before + 1)
      await advance(FIRST_WAIT - 1)
      expect(request).not.toHaveBeenCalled()
      await advance(1)
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
    }
  })
})
