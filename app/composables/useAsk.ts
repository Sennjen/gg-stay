import {
  normaliseAskAnswer,
  normaliseAskQuery,
  parseRetryAfter,
  type AskAnswer,
} from '~/utils/askAnswer'

/**
 * Why the page has no answer to show. `invalid`: the endpoint refused the question (empty or over
 * 200 characters); `rate-limited`: too many questions from this visitor, with the wait the
 * endpoint asked for when it sent one; `failed`: anything else, worth one more try.
 */
export interface AskFailure {
  kind: 'invalid' | 'rate-limited' | 'failed'
  retryAfterSeconds: number | null
}

const FAILURE_STATUS: Record<AskFailure['kind'], number> = {
  invalid: 400,
  'rate-limited': 429,
  failed: 502,
}

/**
 * The failure as an async-data error. Its `data` is what survives the server render: the payload
 * carries `data` to the client, while the response headers the 429 came with do not — so the
 * seconds are read off the header here, inside the handler, and travel in `data`.
 */
function askError(failure: AskFailure) {
  return createError({
    statusCode: FAILURE_STATUS[failure.kind],
    statusMessage: failure.kind,
    data: failure,
  })
}

interface FetchFailure {
  statusCode?: number
  status?: number
  response?: { status?: number; headers?: Headers }
}

function classify(error: unknown): AskFailure {
  const failure = (error ?? {}) as FetchFailure
  const status = failure.statusCode ?? failure.status ?? failure.response?.status
  if (status === 400) return { kind: 'invalid', retryAfterSeconds: null }
  if (status === 429) {
    const header = failure.response?.headers?.get('retry-after')
    return { kind: 'rate-limited', retryAfterSeconds: parseRetryAfter(header) }
  }
  return { kind: 'failed', retryAfterSeconds: null }
}

function readFailure(data: unknown): AskFailure {
  const failure = (data ?? {}) as Partial<AskFailure>
  const kind =
    failure.kind === 'invalid' || failure.kind === 'rate-limited' ? failure.kind : 'failed'
  const seconds = failure.retryAfterSeconds
  return { kind, retryAfterSeconds: typeof seconds === 'number' && seconds > 0 ? seconds : null }
}

/**
 * Answers this tab has already received, by question and locale, so Back and Forward render the
 * page a visitor saw instead of asking again: every ask costs one of the visitor's ten questions a
 * minute, and a fallback answer is never cached by the endpoint, so going back to one would run
 * the failed model attempt once more. Browser only — on the server a module-level map would be
 * shared by every visitor — held in memory for the life of the tab, and bounded. Failures are not
 * kept: going back to one asks again. A question sent from the form always asks (`forget`).
 */
const remembered = new Map<string, AskAnswer>()
const REMEMBERED_LIMIT = 30

function remember(key: string, answer: AskAnswer) {
  if (!import.meta.client) return
  remembered.delete(key)
  remembered.set(key, answer)
  if (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value!)
}

/** Clears the tab's remembered answers (tests start from an empty tab). */
export function forgetAskAnswers() {
  remembered.clear()
}

const askKey = (locale: string, query: string) => `ask:${locale}:${query}`

/**
 * The typed client for `POST /api/ask` `{ q, locale }`. The question is a ref (the page passes the
 * `q` from its URL), and the request runs through `useAsyncData`, so a URL with `q` is answered
 * in the server render and a shared link opens on its results. An empty question sends nothing;
 * any other is sent as it is, because the endpoint owns the rules for a valid one (its 400 costs
 * the visitor nothing).
 *
 * Named `useAskAnswer` rather than after its file: the server's own `useAsk()` (the endpoint's
 * dependencies, `server/utils/ask.ts`) is an auto-import too, and one name for both made the
 * server's type check resolve the endpoint's call to this composable.
 *
 * The call goes through `useRequestFetch()`: in the server render it forwards the visitor's request
 * headers, `x-forwarded-for` among them, so the endpoint's per-address rate limit counts this
 * visitor. A bare `$fetch` there would make an internal call with no address, and every server
 * render would share one bucket. In the browser it is plain `$fetch`.
 */
export async function useAskAnswer(question: MaybeRefOrGetter<string>) {
  const { locale } = useI18n()
  const query = computed(() => normaliseAskQuery(toValue(question)))
  const requestFetch = useRequestFetch()

  const key = computed(() => askKey(locale.value, query.value))

  const { data, error, status, refresh } = await useAsyncData(
    key,
    async (): Promise<AskAnswer | null> => {
      const q = query.value
      if (!q) return null
      let raw: unknown
      try {
        raw = await requestFetch('/api/ask', { method: 'POST', body: { q, locale: locale.value } })
      } catch (cause) {
        throw askError(classify(cause))
      }
      const answer = normaliseAskAnswer(raw)
      if (!answer) throw askError({ kind: 'failed', retryAfterSeconds: null })
      remember(askKey(locale.value, q), answer)
      return answer
    },
    {
      // The server render's answer when hydrating; in the browser, an answer this tab already
      // has. "Send again" (`refresh()`) always asks.
      getCachedData(cacheKey, nuxtApp, context) {
        if (context.cause === 'refresh:manual') return undefined
        if (nuxtApp.isHydrating) return nuxtApp.payload.data[cacheKey]
        return remembered.get(cacheKey)
      },
    },
  )
  // The answer the server rendered is one this tab has, too.
  if (import.meta.client && data.value) remember(key.value, data.value)

  const failure = computed<AskFailure | null>(() =>
    error.value ? readFailure(error.value.data) : null,
  )

  return {
    query,
    answer: computed(() => data.value ?? null),
    failure,
    status,
    refresh: () => refresh(),
    /** Drops a question's remembered answer, so the next time it is shown it is asked again. */
    forget: (text: string) => {
      remembered.delete(askKey(locale.value, normaliseAskQuery(text)))
    },
  }
}
