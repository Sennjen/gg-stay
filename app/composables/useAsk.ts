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
 * The typed client for `POST /api/ask` `{ q, locale }`. The question is a ref (the page passes the
 * `q` from its URL), and the request runs through `useAsyncData`, so a URL with `q` is answered
 * in the server render and a shared link opens on its results. An empty question sends nothing;
 * any other is sent as it is, because the endpoint owns the rules for a valid one (its 400 costs
 * the visitor nothing).
 *
 * The call goes through `useRequestFetch()`: in the server render it forwards the visitor's request
 * headers, `x-forwarded-for` among them, so the endpoint's per-address rate limit counts this
 * visitor. A bare `$fetch` there would make an internal call with no address, and every server
 * render would share one bucket. In the browser it is plain `$fetch`.
 */
export async function useAsk(question: MaybeRefOrGetter<string>) {
  const { locale } = useI18n()
  const query = computed(() => normaliseAskQuery(toValue(question)))
  const requestFetch = useRequestFetch()

  const { data, error, status, refresh } = await useAsyncData(
    () => `ask:${locale.value}:${query.value}`,
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
      return answer
    },
  )

  const failure = computed<AskFailure | null>(() =>
    error.value ? readFailure(error.value.data) : null,
  )

  return {
    query,
    answer: computed(() => data.value ?? null),
    failure,
    status,
    refresh: () => refresh(),
  }
}
