import { createSharedLevel, type SharedLevel } from '../upstream/layeredCache'
import { keepRunning } from './keepRunning'
import { createRuntimeCacheStore } from './runtimeCache'

/**
 * Where the upstream caches get their shared level from — and whether they get one.
 *
 * Only a function running on Vercel has it, and not in fixture mode: the Runtime Cache is the
 * platform's, and a deployment that serves recorded fixtures asks no upstream anything worth
 * keeping. Everywhere else — development, the tests, the CI quality gates, a server of one's own —
 * there is no shared level, and every cache built on this is the memory it always was.
 *
 * `VERCEL` is the platform's own variable: `1` wherever it runs the project's code, for a project
 * that exposes its system variables, as this one's build already expects (`nuxt.config.ts` reads
 * `VERCEL_ENV`). It is read when the first cache is built, not when this module loads, like
 * everything else the caches are built from.
 */
export function sharedLevelFor(
  where: { vercel: string | undefined; fixtures: boolean },
  create: () => SharedLevel = createRuntimeLevel,
): SharedLevel | undefined {
  return where.vercel && !where.fixtures ? create() : undefined
}

/**
 * The Runtime Cache behind its guards. A write is kept alive by the request it belongs to
 * (`keepRunning`), which is what lets it finish after the answer has gone out.
 */
function createRuntimeLevel(): SharedLevel {
  return createSharedLevel(createRuntimeCacheStore(), {
    now: () => Date.now(),
    keepAlive: keepRunning,
  })
}

let decided: { shared: SharedLevel | undefined } | undefined

/**
 * The one shared level of this process, or `undefined` where there is none. One, because its
 * pause is about the store: a read that finds it down spares every cache's next read, not only
 * its own.
 */
export function useSharedLevel(): SharedLevel | undefined {
  decided ??= {
    shared: sharedLevelFor({
      vercel: process.env.VERCEL,
      // Env overrides are parsed by destr, so "1" may arrive as the number 1.
      fixtures: String(useRuntimeConfig().rawgFixtures) === '1',
    }),
  }
  return decided.shared
}
