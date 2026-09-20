import type { AppIdMap } from './appIds'
import { assertWithinFailureBudget, isoNow, type JobDeps } from './deps'
import type { IndexedGame, IndexedLanguages } from '../../server/index/document'
import type { SteamPrice } from '../../server/steam/price'

/**
 * Stage 4: Ukrainian localisation, and the one thing the batched price call cannot answer.
 *
 * `supported_languages` is not available under `filters=price_overview`, so it costs one
 * unfiltered request per game — 3 000 of them at Steam's tolerance is over an hour. What keeps
 * that affordable is that the answer is stored per app, outside the version prefix
 * (`lang:{appId}`), and the list changes very rarely: the work list is "no record, or a record
 * older than a week", and everything else is applied from the store without a request. That also
 * makes the stage resumable without a cursor. A run that dies has still saved every app it read,
 * so the next run's work list is simply shorter — and it is the same work list in every mode,
 * because it is derived from the data rather than from where some previous run stopped.
 *
 * The nightly full run takes a budget (`LANGUAGE_BUDGET`): every app with no record at all — a new
 * game must not wait a week for its badge — plus the oldest stale ones up to the budget. The
 * weekly run takes no budget and sweeps the rest. Without that, whichever run fires first on the
 * day the whole catalog's stamps expire pays for all 3 000 reads, and that is the unattended
 * nightly one.
 *
 * The same response settles the free-versus-unavailable question the price stage had to leave
 * open: `data: []` under the price filter means either "free" or "not sold in Ukraine", and only
 * the unfiltered call's `is_free` tells them apart — in both directions, so a game Steam no longer
 * reports as free stops being free here. It also carries a price of its own for some apps the
 * batched call would not price, and that price is used for a game that has none: it belongs to
 * this run rather than to the stored record, so it is kept in the stage and not in
 * `IndexedLanguages`, which is the language answer and nothing else.
 *
 * One app failing is not the run failing. It is counted, no record is written, and the next run
 * sees it as due again — otherwise a single delisted app would block the weekly refresh for good.
 */

export const LANGUAGE_MAX_AGE_DAYS = 7

/**
 * Steam tolerates roughly this many unfiltered app requests a minute. The per-app transport
 * spaces its own requests 1 500 ms apart (`server/steam/steamFetch.ts`), which is the same rate;
 * this limiter is deliberately belt-and-braces, because it is the job that knows it is about to
 * make three thousand of them in a row, and it is measured on the job's clock so a test can see
 * it without waiting.
 */
export const LANGUAGE_REQUESTS_PER_MINUTE = 40

/** How many stale apps a run that is not the weekly sweep will re-read. */
export const LANGUAGE_BUDGET = 300

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const LANGUAGE_WRITE_BATCH = 50

export interface LanguagesOptions {
  maxAgeDays?: number
  requestsPerMinute?: number
  /** How many *stale* apps this run may re-read; apps with no record at all are always read. */
  budget?: number
  /** How many records to accumulate before one `setLanguages` round trip. */
  batchSize?: number
}

export interface LanguagesResult {
  /** Apps read from Steam in this run. */
  fetched: number
  /** Games given a price by the unfiltered response that the batched one would not price. */
  pricesFilled: number
  /** Apps applied from a stored record without a request. */
  fromStore: number
  failures: number
  /** Stale apps the budget left for the next run. */
  deferred: number
  /** Games whose price this stage changed, which decides whether the price stamp may move. */
  pricesTouched: number
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

function ageOf(record: IndexedLanguages, now: number): number {
  const age = now - Date.parse(record.updatedAt)
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY
}

export async function refreshLanguages(
  deps: JobDeps,
  games: IndexedGame[],
  appIds: AppIdMap,
  options: LanguagesOptions = {},
): Promise<LanguagesResult> {
  const maxAgeDays = options.maxAgeDays ?? LANGUAGE_MAX_AGE_DAYS
  const budget = options.budget ?? Number.POSITIVE_INFINITY
  const batchSize = options.batchSize ?? LANGUAGE_WRITE_BATCH
  const take = createLimiter(deps, options.requestsPerMinute ?? LANGUAGE_REQUESTS_PER_MINUTE)

  const withPage = games.flatMap((game) => {
    const appId = appIds.get(game.id)
    return appId ? [{ game, appId }] : []
  })
  const apps = [...new Set(withPage.map((entry) => entry.appId))]
  const stored = await deps.writer.getLanguages(apps)

  const now = deps.clock.now()
  const missing = apps.filter((appId) => !stored.has(appId))
  const stale = apps
    .filter((appId) => {
      const record = stored.get(appId)
      return record !== undefined && ageOf(record, now) >= maxAgeDays * DAY_MS
    })
    // Oldest first, so a budgeted run always spends itself on whatever is furthest out of date.
    .sort((left, right) => ageOf(stored.get(right)!, now) - ageOf(stored.get(left)!, now))

  const queue = [...missing, ...stale.slice(0, budget === Infinity ? stale.length : budget)]
  const deferred = stale.length - (queue.length - missing.length)

  let fetched = 0
  let failures = 0
  let batch: [string, IndexedLanguages][] = []
  // Prices this run happened to see. A stored record carries no price, so only an app actually
  // read this run can fill one in.
  const pricesSeen = new Map<string, SteamPrice>()

  async function flush(): Promise<void> {
    if (batch.length === 0) return
    await deps.writer.setLanguages(batch)
    batch = []
    // An hour of Steam reads is the longest stretch of a run; the lock needs a sign of life in it.
    await deps.writer.renewLock()
  }

  try {
    for (const appId of queue) {
      await take()
      try {
        const details = await deps.steam.fetchAppLanguages(appId)
        const record: IndexedLanguages = {
          text: details.ukrainian.text,
          audio: details.ukrainian.audio,
          isFree: details.isFree,
          updatedAt: isoNow(deps.clock),
        }
        stored.set(appId, record)
        batch.push([appId, record])
        if (details.price) pricesSeen.set(appId, details.price)
        fetched += 1
        if (batch.length >= batchSize) await flush()
      } catch {
        // No record written on purpose: the next run sees it as due again.
        failures += 1
        deps.log(`languages: app ${appId} failed, leaving its record as it was`)
      }
    }
  } finally {
    // Every app already read is quota already spent; keep it even if the stage is giving up.
    await flush()
  }
  assertWithinFailureBudget('languages', failures, queue.length)

  let fromStore = 0
  let pricesTouched = 0
  let pricesFilled = 0
  for (const { game, appId } of withPage) {
    const record = stored.get(appId)
    if (!record) continue
    game.localisation = {
      text: record.text,
      audio: record.audio,
      source: 'steam',
      updatedAt: record.updatedAt,
    }
    fromStore += 1

    if (record.isFree) {
      if (!game.free || game.priceUah !== 0) pricesTouched += 1
      game.free = true
      game.priceUah = 0
      game.regularPriceUah = 0
      game.discountPercent = 0
      game.priceUpdatedAt = record.updatedAt
      continue
    }

    if (game.free) {
      // Steam no longer calls it free. A real price may already have been attached this run;
      // only the zero one is a leftover of a flag that is no longer true.
      game.free = false
      if (game.priceUah === 0) {
        game.priceUah = null
        game.regularPriceUah = null
        game.discountPercent = 0
        game.priceUpdatedAt = null
      }
      pricesTouched += 1
    }

    const seen = pricesSeen.get(appId)
    if (seen && game.priceUah === null) {
      game.priceUah = seen.priceUah
      game.regularPriceUah = seen.regularPriceUah
      game.discountPercent = seen.discountPercent
      game.priceUpdatedAt = record.updatedAt
      pricesFilled += 1
      pricesTouched += 1
    }
  }

  deps.log(
    `languages: ${fetched} apps read, ${failures} failed, ${fromStore} games given their flags, ${pricesFilled} given a price, ${deferred} apps left for the next run`,
  )
  return { fetched, pricesFilled, fromStore, failures, deferred, pricesTouched }
}
