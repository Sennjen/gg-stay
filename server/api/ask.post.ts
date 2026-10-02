import { handleAsk } from '../ask/handler'
import { API_CONTENT_SECURITY_POLICY, CSP_HEADER } from '../security/headers'

/**
 * `POST /api/ask` `{ q, locale }` — natural-language search. Everything but the HTTP plumbing is
 * in `server/ask/handler.ts`; the answer is never a 5xx (see `server/ask/pipeline.ts`).
 */
export default defineEventHandler(async (event) => {
  // A body that is not JSON is the handler's 400, not h3's.
  const body: unknown = await readBody(event).catch(() => null)
  const response = await handleAsk(
    {
      body,
      // Used for the per-address limit only, and never logged. On Vercel the platform sets
      // `x-forwarded-for` itself, so a client cannot choose its own bucket.
      ip: getRequestIP(event, { xForwardedFor: true }) ?? 'unknown',
      contentType: getRequestHeader(event, 'content-type'),
    },
    useAsk(),
  )
  setResponseStatus(event, response.status)
  setResponseHeaders(event, response.headers)
  // A JSON answer hosts no document, so it gets the API's own `'none'` policy, as `/api/graphql`.
  setResponseHeader(event, CSP_HEADER, API_CONTENT_SECURITY_POLICY)
  return response.body
})
