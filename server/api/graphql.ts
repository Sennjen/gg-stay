import { createYogaApp } from '../graphql/yoga'
import { useGameIndex } from '../index/index'
import { API_CONTENT_SECURITY_POLICY, CSP_HEADER } from '../security/headers'

const yoga = createYogaApp(async () => {
  // One clock read per request: `today` and `now` are the same instant, so how stale the index is
  // and how old a price is are measured against one moment, and no render path reads a clock.
  const now = new Date().toISOString()
  return {
    rawg: useRawg(),
    steam: useSteam(),
    today: now.slice(0, 10),
    now,
    // Never rejects and never remembers a failure — see server/index/index.ts.
    index: await useGameIndex(),
    steamPrices: useSteamPrices(),
    cache: useResolverCache(),
  }
})

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
  const response = await yoga.fetch(url.toString(), init)
  // Set here rather than in the CSP plugin: `sendWebResponse` hands yoga's own Response straight
  // to the client, so this route never reaches the `beforeResponse` hook the plugin back-fills
  // from. See `API_CONTENT_SECURITY_POLICY` for why this endpoint gets its own, tighter policy.
  setResponseHeader(event, CSP_HEADER, API_CONTENT_SECURITY_POLICY)
  return sendWebResponse(event, response)
})
