import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent } from 'vue'
import { readBody } from 'h3'
import { useSearchSuggestions } from '~/composables/useSearchSuggestions'

const game = (search: string) => ({
  id: '1',
  slug: `${search}-slug`,
  name: `${search} game`,
  released: '2020-01-01',
  rating: 4,
  metacritic: 80,
  cover: null,
  platforms: [],
  genres: [],
  price: null,
  localisation: null,
  madeInUkraine: false,
})

/** Mounts the composable inside a minimal host so lifecycle hooks (onBeforeUnmount) work. */
async function mountComposable() {
  let exposed!: ReturnType<typeof useSearchSuggestions>
  const Host = defineComponent({
    setup() {
      exposed = useSearchSuggestions()
      return {}
    },
    template: '<div></div>',
  })
  await mountSuspended(Host)
  return exposed
}

describe('useSearchSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fetch below the minimum length', async () => {
    const calls: string[] = []
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async (event) => {
        const body = (await readBody(event)) as { variables: { filter: { search: string } } }
        calls.push(body.variables.filter.search)
        return { data: { games: { items: [game(body.variables.filter.search)] } } }
      },
    })

    const suggestions = await mountComposable()
    suggestions.term.value = 'a'
    await vi.advanceTimersByTimeAsync(300)

    expect(calls).toEqual([])
    expect(suggestions.status.value).toBe('idle')
    expect(suggestions.items.value).toEqual([])
  })

  it('debounces 250ms and issues exactly one request for fast typing', async () => {
    const calls: string[] = []
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async (event) => {
        const body = (await readBody(event)) as { variables: { filter: { search: string } } }
        calls.push(body.variables.filter.search)
        return { data: { games: { items: [game(body.variables.filter.search)] } } }
      },
    })

    const suggestions = await mountComposable()
    suggestions.term.value = 'w'
    await vi.advanceTimersByTimeAsync(50)
    suggestions.term.value = 'wi'
    await vi.advanceTimersByTimeAsync(50)
    suggestions.term.value = 'wit'
    expect(suggestions.status.value).toBe('loading')

    await vi.advanceTimersByTimeAsync(249)
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(suggestions.status.value).toBe('success'))

    expect(calls).toEqual(['wit'])
    expect(suggestions.items.value).toHaveLength(1)
  })

  it('ignores a stale response that resolves after a newer request', async () => {
    const resolvers = new Map<string, (value: unknown) => void>()
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async (event) => {
        const body = (await readBody(event)) as { variables: { filter: { search: string } } }
        const term = body.variables.filter.search
        return new Promise((resolve) => resolvers.set(term, resolve))
      },
    })

    const suggestions = await mountComposable()
    suggestions.term.value = 'aa'
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(resolvers.has('aa')).toBe(true))

    suggestions.term.value = 'aab'
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(resolvers.has('aab')).toBe(true))

    // Newer request ('aab') resolves first.
    resolvers.get('aab')!({ data: { games: { items: [game('aab')] } } })
    await vi.waitFor(() => expect(suggestions.status.value).toBe('success'))
    expect(suggestions.items.value.map((item) => item.slug)).toEqual(['aab-slug'])

    // Stale request ('aa') resolves late and must be ignored.
    resolvers.get('aa')!({ data: { games: { items: [game('aa')] } } })
    await vi.advanceTimersByTimeAsync(0)

    expect(suggestions.items.value.map((item) => item.slug)).toEqual(['aab-slug'])
  })

  it('sets an error status and clears items when the request fails', async () => {
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: () => {
        throw new Error('boom')
      },
    })

    const suggestions = await mountComposable()
    suggestions.term.value = 'boom'
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(suggestions.status.value).toBe('error'))

    expect(suggestions.items.value).toEqual([])
  })
})
