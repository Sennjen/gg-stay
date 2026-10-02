import { MAX_SEARCH_LENGTH } from '../../shared/catalog'
import { DEFAULT_SORT, type CatalogFilter } from '../../shared/filterUrl'
import type { GraphQLContext } from '../graphql/context'
import {
  cachedIndexPage,
  INDEX_SORTS,
  indexFailed,
  indexState,
  priceFiltersUsed,
  toIndexQuery,
  warnIndexOnce,
  withoutPriceFilters,
  withoutPrices,
} from '../graphql/indexPath'
import { catalogPage } from '../graphql/resolvers/games'
import type { GameCard } from '../graphql/__generated__/resolvers-types'
import type { IndexedGame } from '../index/document'
import type { IndexQuery } from '../index/GameIndex'
import { toGameCard } from '../index/toGraphql'
import { mapTaxonomy } from '../rawg/mappers'
import type { RawgList, RawgTaxonomy } from '../rawg/types'
import type { CandidateCard } from './prompts'
import {
  addUsage,
  NO_USAGE,
  REQUEST_TIMEOUT_MS,
  type AskFailure,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
} from './provider'
import { catalogUrl, modelLine, plainReason, sanitiseParse, type UnderstoodQuery } from './sanitise'
import { MAX_REASON_LENGTH, type AskLocale } from './schemas'

/**
 * `POST /api/ask` below HTTP: parse → sanitise → retrieve → rerank → answer.
 *
 * 1. **Parse.** The model reads the query against the live genre list; the sanitiser re-validates
 *    everything it said (`server/ask/sanitise.ts`).
 * 2. **Retrieve.** The understood filter goes through `catalogPage`, the function behind the
 *    `games` field, so the index path or the RAWG path answers exactly as it would for `/games`,
 *    with up to `MAX_CANDIDATES` games — and the filters that path could not apply are reported in
 *    `ignoredFilters`, as the catalog reports them. A "like X" query resolves X in the index and
 *    takes its stored similar-games list (or, without one, its genres), merged with the filter's
 *    results.
 * 3. **Rerank.** The model orders compact cards of the candidates and says why each fits. Ids it
 *    invents are discarded; with fewer than three survivors — or a rerank that failed or was cut
 *    off — the retrieval order stands, without reasons, and the answer stays structured. Fewer
 *    than three candidates are not worth a call at all.
 * 4. **Answer.** The cards, the understood filter, its `/games` link and the ignored filters.
 *
 * Every index read goes through the request's `GraphQLContext`, so the index's own guards — the
 * deadline, the circuit, the once-per-request failure — apply here exactly as on a catalog page.
 *
 * **One deadline covers the whole request** (`TOTAL_BUDGET_MS` from when it arrived). The
 * structured attempt must finish `FALLBACK_RESERVE_MS` before it, so the fallback — the raw query
 * as a plain catalog search — always has at least that long; a failure, refusal or timeout of the
 * parse, or a failed retrieval, turns into that fallback, and a fallback search that outlives the
 * deadline too is answered with no cards. Nothing here throws.
 */

export const MAX_CANDIDATES = 40
export const MAX_ITEMS = 12
export const FALLBACK_SIZE = 12
/** Fewer surviving ranked ids than this, and the retrieval order is used instead. */
export const MIN_RANKED = 3
/** The whole request, from its arrival to the answer, fallback search included. */
export const TOTAL_BUDGET_MS = 12_000
/** The least the fallback search is given; the structured attempt ends this long before the deadline. */
export const FALLBACK_RESERVE_MS = 3_000
/** The genre list may take this long; past it the parse runs without genres. */
export const GENRES_TIMEOUT_MS = 1_500
/** Tags per candidate card: enough to describe a game, few enough to keep the cards short. */
const CARD_TAGS = 8

export interface AskRequest {
  q: string
  locale: AskLocale
}

export interface AskItem {
  card: GameCard
  /** Why it fits, in the query's language; `null` when the model did not rank this answer. */
  reason: string | null
}

export interface AskAnswer {
  mode: 'structured' | 'fallback'
  interpretation: string | null
  filter: CatalogFilter
  catalogUrl: string
  items: AskItem[]
  /**
   * The fields of `filter` the catalog could not apply to these cards — `GamePage.ignoredFilters`
   * of the page they came from, with the same names (and `sort`). Empty when everything applied.
   */
  ignoredFilters: string[]
  /**
   * The catalog page the cards came from reported stale prices (`GamePage.indexStale`), so the
   * cards carry no price and the price filters are among `ignoredFilters`. `false` when no page
   * answered — a query with nothing to look for, or a fallback whose search did not answer — since
   * it is then unknown; a fallback whose search answered reports that page's own value.
   */
  indexStale: boolean
  /**
   * Mood tags the cards were also matched on ("horror", "roguelike"). The catalog has no tag
   * filter, so they are not in `filter` or `catalogUrl`; the page can say "also matched on …".
   * Empty when no tag shaped the cards.
   */
  matchedTags: string[]
  tookMs: number
}

/** Why an answer is a fallback: a provider failure, a failed retrieval, or a bug. */
export type AskFallbackReason = AskFailure | 'retrieval' | 'error'

export interface AskOutcome {
  answer: AskAnswer
  /** What the model calls cost, including the ones that failed. */
  usage: LlmUsage
  /** `null` for a structured answer. */
  failure: AskFallbackReason | null
  /** Why a structured answer carries no reasons: its rerank failed. `null` otherwise. */
  rerankFailure: AskFailure | null
  /** How the fallback search went, when there was one. */
  search: 'ok' | 'failed' | 'timeout' | null
  /**
   * The answer is right for now but not for a day: the index was stale or could not answer, a
   * filter was ignored, or the ranking failed. The response cache keeps it briefly.
   */
  degraded: boolean
}

export interface AskPipelineDeps {
  context: GraphQLContext
  provider: LlmProvider
  /** When the request must be answered (epoch ms); `TOTAL_BUDGET_MS` from now when not given. */
  deadline?: number
  now?: () => number
}

class Fallback extends Error {
  constructor(readonly reason: AskFallbackReason) {
    super(`ask fell back: ${reason}`)
  }
}

type Answered = Omit<AskAnswer, 'tookMs'>

interface StructuredResult {
  answer: Answered
  rerankFailure: AskFailure | null
  degraded: boolean
}

const EXPIRED = Symbol('expired')

/**
 * `work`, or `EXPIRED` once `ms` have passed, whichever comes first. The work is not cancelled —
 * `onExpire` may abort what can be aborted — and a rejection it raises after losing is swallowed.
 */
function within<T>(
  work: Promise<T>,
  ms: number,
  onExpire?: () => void,
): Promise<T | typeof EXPIRED> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(
      () => {
        onExpire?.()
        resolve(EXPIRED)
      },
      Math.max(0, ms),
    )
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

export async function runAsk(request: AskRequest, deps: AskPipelineDeps): Promise<AskOutcome> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const deadline = deps.deadline ?? started + TOTAL_BUDGET_MS
  const structuredDeadline = deadline - FALLBACK_RESERVE_MS
  const controller = new AbortController()
  let usage = NO_USAGE

  /** One model call with what is left of the structured budget, its cost recorded whatever the outcome. */
  async function spend<T>(
    call: (timeoutMs: number) => Promise<LlmResult<T>>,
  ): Promise<LlmResult<T>> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, structuredDeadline - now()))
    const result = await call(timeoutMs)
    usage = addUsage(usage, result.usage)
    return result
  }

  const finish = (answer: Answered, rest: Omit<AskOutcome, 'answer' | 'usage'>): AskOutcome => ({
    answer: { ...answer, tookMs: Math.max(0, now() - started) },
    usage,
    ...rest,
  })

  let failure: AskFallbackReason
  try {
    const result = await within(
      structured(request, deps.context, deps.provider, controller.signal, spend),
      structuredDeadline - now(),
      () => controller.abort(),
    )
    if (result === EXPIRED) {
      failure = 'timeout'
    } else {
      return finish(result.answer, {
        failure: null,
        rerankFailure: result.rerankFailure,
        search: null,
        degraded: result.degraded,
      })
    }
  } catch (error) {
    failure = error instanceof Fallback ? error.reason : 'error'
  }

  const searched = await within(
    fallback(request, deps.context),
    Math.max(deadline - now(), FALLBACK_RESERVE_MS),
  )
  if (searched === EXPIRED) {
    return finish(emptyFallback(request), {
      failure,
      rerankFailure: null,
      search: 'timeout',
      degraded: true,
    })
  }
  return finish(searched.answer, {
    failure,
    rerankFailure: null,
    search: searched.ok ? 'ok' : 'failed',
    degraded: true,
  })
}

type Spend = <T>(call: (timeoutMs: number) => Promise<LlmResult<T>>) => Promise<LlmResult<T>>

async function structured(
  request: AskRequest,
  context: GraphQLContext,
  provider: LlmProvider,
  signal: AbortSignal,
  spend: Spend,
): Promise<StructuredResult> {
  const genres = await genreSlugs(context)
  const parsed = await spend((timeoutMs) =>
    provider.parse(request.q, request.locale, { genres, signal, timeoutMs }),
  )
  if (!parsed.ok) throw new Fallback(parsed.failure)
  const understood = sanitiseParse(parsed.value, { genres })
  const base = {
    mode: 'structured' as const,
    interpretation: understood.interpretation,
    filter: understood.filter,
    catalogUrl: catalogUrl(understood.filter, understood.sort, request.locale),
  }

  // The model found nothing to look for — an empty request, or one that is not about games. A
  // list of popular games would be an answer to a question nobody asked.
  if (isEmpty(understood)) {
    return {
      answer: { ...base, items: [], ignoredFilters: [], indexStale: false, matchedTags: [] },
      rerankFailure: null,
      degraded: false,
    }
  }

  let retrieved: Retrieved
  try {
    retrieved = await retrieve(context, understood)
  } catch {
    throw new Fallback('retrieval')
  }
  const { candidates, ignoredFilters } = retrieved
  const indexDegraded =
    retrieved.indexStale ||
    indexFailed(context) ||
    (await indexState(context)).meta === null ||
    ignoredFilters.length > 0
  const answered = (items: AskItem[], rerankFailure: AskFailure | null): StructuredResult => ({
    answer: {
      ...base,
      items,
      ignoredFilters,
      indexStale: retrieved.indexStale,
      matchedTags: retrieved.matchedTags,
    },
    rerankFailure,
    degraded: indexDegraded || rerankFailure !== null,
  })

  if (candidates.length < MIN_RANKED) return answered(inRetrievalOrder(candidates), null)

  const cards = await candidateCards(context, candidates)
  const ranking = await spend((timeoutMs) =>
    provider.rerank(request.q, cards, request.locale, {
      signal,
      timeoutMs,
      interpretation: understood.interpretation,
    }),
  )
  // A failed or cut-off ranking is no reason to drop a filter that was understood correctly: the
  // candidates are served in the catalog's own order, without reasons.
  if (!ranking.ok) return answered(inRetrievalOrder(candidates), ranking.failure)
  const ranked = rankedItems(candidates, ranking.value.items)
  return answered(ranked.length >= MIN_RANKED ? ranked : inRetrievalOrder(candidates), null)
}

function isEmpty(understood: UnderstoodQuery): boolean {
  return (
    Object.keys(understood.filter).length === 0 &&
    understood.tags.length === 0 &&
    understood.similarTo === null &&
    understood.sort === DEFAULT_SORT
  )
}

/**
 * The live genre slugs, sorted; none when the taxonomy cannot be read within `GENRES_TIMEOUT_MS`
 * (it is normally a cache hit), so a slow upstream cannot spend the model's time.
 */
async function genreSlugs(context: GraphQLContext): Promise<string[]> {
  try {
    const raw = await within(context.rawg('genres'), GENRES_TIMEOUT_MS)
    if (raw === EXPIRED) return []
    return ((raw as RawgList<RawgTaxonomy>).results ?? [])
      .filter((item) => item.slug)
      .map((item) => mapTaxonomy(item).slug)
      .sort()
  } catch {
    return []
  }
}

interface Retrieved {
  candidates: GameCard[]
  ignoredFilters: string[]
  indexStale: boolean
  /** The mood tags the candidates were matched on; empty when no tag shaped them. */
  matchedTags: string[]
}

async function retrieve(context: GraphQLContext, understood: UnderstoodQuery): Promise<Retrieved> {
  const hasFilter =
    Object.keys(understood.filter).length > 0 ||
    understood.sort !== DEFAULT_SORT ||
    understood.tags.length > 0
  const byFilter = (): Promise<Retrieved> =>
    understood.tags.length > 0 ? byTags(context, understood) : byCatalog(context, understood)

  if (understood.similarTo === null) return byFilter()

  // Both start at once: the filter's page does not wait for the game to be resolved.
  const [similar, filtered] = await Promise.all([
    similarTo(context, understood.similarTo),
    hasFilter ? byFilter() : Promise.resolve(null),
  ])
  if (!similar) return filtered ?? (await byFilter())
  if (filtered === null) {
    return {
      candidates: similar.cards.slice(0, MAX_CANDIDATES),
      ignoredFilters: [],
      indexStale: similar.stale,
      matchedTags: [],
    }
  }

  const others = filtered.candidates.filter((card) => card.id !== similar.id)
  const inFilter = new Set(others.map((card) => card.id))
  const inList = new Set(similar.cards.map((card) => card.id))
  return {
    candidates: [
      ...similar.cards.filter((card) => inFilter.has(card.id)),
      ...similar.cards.filter((card) => !inFilter.has(card.id)),
      ...others.filter((card) => !inList.has(card.id)),
    ].slice(0, MAX_CANDIDATES),
    ignoredFilters: filtered.ignoredFilters,
    indexStale: filtered.indexStale || similar.stale,
    matchedTags: filtered.matchedTags,
  }
}

/** The understood filter as the catalog would answer it: `catalogPage`, index or RAWG. */
function byCatalog(context: GraphQLContext, understood: UnderstoodQuery): Promise<Retrieved> {
  return catalogPage(context, {
    filter: understood.filter,
    sort: understood.sort,
    page: 1,
    pageSize: MAX_CANDIDATES,
  }).then((page) => ({
    candidates: page.items,
    ignoredFilters: page.ignoredFilters,
    indexStale: page.indexStale,
    matchedTags: [],
  }))
}

/**
 * The understood filter plus its mood tags, from the index's tag facets — the catalog has no tag
 * filter, so `catalogPage` cannot be asked. Most relevant first: the games carrying every tag,
 * then those carrying the most defining one (the parse lists it first), and only when that leaves
 * fewer than `MIN_RANKED`, those carrying any of them. Fewer than that still, and the catalog's
 * answer without the tags fills up the list behind them. A stale index drops the price filters
 * and the price sorts and names them, exactly as `/games` does; an index that cannot answer leaves
 * the catalog's answer alone, with no tag matched.
 */
async function byTags(context: GraphQLContext, understood: UnderstoodQuery): Promise<Retrieved> {
  const state = await indexState(context)
  if (state.meta === null || indexFailed(context)) return byCatalog(context, understood)

  const filter = state.stale ? (withoutPriceFilters(understood.filter) ?? {}) : understood.filter
  const sort = state.stale && INDEX_SORTS.includes(understood.sort) ? DEFAULT_SORT : understood.sort
  const ignoredFilters = state.stale ? priceFiltersUsed(understood.filter, understood.sort) : []
  const base = toIndexQuery({
    filter,
    sort,
    page: 1,
    pageSize: MAX_CANDIDATES,
    today: context.today,
  })
  const tags = understood.tags
  const page = (query: IndexQuery) =>
    cachedIndexPage(context, query, state.version).then((answer) => answer.items)

  let groups: GameCard[][]
  try {
    groups = await Promise.all([
      tags.length > 1 ? page({ ...base, tags, tagMatch: 'all' }) : Promise.resolve([]),
      page({ ...base, tags: [tags[0]!] }),
      tags.length > 1 ? page({ ...base, tags }) : Promise.resolve([]),
    ])
  } catch (error) {
    warnIndexOnce(context, 'the mood tags of a query could not be read', error)
    return byCatalog(context, understood)
  }
  const [every, defining, any] = groups as [GameCard[], GameCard[], GameCard[]]
  let tagged = unique([...every, ...defining])
  if (tagged.length < MIN_RANKED) tagged = unique([...tagged, ...any])
  tagged = tagged.slice(0, MAX_CANDIDATES)
  if (state.stale) tagged = withoutPrices(tagged)
  const matched: Retrieved = {
    candidates: tagged,
    ignoredFilters,
    indexStale: state.stale,
    matchedTags: tagged.length > 0 ? [...tags] : [],
  }
  if (tagged.length >= MIN_RANKED) return matched

  const catalog = await byCatalog(context, understood)
  return {
    candidates: unique([...tagged, ...catalog.candidates]).slice(0, MAX_CANDIDATES),
    ignoredFilters: [...new Set([...ignoredFilters, ...catalog.ignoredFilters])],
    indexStale: state.stale || catalog.indexStale,
    matchedTags: matched.matchedTags,
  }
}

function unique(cards: readonly GameCard[]): GameCard[] {
  const seen = new Set<string>()
  return cards.filter((card) => !seen.has(card.id) && Boolean(seen.add(card.id)))
}

/**
 * The games most like the one a "like X" query names: X is the most popular game in the index
 * whose name contains the title, and its candidates are its stored similar list, in order — or,
 * for a game published without one, the most popular games sharing a genre with it. `null` when
 * the index does not hold X, or cannot answer.
 */
async function similarTo(
  context: GraphQLContext,
  title: string,
): Promise<{ id: string; cards: GameCard[]; stale: boolean } | null> {
  const state = await indexState(context)
  if (state.meta === null || indexFailed(context)) return null
  try {
    const found = await context.index.search({
      search: title,
      sort: 'POPULARITY_DESC',
      page: 1,
      pageSize: 1,
    })
    const game = found.games[0]
    if (!game) return null
    // An empty stored list, or one whose games this version no longer holds, says nothing about
    // what the game is like; its genres still do.
    const stored = game.similar?.length ? await storedSimilar(context, game) : []
    const cards = stored.length ? stored : await sameGenre(context, game, state.version)
    return {
      id: String(game.id),
      cards: state.stale ? withoutPrices(cards) : cards,
      stale: state.stale,
    }
  } catch (error) {
    warnIndexOnce(context, 'the game a query compared to could not be read', error)
    return null
  }
}

async function storedSimilar(context: GraphQLContext, game: IndexedGame): Promise<GameCard[]> {
  const wanted = (game.similar ?? []).filter((id) => id !== game.id).slice(0, MAX_CANDIDATES)
  if (wanted.length === 0) return []
  const documents = await context.index.getMany(wanted)
  return wanted.flatMap((id) => {
    const document = documents.get(id)
    return document ? [toGameCard(document)] : []
  })
}

async function sameGenre(
  context: GraphQLContext,
  game: IndexedGame,
  version: number | null,
): Promise<GameCard[]> {
  if (game.genres.length === 0) return []
  const query = toIndexQuery({
    filter: { genres: game.genres },
    sort: 'POPULARITY_DESC',
    page: 1,
    pageSize: MAX_CANDIDATES,
    today: context.today,
  })
  const page = await cachedIndexPage(context, query, version)
  return page.items.filter((card) => card.id !== String(game.id))
}

/**
 * The compact cards the rerank prompt shows. Genres, tags and game modes come from the index
 * documents — one `getMany` for all of them — because an index-served card carries none of them
 * and a RAWG card carries no modes; a game the index does not hold is described by its card.
 */
async function candidateCards(
  context: GraphQLContext,
  candidates: readonly GameCard[],
): Promise<CandidateCard[]> {
  let documents = new Map<number, IndexedGame>()
  if (!indexFailed(context)) {
    try {
      documents = await context.index.getMany(candidates.map((card) => Number(card.id)))
    } catch (error) {
      warnIndexOnce(context, 'the candidates of a query could not be described', error)
    }
  }
  return candidates.map((card) => {
    const document = documents.get(Number(card.id))
    return {
      id: card.id,
      name: card.name,
      year: card.released ? Number(card.released.slice(0, 4)) || null : null,
      genres: document?.genres ?? card.genres.map((genre) => genre.slug),
      // The mood tags first — they are what a reason is made of — then the rarest-tags list.
      tags: [...new Set([...(document?.moodTags ?? []), ...(document?.tags ?? [])])].slice(
        0,
        CARD_TAGS,
      ),
      modes: document?.gameModes ?? [],
      hours: card.playtime ?? null,
    }
  })
}

/** A reason as shown, or `null` when it only echoes the filter back (`plainReason`). */
function reasonOf(reason: string): string | null {
  return plainReason(modelLine(reason, MAX_REASON_LENGTH))
}

/** The ranked ids that are candidates, each once, in the model's order. */
function rankedItems(
  candidates: readonly GameCard[],
  ranking: readonly { id: string; reason: string }[],
): AskItem[] {
  const byId = new Map(candidates.map((card) => [card.id, card]))
  const seen = new Set<string>()
  const items: AskItem[] = []
  for (const { id, reason } of ranking) {
    const card = byId.get(id)
    if (!card || seen.has(id)) continue
    seen.add(id)
    items.push({ card, reason: reasonOf(reason) })
    if (items.length === MAX_ITEMS) break
  }
  return items
}

function inRetrievalOrder(candidates: readonly GameCard[]): AskItem[] {
  return candidates.slice(0, MAX_ITEMS).map((card) => ({ card, reason: null }))
}

/**
 * The answer when the AI part did not run: the raw query as a plain catalog search, as the
 * header's search would send it. `ok` is false when even that failed — the answer is then empty.
 */
async function fallback(
  request: AskRequest,
  context: GraphQLContext,
): Promise<{ answer: Answered; ok: boolean }> {
  const answer = emptyFallback(request)
  try {
    const page = await catalogPage(context, {
      filter: answer.filter,
      sort: DEFAULT_SORT,
      page: 1,
      pageSize: FALLBACK_SIZE,
    })
    const items = page.items.slice(0, FALLBACK_SIZE).map((card) => ({ card, reason: null }))
    return {
      answer: {
        ...answer,
        items,
        ignoredFilters: page.ignoredFilters,
        indexStale: page.indexStale,
      },
      ok: true,
    }
  } catch {
    return { answer, ok: false }
  }
}

/** The fallback's shape with no cards: the raw query as a catalog search, and its link. */
export function emptyFallback(request: AskRequest): Omit<AskAnswer, 'tookMs'> {
  const search = request.q.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH).trim()
  const filter: CatalogFilter = search ? { search } : {}
  return {
    mode: 'fallback',
    interpretation: null,
    filter,
    catalogUrl: catalogUrl(filter, DEFAULT_SORT, request.locale),
    items: [],
    ignoredFilters: [],
    indexStale: false,
    matchedTags: [],
  }
}
