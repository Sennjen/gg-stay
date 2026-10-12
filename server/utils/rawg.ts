import { createHash } from 'node:crypto'
import { withoutLinkQueries } from '../rawg/paginationLinks'
import { createRawgFetch, type CacheEntry, type RawgFetch } from '../rawg/rawgFetch'
import { createLayeredCache } from '../upstream/layeredCache'
import { createBoundedCache, MAX_CACHE_ENTRIES } from './boundedCache'
import { keepRunning } from './keepRunning'
import { useSharedLevel } from './sharedCache'

let instance: RawgFetch | undefined

/**
 * How many RAWG requests an instance of the site may send together when its limiter has been
 * idle: three, which is what a game page asks for — the game, its store links and its
 * screenshots. A quarter of a second apart, a first open that missed the caches waited half a
 * second for nothing but our own pacing. The rate in the long run is unchanged, four requests a
 * second (`UpstreamConfig.burst`).
 *
 * It is a trial on production. RAWG publishes a monthly quota and no limit per second, so nothing
 * says three at once are welcome, and nothing but RAWG's answers can — and how RAWG would refuse
 * them is not known either. So the sign to set this back to 1 is any rise in RAWG's refusals
 * after the change, read from the function log against what the log showed before it:
 *
 * - the transport's line about an attempt, ending in `RATE_LIMITED (429)`, which is the one
 *   refusal it does not retry:
 *   `[upstream] RAWG games/portal-2 attempt 1: 38 ms, RATE_LIMITED (429)`;
 * - the same line ending in `ERROR` — with a 5xx, or with no status for a connection that was
 *   dropped — or in `TIMEOUT`, more often than before: a refusal need not come as a 429;
 * - a game page that went out partial because RAWG refused its store links or its screenshots,
 *   or was answered from the index for a refused detail (`server/graphql/resolvers/game.ts`):
 *   `[game] RAWG store links refused (RATE_LIMITED), answered without them`,
 *   `[game] RAWG failed (RATE_LIMITED), answered from the index`.
 *
 * A burst is sent only for what no cache holds — a game page opened cold, a stale one, whose
 * three refreshes leave together too, a cold landing — so a look at warm pages proves nothing.
 *
 * The site's alone. The refresh job builds its own RAWG transport (`scripts/index/upstreams.ts`)
 * and names no burst, so it walks RAWG a request per quarter of a second, as it always did; and
 * neither Steam transport has one. The job writes no attempt lines either: a request an upstream
 * refuses it is counted by the stage that made it, and the job's own run summary is where its
 * failures show.
 */
export const RAWG_BURST = 3

// unstorage treats `:` in a key as a namespace separator, and a normalised cache key carries the
// query string verbatim. Hashing sidesteps that entirely and gives every key the same shape — and
// is what keeps a visitor's search out of the key the shared level stores an answer under.
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function useRawg(): RawgFetch {
  if (instance) return instance
  const config = useRuntimeConfig()
  const fixtures = useStorage('assets:rawg-fixtures')
  const now = () => Date.now()
  const memory = createBoundedCache<CacheEntry>({
    storage: useStorage('cache:rawg'),
    maxEntries: MAX_CACHE_ENTRIES,
    now,
    hashKey,
  })
  // On Vercel, outside fixture mode: the cache every instance shares, behind this instance's
  // memory. Anywhere else there is none, and the cache below is `memory` itself.
  const shared = useSharedLevel()

  instance = createRawgFetch({
    apiKey: String(config.rawgApiKey ?? ''),
    // Env overrides are parsed by destr, so "1" may arrive as the number 1.
    fixtures: String(config.rawgFixtures) === '1',
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal })
      const body: unknown = await response.json().catch(() => null)
      // RAWG's links to the neighbouring pages repeat the request's address, API key included.
      // They are cut here, before the transport has the body, so that nothing the site keeps —
      // in memory or in the shared cache — holds the key or a visitor's search.
      return { status: response.status, body: withoutLinkQueries(body) }
    },
    readFixture: async (name) => (await fixtures.getItem(`${name}.json`)) ?? null,
    cache: createLayeredCache({ memory, shared, source: 'RAWG', hashKey, now }),
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    burst: RAWG_BURST,
    // The stale window comes with the shared level and with nothing else: a week-old answer is
    // worth serving where it can be refreshed behind the response and kept for every instance,
    // and off Vercel the transport answers exactly as it did before there was a window.
    keepAlive: shared ? keepRunning : undefined,
  })
  return instance
}
