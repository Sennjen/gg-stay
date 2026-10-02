import { clientAddressKey } from '../ask/clientIp'
import { handleAsk, MAX_BODY_BYTES } from '../ask/handler'
import { API_CONTENT_SECURITY_POLICY, CSP_HEADER } from '../security/headers'

/**
 * `POST /api/ask` `{ q, locale }` — natural-language search. Everything but the HTTP plumbing is
 * in `server/ask/handler.ts`; the answer is never a 5xx (see `server/ask/pipeline.ts`).
 */
export default defineEventHandler(async (event) => {
  const contentLength = getRequestHeader(event, 'content-length')
  // A body the client declares larger than any question is not read at all; the handler answers
  // it with a 400. A body that is not JSON is the handler's 400 as well, not h3's.
  const body: unknown =
    Number(contentLength ?? 0) > MAX_BODY_BYTES ? null : await readBody(event).catch(() => null)
  const response = await handleAsk(
    {
      body,
      // Used for the limits only, and never logged. Forwarding headers are trusted on Vercel alone,
      // where the platform sets them; anywhere else only the socket's address counts.
      ip: clientAddressKey({
        header: (name) => getRequestHeader(event, name),
        socketAddress: event.node.req.socket?.remoteAddress,
        onVercel: Boolean(process.env.VERCEL),
      }),
      contentType: getRequestHeader(event, 'content-type'),
      contentLength,
    },
    useAsk(),
  )
  setResponseStatus(event, response.status)
  setResponseHeaders(event, response.headers)
  // A JSON answer hosts no document, so it gets the API's own `'none'` policy, as `/api/graphql`.
  setResponseHeader(event, CSP_HEADER, API_CONTENT_SECURITY_POLICY)
  return response.body
})
