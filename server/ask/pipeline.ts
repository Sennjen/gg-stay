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
import { RAWG_GENRES, type CandidateCard } from './prompts'
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
import { MAX_ANSWERS, MAX_REASON_LENGTH, type AskLocale, type AskRerank } from './schemas'

/**
 * `POST /api/ask` below HTTP: parse → sanitise → retrieve → rerank → answer.
 *
 * 1. **Parse.** The model reads the query against RAWG's genre list and the mood tags; the
 *    sanitiser re-validates everything it said against the live taxonomy, read meanwhile
 *    (`server/ask/sanitise.ts`).
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
 * **One deadline covers the whole request** (`TOTAL_BUDGET_MS` from when it arrived). The parse,
 * the retrieval and the candidate cards must be done `FALLBACK_RESERVE_MS` before it, so the
 * fallback — the raw query as a plain catalog search — has at least that long when they fail; a
 * failure, refusal or timeout of the parse, or a failed retrieval, turns into that fallback, and a
 * fallback search that outlives the deadline too is answered with no cards. The rerank then runs
 * on its own deadline, `RERANK_BUDGET_MS` from the end of the parse and never later than
 * `RERANK_END_MARGIN_MS` before the request's; whatever happens to it, the answer stays
 * structured. Nothing here throws.
 */

export const MAX_CANDIDATES = 40
/** Ranked or not, an answer shows at most this many games (`MAX_ANSWERS`). */
export const MAX_ITEMS = MAX_ANSWERS
export const FALLBACK_SIZE = MAX_ANSWERS
/** Fewer surviving ranked ids than this, and the retrieval order is used instead. */
export const MIN_RANKED = 3
/**
 * The whole request, from its arrival to the answer, fallback search included. Half the platform's
 * 30 s function limit.
 */
export const TOTAL_BUDGET_MS = 15_000
/**
 * The least the fallback search is given: the parse, the retrieval and the cards must be done this
 * long before the deadline. It only matters when the attempt fails before the rerank — a rerank
 * that fails leaves a structured answer, with no search to run.
 */
export const FALLBACK_RESERVE_MS = 3_000
/**
 * The most /ask waits for RAWG, on the rare query only RAWG can answer (a title search), and as
 * one attempt — not the catalog's two of five seconds each. Past it the index answers what it can.
 */
export const ASK_RAWG_BUDGET_MS = 4_000
/** The genre list may take this long; past it the parse runs without genres. */
export const GENRES_TIMEOUT_MS = 1_500
/**
 * The most candidates the rerank is shown, most relevant first. Its time is mostly the reasons it
 * writes, but every card is input to read, and twenty-four leave the eight answers a real choice.
 */
export const MAX_RERANKED = 24
/**
 * How long the rerank may run, counted from the end of the parse — not from the request — so a
 * slow parse does not take the rerank's time. Eight reasons take about 5–6 s to write.
 */
export const RERANK_BUDGET_MS = 7_000
/** The rerank never runs past this long before the request's deadline. */
export const RERANK_END_MARGIN_MS = 1_000
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
   * The cards came from the index alone — the most popular games and every Ukrainian studio's —
   * not from RAWG's whole catalog: what the catalog says with `GamePage.indexedOnly`, and the page
   * can say it the same way. `false` when no page answered.
   */
  indexedOnly: boolean
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
  /** How long each step took, in ms — only the steps that ran. */
  timings: AskTimings
  /** The output tokens of each model call, `null` for a call that was not made. */
  outputTokens: { parse: number | null; rerank: number | null }
}

/**
 * The steps a request's time goes to, for the log line. The handler adds its own three
 * (`context`, `indexState`, `cache`); `genres` and `indexState` run beside `parse`, not before it.
 */
export type AskStep =
  | 'context'
  | 'indexState'
  | 'cache'
  | 'genres'
  | 'parse'
  | 'retrieve'
  | 'describe'
  | 'rerank'
  | 'search'
export type AskTimings = Partial<Record<AskStep, number>>

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

/**
 * The request context `/ask` runs on: the catalog's own, with RAWG held to one attempt of
 * `ASK_RAWG_BUDGET_MS` — the transport's two five-second attempts would outlast the whole answer.
 * Built once per request, before anything reads the index, so the request's index state is shared.
 */
export function askContext(context: GraphQLContext): GraphQLContext {
  const rawg = context.rawg
  return {
    ...context,
    rawg: (path, params, options) =>
      rawg(path, params, { timeoutMs: ASK_RAWG_BUDGET_MS, maxAttempts: 1, ...options }),
  }
}

export async function runAsk(request: AskRequest, deps: AskPipelineDeps): Promise<AskOutcome> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const deadline = deps.deadline ?? started + TOTAL_BUDGET_MS
  const prepareDeadline = deadline - FALLBACK_RESERVE_MS
  const controller = new AbortController()
  const timings: AskTimings = {}
  const outputTokens: AskOutcome['outputTokens'] = { parse: null, rerank: null }
  let usage = NO_USAGE

  /** `work`, with how long it took recorded under `step` however it ends. */
  const timed = <T>(step: AskStep, work: Promise<T>): Promise<T> => {
    const from = now()
    return work.finally(() => {
      timings[step] = Math.max(0, now() - from)
    })
  }

  /**
   * One model call that must be answered by `callDeadline`: its own timeout is what is left until
   * then (at most `REQUEST_TIMEOUT_MS`), and it is aborted at that moment — which also stops the
   * client's one retry — or when the whole attempt is. Its cost is recorded whatever the outcome,
   * and its output tokens under its own step.
   */
  async function spend<T>(
    step: 'parse' | 'rerank',
    callDeadline: number,
    call: (signal: AbortSignal, timeoutMs: number) => Promise<LlmResult<T>>,
  ): Promise<LlmResult<T>> {
    const remaining = Math.max(1, callDeadline - now())
    const own = new AbortController()
    const timer = setTimeout(() => own.abort(), remaining)
    const abort = () => own.abort()
    controller.signal.addEventListener('abort', abort)
    try {
      const result = await call(own.signal, Math.min(REQUEST_TIMEOUT_MS, remaining))
      usage = addUsage(usage, result.usage)
      outputTokens[step] = (outputTokens[step] ?? 0) + result.usage.outputTokens
      return result
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
    }
  }

  const finish = (
    answer: Answered,
    rest: Omit<AskOutcome, 'answer' | 'usage' | 'timings' | 'outputTokens'>,
  ): AskOutcome => ({
    answer: { ...answer, tookMs: Math.max(0, now() - started) },
    usage,
    timings,
    outputTokens,
    ...rest,
  })

  let failure: AskFallbackReason
  try {
    const prepared = await within(
      prepare(request, deps.context, deps.provider, { spend, timed, now, prepareDeadline }),
      prepareDeadline - now(),
      () => controller.abort(),
    )
    if (prepared === EXPIRED) {
      failure = 'timeout'
    } else {
      const result =
        'answer' in prepared
          ? prepared
          : await rank(request, deps.provider, prepared, {
              spend,
              timed,
              // Relative to when the parse ended, so a slow parse does not eat the rerank's time;
              // never past a second before the request's deadline.
              rerankDeadline: Math.min(
                prepared.parseEnd + RERANK_BUDGET_MS,
                deadline - RERANK_END_MARGIN_MS,
              ),
              now,
            })
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
    timed('search', fallback(request, deps.context)),
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

type Spend = <T>(
  step: 'parse' | 'rerank',
  callDeadline: number,
  call: (signal: AbortSignal, timeoutMs: number) => Promise<LlmResult<T>>,
) => Promise<LlmResult<T>>

interface PrepareTools {
  spend: Spend
  timed: <T>(step: AskStep, work: Promise<T>) => Promise<T>
  now: () => number
  prepareDeadline: number
}

/** Everything the rerank needs, once the parse, the retrieval and the cards are done. */
interface Prepared {
  parseEnd: number
  understood: UnderstoodQuery
  shown: GameCard[]
  candidates: GameCard[]
  cards: CandidateCard[]
  answered: (items: AskItem[], rerankFailure: AskFailure | null) => StructuredResult
}

/**
 * The part of the structured attempt that has to leave the fallback its time: the parse, the
 * retrieval and the candidate cards, all before `prepareDeadline`. It answers by itself when there
 * is nothing to rank; otherwise it hands the rerank what it needs.
 */
async function prepare(
  request: AskRequest,
  context: GraphQLContext,
  provider: LlmProvider,
  tools: PrepareTools,
): Promise<StructuredResult | Prepared> {
  const { spend, timed } = tools
  // The parse starts at once, with RAWG's genre list as the prompt names it. The live taxonomy —
  // which the answer is checked against — and the index state are read beside it, not before it.
  const liveGenres = timed('genres', genreSlugs(context))
  indexState(context).catch(() => undefined)
  const parsed = await timed(
    'parse',
    spend('parse', tools.prepareDeadline, (signal, timeoutMs) =>
      provider.parse(request.q, request.locale, { genres: RAWG_GENRES, signal, timeoutMs }),
    ),
  )
  const parseEnd = tools.now()
  if (!parsed.ok) throw new Fallback(parsed.failure)
  const live = await liveGenres
  const understood = sanitiseParse(parsed.value, { genres: live.length ? live : RAWG_GENRES })
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
      answer: {
        ...base,
        items: [],
        ignoredFilters: [],
        indexStale: false,
        indexedOnly: false,
        matchedTags: [],
      },
      rerankFailure: null,
      degraded: false,
    }
  }

  let retrieved: Retrieved
  try {
    retrieved = await timed('retrieve', retrieve(context, understood))
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
      indexedOnly: retrieved.indexedOnly,
      matchedTags: retrieved.matchedTags,
    },
    rerankFailure,
    degraded: indexDegraded || rerankFailure !== null,
  })

  if (candidates.length < MIN_RANKED) return answered(inRetrievalOrder(candidates), null)

  const shown = candidates.slice(0, MAX_RERANKED)
  const cards = await timed('describe', candidateCards(context, shown))
  return { parseEnd, understood, shown, candidates, cards, answered }
}

interface RankTools {
  spend: Spend
  timed: <T>(step: AskStep, work: Promise<T>) => Promise<T>
  now: () => number
  rerankDeadline: number
}

/**
 * The rerank, on its own deadline. Whatever happens to it — a failure, a cut-off answer, its
 * deadline, even a provider that throws or ignores its abort — the answer stays structured: the
 * candidates are served in the catalog's own order, without reasons. It never falls back.
 */
async function rank(
  request: AskRequest,
  provider: LlmProvider,
  prepared: Prepared,
  tools: RankTools,
): Promise<StructuredResult> {
  const { candidates, shown, answered } = prepared
  let ranking: LlmResult<AskRerank> | typeof EXPIRED
  try {
    ranking = await within(
      tools.timed(
        'rerank',
        tools.spend('rerank', tools.rerankDeadline, (signal, timeoutMs) =>
          provider.rerank(request.q, prepared.cards, request.locale, {
            signal,
            timeoutMs,
            interpretation: prepared.understood.interpretation,
          }),
        ),
      ),
      tools.rerankDeadline - tools.now(),
    )
  } catch {
    return answered(inRetrievalOrder(candidates), 'api')
  }
  if (ranking === EXPIRED) return answered(inRetrievalOrder(candidates), 'timeout')
  if (!ranking.ok) return answered(inRetrievalOrder(candidates), ranking.failure)
  const ranked = rankedItems(shown, ranking.value.items)
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
 * (it is normally a cache hit). Read beside the parse, whose genres are then checked against it —
 * or against `RAWG_GENRES` when it could not be read.
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
  /** The candidates came from the index alone: the most popular games and the Ukrainian studios'. */
  indexedOnly: boolean
  /** The mood tags the candidates were matched on; empty when no tag shaped them. */
  matchedTags: string[]
}

async function retrieve(context: GraphQLContext, understood: UnderstoodQuery): Promise<Retrieved> {
  const hasFilter =
    Object.keys(understood.filter).length > 0 ||
    understood.sort !== DEFAULT_SORT ||
    understood.tags.length > 0
  const byFilter = (): Promise<Retrieved> =>
    needsRawg(understood) ? byRawg(context, understood) : byIndex(context, understood)

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
      indexedOnly: true,
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
    indexedOnly: filtered.indexedOnly,
    matchedTags: filtered.matchedTags,
  }
}

/**
 * Whether the understood query needs what only RAWG can do. Every field the parse produces has an
 * index facet or range except a title search: RAWG ranks titles by relevance over its whole
 * catalog, the index only matches a substring among the games it holds.
 */
function needsRawg(understood: UnderstoodQuery): boolean {
  return Boolean(understood.filter.search)
}

/**
 * The understood query as `/games` would answer it, through `catalogPage` — for a title search,
 * the one thing the index cannot do as well. It has `ASK_RAWG_BUDGET_MS`, not the catalog's two
 * five-second attempts; when that runs out, or RAWG fails, the index answers what it can and the
 * fields it could not apply are named in `ignoredFilters`.
 */
async function byRawg(
  context: GraphQLContext,
  understood: UnderstoodQuery,
  indexToo = true,
): Promise<Retrieved> {
  const page = await within(
    catalogPage(context, {
      filter: understood.filter,
      sort: understood.sort,
      page: 1,
      pageSize: MAX_CANDIDATES,
    }),
    ASK_RAWG_BUDGET_MS,
  ).catch((): typeof EXPIRED => EXPIRED)
  if (page !== EXPIRED) {
    return {
      candidates: page.items,
      ignoredFilters: page.ignoredFilters,
      indexStale: page.indexStale,
      indexedOnly: page.indexedOnly,
      matchedTags: [],
    }
  }
  if (!indexToo) throw new Error('Neither RAWG nor the index answered')
  const { search: _search, ...indexable } = understood.filter
  const subset = await byIndex(context, { ...understood, filter: indexable }, false)
  return {
    ...subset,
    ignoredFilters: [...new Set(['search', ...subset.ignoredFilters])],
  }
}

/**
 * The understood query from the index alone, mood tags included: one page of up to
 * `MAX_CANDIDATES`, in the understood order, in a fraction of a second. With tags, most relevant
 * first: the games carrying every tag, then those carrying the most defining one (the parse lists
 * it first), and only when that leaves fewer than `MIN_RANKED`, those carrying any of them; fewer
 * than that still, and the same query without the tags fills up the list behind them.
 *
 * A stale index drops the price filters and the price sorts and names them, exactly as `/games`
 * does. An index that cannot answer leaves the query to RAWG (`byRawg`), within its own budget.
 */
async function byIndex(
  context: GraphQLContext,
  understood: UnderstoodQuery,
  rawgToo = true,
): Promise<Retrieved> {
  const state = await indexState(context)
  const unavailable = () => {
    if (!rawgToo) throw new Error('Neither the index nor RAWG answered')
    return byRawg(context, understood, false)
  }
  if (state.meta === null || indexFailed(context)) return unavailable()

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

  let candidates: GameCard[]
  let matchedTags: string[] = []
  try {
    if (tags.length === 0) {
      candidates = await page(base)
    } else {
      const [every, defining, any] = await Promise.all([
        tags.length > 1 ? page({ ...base, tags, tagMatch: 'all' }) : Promise.resolve([]),
        page({ ...base, tags: [tags[0]!] }),
        tags.length > 1 ? page({ ...base, tags }) : Promise.resolve([]),
      ])
      let tagged = unique([...every, ...defining])
      if (tagged.length < MIN_RANKED) tagged = unique([...tagged, ...any])
      if (tagged.length > 0) matchedTags = [...tags]
      candidates = tagged.length >= MIN_RANKED ? tagged : unique([...tagged, ...(await page(base))])
    }
  } catch (error) {
    warnIndexOnce(context, 'the candidates of a query could not be read', error)
    return unavailable()
  }
  candidates = candidates.slice(0, MAX_CANDIDATES)
  return {
    candidates: state.stale ? withoutPrices(candidates) : candidates,
    ignoredFilters,
    indexStale: state.stale,
    indexedOnly: true,
    matchedTags,
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
 * The answer when the AI part did not run: the raw query as a plain search. The index's name
 * search answers it first — a fraction of a second, over the games it holds — and RAWG's title
 * search only when the index cannot. `ok` is false when neither answered; the answer is then empty.
 */
async function fallback(
  request: AskRequest,
  context: GraphQLContext,
): Promise<{ answer: Answered; ok: boolean }> {
  const answer = emptyFallback(request)
  const search = answer.filter.search
  if (!search) return { answer, ok: true }
  const shown = (cards: readonly GameCard[]) =>
    cards.slice(0, FALLBACK_SIZE).map((card) => ({ card, reason: null }))

  const state = await indexState(context)
  if (state.meta !== null && !indexFailed(context)) {
    try {
      const query = toIndexQuery({
        filter: { search },
        sort: DEFAULT_SORT,
        page: 1,
        pageSize: FALLBACK_SIZE,
        today: context.today,
      })
      const { items } = await cachedIndexPage(context, query, state.version)
      return {
        answer: {
          ...answer,
          items: shown(state.stale ? withoutPrices(items) : items),
          indexStale: state.stale,
          indexedOnly: true,
        },
        ok: true,
      }
    } catch (error) {
      warnIndexOnce(context, 'the plain search could not be read', error)
    }
  }

  try {
    const page = await catalogPage(context, {
      filter: answer.filter,
      sort: DEFAULT_SORT,
      page: 1,
      pageSize: FALLBACK_SIZE,
    })
    return {
      answer: {
        ...answer,
        items: shown(page.items),
        ignoredFilters: page.ignoredFilters,
        indexStale: page.indexStale,
        indexedOnly: page.indexedOnly,
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
    indexedOnly: false,
    matchedTags: [],
  }
}
