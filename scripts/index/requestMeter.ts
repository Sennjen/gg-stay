/**
 * A count of the requests the job sends one upstream, and a limit on them that the upstream's
 * transport cannot get past.
 *
 * It exists for RAWG's quota. RAWG's free plan is a number of requests a period, and it counts
 * requests, not the calls a stage makes: a call that times out or meets a 5xx is sent again by the
 * transport (`createUpstreamFetch`), and a page that comes back without a list is asked for once
 * more by `fetchGamesPage`. A stage that counted its own calls would miss both. So the count is
 * taken where a request is handed to the network and nowhere else — `createJobRawg` calls `take`
 * immediately before every `fetch` — and what a stage reads here is what was sent: first attempts
 * and retries alike, and nothing that the transport's cache answered.
 *
 * The limit is enforced in the same place, for the same reason. `take` refuses the request that
 * would be one too many before it is sent, whoever asked for it, so no retry and no second ask can
 * spend what the run was not given. A stage working inside a limit looks at `remaining` before it
 * starts a call, to stop in good order; the refusal is what makes the limit hold when a call turns
 * out to need more requests than were left.
 */
export interface RequestMeter {
  /**
   * Counts the request that is about to be sent, or throws — and counts nothing — when the limit
   * is spent. Called by the transport's wiring, immediately before the request leaves.
   */
  take(): void
  /** Requests sent since the meter was made: every attempt of every call. */
  issued(): number
  /** Requests `take` turned away at the limit. None of them was sent. */
  refused(): number
  /** How many more requests may be sent: infinite while no limit is set, and never below zero. */
  remaining(): number
  /** Whether a limit has been set. */
  limited(): boolean
  /**
   * From here on at most `requests` more are sent. A limit can be tightened and never loosened:
   * setting a second one that would allow more than the first leaves the first in force.
   */
  limitTo(requests: number): void
}

/** What a request refused at the limit fails with, before the transport gives it its own name. */
export const REQUEST_LIMIT_MESSAGE =
  'The request limit of this run is spent; the request was not sent'

export function createRequestMeter(): RequestMeter {
  let issued = 0
  let refused = 0
  /** The count `issued` may reach, or infinity. */
  let ceiling = Number.POSITIVE_INFINITY

  return {
    take() {
      if (issued >= ceiling) {
        refused += 1
        throw new Error(REQUEST_LIMIT_MESSAGE)
      }
      issued += 1
    },
    issued: () => issued,
    refused: () => refused,
    remaining: () => Math.max(0, ceiling - issued),
    limited: () => Number.isFinite(ceiling),
    limitTo(requests) {
      if (!Number.isSafeInteger(requests) || requests < 0) {
        throw new Error(`A request limit must be a whole number of requests, got ${requests}.`)
      }
      ceiling = Math.min(ceiling, issued + requests)
    },
  }
}
