import { createYogaApp } from '../graphql/yoga'
import { API_CONTENT_SECURITY_POLICY, CSP_HEADER } from '../security/headers'

// yoga types its `waitUntil` for `Promise<void>`; what a resolver hands over has no value anyone
// reads, so it is narrowed to that on the way through.
const yoga = createYogaApp(({ waitUntil }) =>
  createGraphQLContext({ waitUntil: (work) => waitUntil(work.then(() => undefined)) }),
)

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  const init: RequestInit = { method: event.method, headers: { accept: 'application/json' } }
  if (event.method === 'POST') {
    // Re-serialise the body so internal (non-HTTP) Nitro calls work the same as real requests.
    init.body = JSON.stringify(await readBody(event))
    init.headers = { ...init.headers, 'content-type': 'application/json' }
  }
  // Pass the URL and init separately rather than pre-building a `Request` ourselves: Nitro's
  // ambient `Request`/`ReadableStream` globals don't always match the ponyfill classes
  // graphql-yoga's own request-parsing plugins expect, which breaks their `pipeThrough` calls.
  // Letting yoga build the Request internally keeps both sides on the same implementation.
  // The request's own `waitUntil` goes beside it, so work a resolver stops waiting for (a slow RAWG
  // page the index has already answered) is handed to Nitro rather than to yoga's in-process
  // stand-in, which knows nothing of the platform.
  const response = await yoga.fetch(url.toString(), init, {
    waitUntil: (work: Promise<unknown>) => event.waitUntil(work),
  })
  // Set here rather than in the CSP plugin: `sendWebResponse` hands yoga's own Response straight
  // to the client, so this route never reaches the `beforeResponse` hook the plugin back-fills
  // from. See `API_CONTENT_SECURITY_POLICY` for why this endpoint gets its own, tighter policy.
  setResponseHeader(event, CSP_HEADER, API_CONTENT_SECURITY_POLICY)
  return sendWebResponse(event, response)
})
