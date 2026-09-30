import { fetchGamesPage, PAGES_PER_LOCK_RENEWAL, toIndexedGame } from './candidates'
import { assertWithinFailureBudget, isoNow, type JobDeps } from './deps'
import type { IndexedGame } from '../../server/index/document'
import type { RawgGameListItem } from '../../server/rawg/types'
import { UpstreamError } from '../../server/upstream/errors'
import { UKRAINIAN_STUDIOS, UKRAINIAN_STUDIO_SLUGS } from '../../shared/ukrainianStudios'

/**
 * Stage 1b, full runs only: the games made in Ukraine. For every RAWG developer slug of the studio
 * list (`data/ukrainian-studios.json`) it reads that studio's games, most added first, and marks
 * each one `madeInUkraine`, noting the slug on the document (`studioSlugs`). A game already on the
 * popularity list only gains the flag; a game that is not is appended to the list, so the later
 * stages give it an app id, a price and languages exactly as they do a candidate — to them it is
 * just one more game.
 *
 * The flag is recomputed from the list on every full run: a studio taken off the list takes its
 * flags with it on the next night. The candidates' carry-forward copies prices and languages only,
 * and it runs before this stage marks anything, so it cannot wipe a flag this stage sets.
 *
 * What the stage cannot read tonight it keeps as published, like every other stage of the job:
 *
 * - a slug that failed, that RAWG does not know (404) or that listed no games keeps the published
 *   games noted under it — flagged in place when they are candidates, re-appended otherwise. For
 *   a 404 or an empty list that lasts at most `KEEP_UNCONFIRMED_DAYS` after the game was last
 *   found (`studioSeenAt`): a slug RAWG renamed must not freeze its games in the index for good;
 * - a run that still ends with fewer than half the published version's games made in Ukraine —
 *   RAWG answering every studio with nothing, or a version published before games carried their
 *   slugs — keeps every published flag and appended game, and says it is degraded. It does not
 *   fail: the rest of the run is worth publishing, and the shelf keeps what it had.
 *
 * Both only ever keep a game that is still attributable to the list: one noted under a slug the
 * list still carries, or a legacy one noted under none. A studio taken off the data file is gone
 * the next night, and does not count towards the published figure a degraded night is measured
 * against, so removing it cannot hold the stage in the degraded state.
 *
 * Cost: one RAWG request per slug, two for a studio with more than forty games — 33 to 66 a night
 * today, plus one app-id lookup per appended game the first time it is seen (the mapping is
 * permanent), and one read of the published documents. The number appended is bounded, and when
 * the bound bites the least popular games are the ones left out.
 *
 * A slug that fails is logged, counted and skipped; more than 5 % of the slugs failing fails the
 * stage. So does a slug whose list is implausibly long, which is what RAWG ignoring the developer
 * filter looks like — flagging the whole catalog would be worse than a red run. A slug RAWG does
 * not know at all is not an outage but a list entry to correct: it is not counted, but it is raised
 * as a GitHub Actions warning and listed in the job summary.
 */

export const STUDIO_PAGE_SIZE = 40
/** Pages read per studio at most; `next` is followed up to here. */
export const STUDIO_MAX_PAGES = 2
/** Games a run may add beyond the popularity list, all studios together. */
export const MAX_STUDIO_GAMES_APPENDED = 400
/** More games than this under one developer means RAWG did not apply the filter. */
export const MAX_PLAUSIBLE_STUDIO_GAMES = 2_000
/** Below this share of the published count of games made in Ukraine, the stage is degraded. */
export const MIN_MADE_IN_UKRAINE_RATIO = 0.5
/** How long a game of a slug that answers 404 or nothing is kept after it was last found. */
export const KEEP_UNCONFIRMED_DAYS = 7
const DAY_MS = 86_400_000

/** What one slug gave tonight: games, an error, a 404, or an empty list. */
export type SlugOutcome = 'read' | 'failed' | 'unknown' | 'empty'

export interface StudiosOptions {
  /** RAWG developer slugs to read; the whole studio list by default. */
  slugs?: readonly string[]
  maxAppended?: number
}

export interface StudiosResult {
  /** The games this stage added to the list, flagged, most popular first. */
  appended: IndexedGame[]
  /** Games already on the list that gained the flag from tonight's answers. */
  flagged: number
  /** Studio games left out by `maxAppended`. */
  dropped: number
  /** Games flagged only because the published version had them and tonight could not say. */
  kept: number
  /** Published games of a 404 or empty slug not found for `KEEP_UNCONFIRMED_DAYS`, dropped. */
  expired: number
  /** Games of the list made in Ukraine once the stage is done, and in the published version. */
  madeInUkraine: number
  previousMadeInUkraine: number | null
  /** Fewer than half the published count was found, so every published flag was kept. */
  degraded: boolean
  /** RAWG requests this stage made, retries of empty pages included. */
  requests: number
  /** Slugs attempted, and the counted failures among them. */
  attempted: number
  failures: number
  /** Slugs by what they gave tonight: failed, 404, or no games. */
  failed: string[]
  unknown: string[]
  empty: string[]
  /** Studios of the list none of whose slugs gave a game tonight. */
  studiosWithoutGames: string[]
}

function isNotFound(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === 'NOT_FOUND'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const slugsOf = new Map<number, Set<string>>()
  /** When each flagged game was last found under a studio: tonight, or as published. */
  const seenAt = new Map<number, string>()
  const tonight = isoNow(deps.clock)
  let flagged = 0
  let kept = 0
  let expired = 0

  function attribute(id: number, found: readonly string[]): void {
    const known = slugsOf.get(id) ?? new Set<string>()
    for (const slug of found) known.add(slug)
    slugsOf.set(id, known)
  }

  function markFound(raw: RawgGameListItem, slug: string): void {
    const game = toIndexedGame(raw)
    if (!game) return
    const candidate = listed.get(game.id)
    if (candidate) {
      if (!candidate.madeInUkraine) flagged += 1
      candidate.madeInUkraine = true
    } else if (!outside.has(game.id)) {
      outside.set(game.id, { ...game, madeInUkraine: true })
    }
    attribute(game.id, [slug])
    seenAt.set(game.id, tonight)
  }

  /** Keeps a published flagged game that tonight's answers did not flag. */
  function keepPublished(published: IndexedGame, found: readonly string[]): void {
    const candidate = listed.get(published.id)
    if (candidate) {
      if (!candidate.madeInUkraine) kept += 1
      candidate.madeInUkraine = true
    } else if (!outside.has(published.id)) {
      outside.set(published.id, { ...published, madeInUkraine: true })
      kept += 1
    }
    attribute(published.id, found)
    if (!seenAt.has(published.id) && published.studioSeenAt) {
      seenAt.set(published.id, published.studioSeenAt)
    }
  }

  /** Found within `KEEP_UNCONFIRMED_DAYS` of tonight, going by the published `studioSeenAt`. */
  function recentlySeen(published: IndexedGame): boolean {
    const seen = published.studioSeenAt ? Date.parse(published.studioSeenAt) : Number.NaN
    return deps.clock.now() - seen <= KEEP_UNCONFIRMED_DAYS * DAY_MS
  }

  // --- Tonight's answers, slug by slug.
  const outcomes = new Map<string, SlugOutcome>()
  let pagesFetched = 0
  for (const slug of slugs) {
    let outcome: SlugOutcome = 'read'
    try {
      for (let page = 1; page <= STUDIO_MAX_PAGES; page += 1) {
        let response
        try {
          response = await fetchGamesPage(
            counted,
            { developers: slug, ordering: '-added', page_size: STUDIO_PAGE_SIZE, page },
            `page ${page} of the games by ${slug}`,
          )
        } catch (error) {
          // RAWG answers "invalid page" with a 404 when a list shrinks between two pages: the
          // first page stands, and the studio is known.
          if (page > 1 && isNotFound(error)) break
          throw error
        }
        pagesFetched += 1

        const listedCount = response.count ?? response.results.length
        if (page === 1 && listedCount > MAX_PLAUSIBLE_STUDIO_GAMES) {
          throw new Error(
            `RAWG listed ${listedCount} games for developer ${slug}, which is not one studio's list`,
          )
        }
        if (page === 1 && response.results.length === 0) outcome = 'empty'
        for (const raw of response.results) markFound(raw, slug)

        if (pagesFetched % PAGES_PER_LOCK_RENEWAL === 0) await deps.writer.renewLock()
        if (!response.next) break
      }
    } catch (error) {
      if (isNotFound(error)) {
        outcome = 'unknown'
        deps.log(
          `::warning title=Unknown studio slug::RAWG knows no developer "${slug}"; correct it in data/ukrainian-studios.json`,
        )
      } else {
        outcome = 'failed'
        deps.log(
          `studios: the games by ${slug} could not be read (${messageOf(error)}), skipping it`,
        )
      }
    }
    outcomes.set(slug, outcome)
  }

  const bySlug = (wanted: SlugOutcome) => slugs.filter((slug) => outcomes.get(slug) === wanted)
  const failed = bySlug('failed')
  const unknown = bySlug('unknown')
  const empty = bySlug('empty')
  assertWithinFailureBudget('studios', failed.length, slugs.length)
  if (empty.length > 0) deps.log(`studios: no games tonight for ${empty.join(', ')}`)

  // --- What tonight could not say, kept as published.
  const onList = new Set(slugs)
  const attributable = (game: IndexedGame) =>
    !game.studioSlugs?.length || game.studioSlugs.some((slug) => onList.has(slug))
  const meta = await deps.writer.meta()
  const published = meta
    ? (await deps.writer.allGames()).filter((game) => game.madeInUkraine && attributable(game))
    : []
  for (const game of published) {
    const lost = (game.studioSlugs ?? []).filter((slug) => {
      const outcome = outcomes.get(slug)
      return outcome !== undefined && outcome !== 'read'
    })
    if (lost.length === 0) continue
    // A failed slug is an outage and keeps its games; a 404 or an empty list keeps them a week.
    const failing = lost.some((slug) => outcomes.get(slug) === 'failed')
    if (failing || recentlySeen(game) || seenAt.has(game.id)) keepPublished(game, lost)
    else expired += 1
  }
  if (expired > 0) {
    deps.log(
      `studios: dropped ${expired} published games of unknown or empty slugs not found for ${KEEP_UNCONFIRMED_DAYS} days`,
    )
  }

  const flaggedCount = () =>
    [...listed.values()].filter((game) => game.madeInUkraine).length +
    Math.min(outside.size, maxAppended)
  const previousMadeInUkraine = meta ? published.length : null
  const degraded =
    published.length > 0 && flaggedCount() < published.length * MIN_MADE_IN_UKRAINE_RATIO
  if (degraded) {
    const found = flaggedCount()
    for (const game of published) keepPublished(game, game.studioSlugs ?? [])
    deps.log(
      `::warning title=Studios stage degraded::only ${found} games made in Ukraine found against ${published.length} published; every published flag was kept`,
    )
  }
  if (kept > 0)
    deps.log(`studios: kept ${kept} published games made in Ukraine tonight could not confirm`)

  // --- The list itself: slugs noted, the appended games bounded, most popular first.
  for (const [id, found] of slugsOf) {
    const game = listed.get(id) ?? outside.get(id)
    if (!game) continue
    game.studioSlugs = [...found]
    const seen = seenAt.get(id)
    if (seen) game.studioSeenAt = seen
    else delete game.studioSeenAt
  }
  const ranked = [...outside.values()].sort((a, b) => b.popularity - a.popularity || a.id - b.id)
  const appended = ranked.slice(0, maxAppended)
  const dropped = ranked.length - appended.length
  games.push(...appended)

  if (dropped > 0) {
    deps.log(`studios: dropped ${dropped} studio games past the bound of ${maxAppended}`)
  }

  const studiosWithoutGames = UKRAINIAN_STUDIOS.filter(
    (studio) =>
      studio.rawgSlugs.every((slug) => outcomes.has(slug)) &&
      studio.rawgSlugs.every((slug) => outcomes.get(slug) !== 'read'),
  ).map((studio) => studio.name)
  const madeInUkraine = games.filter((game) => game.madeInUkraine).length

  deps.log(
    `studios: ${madeInUkraine} games made in Ukraine (${flagged} listed games flagged, ` +
      `${appended.length} added, ${kept} kept), ${failed.length} of ${slugs.length} studios failed, ` +
      `${requests} RAWG requests`,
  )
  return {
    appended,
    flagged,
    dropped,
    kept,
    expired,
    madeInUkraine,
    previousMadeInUkraine,
    degraded,
    requests,
    attempted: slugs.length,
    failures: failed.length,
    failed,
    unknown,
    empty,
    studiosWithoutGames,
  }
}
