import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { readBody, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import { askStubResponse } from '~~/tests/fixtures/askPage/stub'
import {
  BROKEN_QUERY,
  FALLBACK_QUERY,
  RATE_LIMITED_QUERY,
  RETRY_AFTER_SECONDS,
  STRUCTURED_QUERY,
} from '~~/tests/fixtures/askPage/answers'

/** Every body the stub received, in order. */
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

const question = ref('')
/** Mounted hosts, unmounted after each test: a live one would answer the next test's question. */
const mounted: { unmount: () => void }[] = []

const Host = defineComponent({
  async setup() {
    return await useAsk(question)
  },
  template: '<span />',
})

type HostState = Awaited<ReturnType<typeof useAsk>>

async function ask(text: string) {
  question.value = text
  const wrapper = await mountSuspended(Host)
  mounted.push(wrapper)
  await flushPromises()
  await nextTick()
  return wrapper.vm as unknown as {
    [K in keyof HostState]: HostState[K] extends { value: infer V } ? V : HostState[K]
  }
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  requests.length = 0
  question.value = ''
})

describe('useAsk', () => {
  it('sends nothing for an empty question', async () => {
    const state = await ask('   ')
    expect(requests).toEqual([])
    expect(state.answer).toBeNull()
    expect(state.failure).toBeNull()
  })

  it('posts the trimmed question and the page locale, and returns the checked answer', async () => {
    const state = await ask(`  ${STRUCTURED_QUERY}  `)
    expect(requests).toEqual([{ q: STRUCTURED_QUERY, locale: 'uk' }])
    expect(state.failure).toBeNull()
    expect(state.answer?.mode).toBe('structured')
    expect(state.answer?.items).toHaveLength(3)
  })

  it('returns the fallback answer as an answer, not as a failure', async () => {
    const state = await ask(FALLBACK_QUERY)
    expect(state.failure).toBeNull()
    expect(state.answer?.mode).toBe('fallback')
  })

  it('reports a rate limit with the seconds from Retry-After', async () => {
    const state = await ask(RATE_LIMITED_QUERY)
    expect(state.answer).toBeFalsy()
    expect(state.failure).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    })
  })

  it('reports any other failure as one the visitor can retry', async () => {
    const state = await ask(BROKEN_QUERY)
    expect(state.failure).toEqual({ kind: 'failed', retryAfterSeconds: null })
  })

  it('reports a question the endpoint refuses (400) as invalid', async () => {
    const state = await ask('x'.repeat(201))
    // Sent as it is: the endpoint owns the rules for a valid question, and a refusal costs it
    // nothing (invalid requests are not charged to the visitor's rate limit).
    expect(requests).toHaveLength(1)
    expect(state.failure).toEqual({ kind: 'invalid', retryAfterSeconds: null })
  })

  it('treats an answer of the wrong shape as a failure, not as an empty result', async () => {
    registerEndpoint('/api/ask', { method: 'POST', handler: () => ({ mode: 'magic' }) })
    try {
      const state = await ask('будь-що')
      expect(state.failure).toEqual({ kind: 'failed', retryAfterSeconds: null })
    } finally {
      registerEndpoint('/api/ask', { method: 'POST', handler: stub })
    }
  })
})
