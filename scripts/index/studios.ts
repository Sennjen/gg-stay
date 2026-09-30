import { fetchGamesPage, PAGES_PER_LOCK_RENEWAL, toIndexedGame } from './candidates'
import { assertWithinFailureBudget, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import { UpstreamError } from '../../server/upstream/errors'
import { UKRAINIAN_STUDIO_SLUGS } from '../../shared/ukrainianStudios'

/**
 * Stage 1b, full runs only: the games made in Ukraine. For every RAWG developer slug of the studio
 * list (`data/ukrainian-studios.json`) it reads that studio's games, most added first, and marks
 * each one `madeInUkraine`. A game already on the popularity list only gains the flag; a game that
 * is not is appended to the list, so the later stages give it an app id, a price and languages
 * exactly as they do a candidate — to them it is just one more game.
 *
 * The flag is recomputed from the list on every full run, never carried forward: a studio taken
 * off the list takes its flags with it on the next night. The candidates' carry-forward therefore
 * copies prices and languages only, and it runs before this stage marks anything, so it cannot
 * wipe a flag this stage sets.
 *
 * Cost: one RAWG request per slug, two for a studio with more than forty games — 33 to 66 a night
 * today, plus one app-id lookup per appended game the first time it is seen (the mapping is
 * permanent). The number appended is bounded, and when the bound bites the least popular games
 * are the ones left out.
 *
 * A slug that fails is logged, counted and skipped, like an item of any other stage; more than 5 %
 * of the slugs failing fails the stage. A slug RAWG does not know at all (a 404) is not an outage
 * but a list entry to correct, so it is logged by name and not counted.
 */

export const STUDIO_PAGE_SIZE = 40
/** Pages read per studio at most; `next` is followed up to here. */
export const STUDIO_MAX_PAGES = 2
/** Games a run may add beyond the popularity list, all studios together. */
export const MAX_STUDIO_GAMES_APPENDED = 400

export interface StudiosOptions {
  /** RAWG developer slugs to read; the whole studio list by default. */
  slugs?: readonly string[]
  maxAppended?: number
}

export interface StudiosResult {
  /** The games this stage added to the list, flagged, most popular first. */
  appended: IndexedGame[]
  /** Games already on the list that gained the flag. */
  flagged: number
  /** Studio games left out by `maxAppended`. */
  dropped: number
  /** RAWG requests this stage made, retries of empty pages included. */
  requests: number
  /** Slugs attempted, and those that failed. */
  attempted: number
  failures: number
  /** Slugs RAWG answered with a 404. */
  unknown: string[]
}

function isNotFound(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === 'NOT_FOUND'
}

/**
 * Flags the studio games found in `games` and appends the others to it, in place — the same array
 * the later stages walk.
 */
export async function collectStudioGames(
  deps: JobDeps,
  games: IndexedGame[],
  options: StudiosOptions = {},
): Promise<StudiosResult> {
  const slugs = options.slugs ?? UKRAINIAN_STUDIO_SLUGS
  const maxAppended = options.maxAppended ?? MAX_STUDIO_GAMES_APPENDED

  let requests = 0
  const counted: JobDeps = {
    ...deps,
    rawg: (...args) => {
      requests += 1
      return deps.rawg(...args)
    },
  }

  const listed = new Map(games.map((game) => [game.id, game]))
  const outside = new Map<number, IndexedGame>()
  let flagged = 0
  let failures = 0
  let pagesFetched = 0
  const unknown: string[] = []

  for (const slug of slugs) {
    try {
      for (let page = 1; page <= STUDIO_MAX_PAGES; page += 1) {
        const response = await fetchGamesPage(
          counted,
          { developers: slug, ordering: '-added', page_size: STUDIO_PAGE_SIZE, page },
          `page ${page} of the games by ${slug}`,
        )
        pagesFetched += 1

        for (const raw of response.results) {
          const game = toIndexedGame(raw)
          if (!game) continue
          const candidate = listed.get(game.id)
          if (candidate) {
            if (!candidate.madeInUkraine) flagged += 1
            candidate.madeInUkraine = true
          } else if (!outside.has(game.id)) {
            outside.set(game.id, { ...game, madeInUkraine: true })
          }
        }

        if (pagesFetched % PAGES_PER_LOCK_RENEWAL === 0) await deps.writer.renewLock()
        if (!response.next) break
      }
    } catch (error) {
      if (isNotFound(error)) {
        unknown.push(slug)
        continue
      }
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      deps.log(`studios: the games by ${slug} could not be read (${message}), skipping it`)
    }
  }

  if (unknown.length > 0) {
    deps.log(`studios: RAWG knows no developer ${unknown.join(', ')}; check the studio list`)
  }
  assertWithinFailureBudget('studios', failures, slugs.length)

  const ranked = [...outside.values()].sort((a, b) => b.popularity - a.popularity || a.id - b.id)
  const appended = ranked.slice(0, maxAppended)
  const dropped = ranked.length - appended.length
  games.push(...appended)

  if (dropped > 0) {
    deps.log(`studios: dropped ${dropped} studio games past the bound of ${maxAppended}`)
  }
  deps.log(
    `studios: ${flagged} listed games flagged, ${appended.length} added, ` +
      `${failures} of ${slugs.length} studios failed, ${requests} RAWG requests`,
  )
  return {
    appended,
    flagged,
    dropped,
    requests,
    attempted: slugs.length,
    failures,
    unknown,
  }
}
