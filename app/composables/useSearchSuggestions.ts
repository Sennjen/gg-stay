import { GamesDocument, type GamesQuery } from '~/graphql/__generated__/operations'
import { printDocument } from '~/utils/printDocument'

export type SearchSuggestion = GamesQuery['games']['items'][number]
export type SearchStatus = 'idle' | 'loading' | 'success' | 'error'

const DEBOUNCE_MS = 250
const MIN_LENGTH = 2
const PAGE_SIZE = 6

/**
 * Client-only, user-triggered lookup for the header search dropdown (the same
 * documented exception `DeveloperAutocomplete` uses): debounced, cancels
 * stale responses, reuses the generated `GamesDocument` rather than a
 * dedicated resolver. `useGql`/`useAsyncData` is for render-blocking data —
 * this fetch only ever runs after the visitor types.
 */
export function useSearchSuggestions() {
  const term = ref('')
  const items = ref<SearchSuggestion[]>([])
  const status = ref<SearchStatus>('idle')

  let timer: ReturnType<typeof setTimeout> | undefined
  let requestId = 0

  async function run(value: string) {
    const id = ++requestId
    try {
      const query = await printDocument(GamesDocument as never)
      const response = await $fetch<{ data?: GamesQuery }>('/api/graphql', {
        method: 'POST',
        body: {
          query,
          variables: { filter: { search: value }, pageSize: PAGE_SIZE },
        },
      })
      if (id !== requestId) return // a newer request has since started; ignore this one
      items.value = response.data?.games.items ?? []
      status.value = 'success'
    } catch {
      if (id !== requestId) return
      items.value = []
      status.value = 'error'
    }
  }

  watch(term, (value) => {
    clearTimeout(timer)
    const trimmed = value.trim()
    if (trimmed.length < MIN_LENGTH) {
      requestId++ // invalidate any in-flight request
      items.value = []
      status.value = 'idle'
      return
    }
    status.value = 'loading'
    timer = setTimeout(() => run(trimmed), DEBOUNCE_MS)
  })

  function reset() {
    clearTimeout(timer)
    requestId++
    term.value = ''
    items.value = []
    status.value = 'idle'
  }

  onBeforeUnmount(() => clearTimeout(timer))

  return { term, items, status, reset }
}
