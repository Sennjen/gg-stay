import { createHash } from 'node:crypto'
import { createSteamFetch, type SteamCacheEntry, type SteamFetch } from '../steam/steamFetch'
import { createLayeredCache } from '../upstream/layeredCache'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'
import { useSharedLevel } from './sharedCache'

let instance: SteamFetch | undefined

/**
 * How many Steam requests an instance of the site may send together through a limiter that has
 * been idle: three, on each of its two Steam transports — Steam's page about an app (`useSteam`
 * below), which is where a game's Ukrainian description comes from, and the live price
 * (`useSteamPrices`). The rate in the long run is unchanged, a request per second and a half
 * (`UpstreamConfig.burst`).
 *
 * A game page asks Steam for its description and gives the answer a second and a half
 * (`STEAM_DESCRIPTION_BUDGET_MS`). At a request per second and a half and nothing else, game
 * pages opened in quick succession — a visitor clicking through two or three, two visitors at
 * once on one instance — each waited at our own limiter for the one before: 1 042 ms at the
 * median on production on 2026-10-12, where a page opened after a pause waited about 0.2 s, for
 * Steam alone (`docs/perf/README.md`, step 9). With three, the descriptions of three such pages
 * leave together. A fourth asked for in the same moment still waits its second and a half, which
 * is all the description is given, and goes out with RAWG's text, as before.
 *
 * What it adds to what Steam is sent. Steam's limit is undocumented; roughly 200 requests in
 * five minutes is what the interval was sized against, and a request per second and a half is
 * exactly 200 in five minutes. A limiter with this burst can send `STEAM_BURST - 1` more in any
 * five minutes: 202. That is counted for each of the two transports separately. They have a
 * limiter each, so together they could already send 400 in five minutes before either had a
 * burst, and can send 404 now — and each instance of the function has its own pair, as it always
 * had. A retry is counted like any request, and so takes the next request of the allowance: the
 * retry of a request that failed quickly leaves at once, where it used to wait out its second
 * and a half.
 *
 * Nothing but Steam's answers says whether that is welcome, so the sign to set this back to 1 is
 * read from the function log, against what the log showed before the change:
 *
 * - a Steam attempt line ending in `RATE_LIMITED (429)`, the refusal the transport does not
 *   retry: `[upstream] STEAM 292030 attempt 1: 41 ms, RATE_LIMITED (429)`. Steam sometimes
 *   refuses with a 403 instead, and the transport calls only a 429 a rate limit, so that line
 *   ends in `ERROR (403)`;
 * - more lines ending in `ERROR` or in `TIMEOUT` than before.
 *
 * A request Steam refuses never costs a visitor the page. It costs the Ukrainian description —
 * RAWG's text is shown in its place (`localizedDescription`) — or a fresher price: the index's
 * stands, and a Steam game the index does not hold shows its link without one
 * (`server/graphql/resolvers/game.ts`); or, on the landing, the trailer Steam would have given.
 *
 * The site's alone. The refresh job builds its own Steam transports
 * (`scripts/index/upstreams.ts`) and names no burst, so every price and language read of a run
 * goes out a request per second and a half, as it always did.
 */
export const STEAM_BURST = 3

// For the shared level's key alone, so that every key there has one shape whatever it was made
// from (`SHARED_CACHE_SCHEMA`).
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useSteam(): SteamFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:steam-fixtures')
  const now = () => Date.now()
  // No key hash here, unlike RAWG: a Steam cache key is a bare numeric app id, which carries no
  // `:` for unstorage to read as a namespace separator.
  const memory = createBoundedCache<SteamCacheEntry>({
    storage: useStorage('cache:steam'),
    maxEntries: MAX_CACHE_ENTRIES,
    now,
  })
  // As in `useRawg`: the shared level on Vercel outside fixture mode, and `memory` itself anywhere
  // else. Unlike RAWG's, this transport is given no keep-alive: nothing of Steam's is served past
  // its day (`createSteamFetch` says why), so there is never a refresh to keep running.
  const shared = useSharedLevel()

  instance = createSteamFetch({
    // One switch drives fixture mode for every upstream, hence `rawgFixtures` here too: a local
    // run either talks to real third-party APIs or to none of them. `.env.example` documents it.
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      return { status: response.status, body }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    cache: createLayeredCache({ memory, shared, source: 'STEAM', hashKey, now }),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    burst: STEAM_BURST,
  })
  return instance
}
