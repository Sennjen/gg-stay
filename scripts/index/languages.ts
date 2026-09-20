import type { AppIdMap } from './appIds'
import { isoNow, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'

/**
 * Stage 4: Ukrainian localisation, and the one thing the batched price call cannot answer.
 *
 * `supported_languages` is not available under `filters=price_overview`, so it costs one
 * unfiltered request per game — 3 000 of them at Steam's tolerance is over an hour. Two things
 * keep that affordable: the list changes very rarely, so a game is re-read only when its stored
 * flags are missing or older than a week (everything else is carried forward from the published
 * version through the reader), and each attempt can stop at a request budget and resume at the
 * cursor on the next run.
 *
 * The same response settles the free-versus-unavailable question the price stage had to leave
 * open: `data: []` under the price filter means either "free" or "not sold in Ukraine", and only
 * the unfiltered call's `is_free` tells them apart. A game it confirms free gets a zero price; a
 * game it does not stays without one.
 *
 * One app failing is not the run failing. It is counted, its flags are left stale, and it is
 * picked up by the next run — otherwise a single delisted app would block the weekly refresh for
 * good.
 */

export const LANGUAGES_STAGE = 'languages'
export const LANGUAGE_MAX_AGE_DAYS = 7
/** Steam tolerates roughly this many unfiltered app requests a minute from one client. */
export const LANGUAGE_REQUESTS_PER_MINUTE = 40

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export interface LanguagesOptions {
  maxAgeDays?: number
  requestsPerMinute?: number
  /** How many games this attempt may read at most; the rest wait for the next run. */
  limit?: number
}

export interface LanguagesResult {
  /** Games read from Steam in this attempt. */
  fetched: number
  /** Games whose flags came from the published version instead of a request. */
  carriedForward: number
  failures: number
}

function isFresh(game: IndexedGame, now: number, maxAgeDays: number): boolean {
  const updatedAt = game.localisation?.updatedAt
  if (!updatedAt) return false
  const age = now - Date.parse(updatedAt)
  return Number.isFinite(age) && age < maxAgeDays * DAY_MS
}

/** At most `perMinute` calls in any rolling minute, measured on the job's clock. */
function createLimiter(deps: JobDeps, perMinute: number) {
  const recent: number[] = []
  return async function take(): Promise<void> {
    const now = deps.clock.now()
    while (recent.length > 0 && now - recent[0]! >= MINUTE_MS) recent.shift()
    if (recent.length >= perMinute) {
      await deps.clock.sleep(MINUTE_MS - (now - recent[0]!))
      return take()
    }
    recent.push(deps.clock.now())
  }
}

export async function refreshLanguages(
  deps: JobDeps,
  games: IndexedGame[],
  appIds: AppIdMap,
  options: LanguagesOptions = {},
): Promise<LanguagesResult> {
  const maxAgeDays = options.maxAgeDays ?? LANGUAGE_MAX_AGE_DAYS
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const take = createLimiter(deps, options.requestsPerMinute ?? LANGUAGE_REQUESTS_PER_MINUTE)

  const withPage = games.filter((game) => appIds.get(game.id))
  const published = await deps.writer.getMany(withPage.map((game) => game.id))

  let carriedForward = 0
  for (const game of withPage) {
    if (game.localisation) continue
    const carried = published.get(game.id)?.localisation
    if (!carried) continue
    game.localisation = { ...carried }
    carriedForward += 1
  }

  const now = deps.clock.now()
  const stale = withPage.filter((game) => !isFresh(game, now, maxAgeDays))

  const cursor = await deps.writer.getCursor(LANGUAGES_STAGE)
  const resumeAt = cursor ? stale.findIndex((game) => String(game.id) === cursor) + 1 : 0
  const queue = stale.slice(resumeAt)

  let fetched = 0
  let failures = 0
  for (const game of queue) {
    if (fetched + failures >= limit) break
    const appId = appIds.get(game.id)!
    await take()
    try {
      const details = await deps.steam.fetchAppLanguages(appId)
      game.localisation = {
        text: details.ukrainian.text,
        audio: details.ukrainian.audio,
        source: 'steam',
        updatedAt: isoNow(deps.clock),
      }
      if (details.isFree) {
        game.free = true
        game.priceUah = 0
        game.regularPriceUah = 0
        game.discountPercent = 0
        game.priceUpdatedAt = isoNow(deps.clock)
      } else if (details.price && game.priceUah === null) {
        game.priceUah = details.price.priceUah
        game.regularPriceUah = details.price.regularPriceUah
        game.discountPercent = details.price.discountPercent
        game.priceUpdatedAt = isoNow(deps.clock)
      }
      fetched += 1
    } catch {
      // Left stale on purpose: the next run sees it as due again.
      failures += 1
      deps.log(`languages: app ${appId} failed, leaving its flags as they were`)
    }
    await deps.writer.setCursor(LANGUAGES_STAGE, String(game.id))
  }

  const done = fetched + failures >= queue.length
  if (done) await deps.writer.clearCursor(LANGUAGES_STAGE)

  deps.log(
    `languages: ${fetched} read, ${carriedForward} carried forward, ${failures} failed${
      done ? '' : ', budget reached'
    }`,
  )
  return { fetched, carriedForward, failures }
}
