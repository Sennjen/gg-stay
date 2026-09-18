import { createYogaApp } from '../graphql/yoga'

const yoga = createYogaApp(() => ({
  rawg: useRawg(),
  today: new Date().toISOString().slice(0, 10),
}))

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
  return sendWebResponse(event, response)
})
