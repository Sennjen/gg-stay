import { defineEventHandler, readBody, setResponseHeaders, setResponseStatus } from 'h3'
import { askStubResponse } from './stub'

/**
 * `askStubResponse` as a Nitro handler, mounted at `POST /api/ask` by the page's SSR suite
 * (`tests/e2e/ask.test.ts`) so the server render can be checked without the real endpoint.
 */
export default defineEventHandler(async (event) => {
  const response = askStubResponse(await readBody(event).catch(() => null))
  setResponseStatus(event, response.status)
  if (response.headers) setResponseHeaders(event, response.headers)
  return response.body
})
