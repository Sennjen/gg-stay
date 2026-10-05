import { waitUntil } from '@vercel/functions'

/**
 * Keeps `work` running after the response has been sent, for the one kind of work a request
 * deliberately stops waiting for: a slow RAWG page the index has already answered, whose response
 * should still land in the RAWG cache for the next visitor.
 *
 * On Vercel a function may be frozen the moment it has answered. `@vercel/functions` reads the
 * platform's own per-request context, so this needs no h3 event and works the same from
 * `/api/graphql` and from `/api/ask`. Nitro's `event.waitUntil` would not do: the Vercel preset
 * never gives it a platform hook to forward to, so it only records the promise. Anywhere else —
 * development, tests, a plain Node server — there is no such context and this does nothing, which
 * is fine there: a long-lived process finishes the work by itself.
 *
 * Nothing here catches. What is handed over must already have its rejection handled.
 */
export function keepRunning(work: Promise<unknown>): void {
  waitUntil(work)
}
