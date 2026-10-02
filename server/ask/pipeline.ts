import { MAX_SEARCH_LENGTH } from '../../shared/catalog'
import { DEFAULT_SORT, type CatalogFilter } from '../../shared/filterUrl'
import type { GraphQLContext } from '../graphql/context'
import {
  cachedIndexPage,
  indexFailed,
  indexState,
  toIndexQuery,
  warnIndexOnce,
  withoutPrices,
} from '../graphql/indexPath'
import { catalogPage } from '../graphql/resolvers/games'
import type { GameCard } from '../graphql/__generated__/resolvers-types'
import type { IndexedGame } from '../index/document'
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
import { catalogUrl, sanitiseParse, type UnderstoodQuery } from './sanitise'
import type { AskLocale } from './schemas'

/**
 * `POST /api/ask` below HTTP: parse → sanitise → retrieve → rerank → answer.
 *
 * 1. **Parse.** The model reads the query against the live genre list; the sanitiser re-validates
 *    everything it said (`server/ask/sanitise.ts`).
 * 2. **Retrieve.** The understood filter goes through `catalogPage`, the function behind the
 *    `games` field, so the index path or the RAWG path answers exactly as it would for `/games`,
 *    with up to `MAX_CANDIDATES` games. A "like X" query resolves X in the index and takes its
 *    stored similar-games list (or, without one, its genres), merged with the filter's results.
 * 3. **Rerank.** The model orders compact cards of the candidates and says why each fits. Ids it
 *    invents are discarded; with fewer than three survivors the retrieval order stands, without
 *    reasons. Fewer than three candidates are not worth a call at all.
 * 4. **Answer.** The cards, the understood filter and its `/games` link.
 *
 * Every index read goes through the request's `GraphQLContext`, so the index's own guards — the
 * deadline, the circuit, the once-per-request failure — apply here exactly as on a catalog page.
 * The whole of it has a budget (`DEFAULT_BUDGET_MS`); any failure, timeout or refusal, and a spent
 * budget, turns into the fallback: the raw query as a plain catalog search. Nothing here throws.
 */

export const MAX_CANDIDATES = 40
export const MAX_ITEMS = 12
export const FALLBACK_SIZE = 12
export const MAX_REASON_LENGTH = 120
/** Fewer surviving ranked ids than this, and the retrieval order is used instead. */
export const MIN_RANKED = 3
/** The whole structured attempt; the fallback search runs after it on its own upstream budget. */
export const DEFAULT_BUDGET_MS = 12_000
/** Tags per candidate card: enough to describe a game, few enough to keep forty cards short. */
const CARD_TAGS = 6

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
}

export interface AskPipelineDeps {
  context: GraphQLContext
  provider: LlmProvider
  budgetMs?: number
  now?: () => number
}

class Fallback extends Error {
  constructor(readonly reason: AskFallbackReason) {
    super(`ask fell back: ${reason}`)
  }
}

type Structured = Omit<AskAnswer, 'tookMs'>

export async function runAsk(request: AskRequest, deps: AskPipelineDeps): Promise<AskOutcome> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS
  const deadline = started + budgetMs
  const controller = new AbortController()
  let usage = NO_USAGE

  /** One model call, its cost recorded whatever the outcome, its failure turned into a fallback. */
  async function spend<T>(call: (timeoutMs: number) => Promise<LlmResult<T>>): Promise<T> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - now()))
    const result = await call(timeoutMs)
    usage = addUsage(usage, result.usage)
    if (!result.ok) throw new Fallback(result.failure)
    return result.value
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Fallback('timeout'))
    }, budgetMs)
  })

  const attempt = structured(request, deps.context, deps.provider, controller.signal, spend)
  // Whichever of the two loses the race must not surface as an unhandled rejection later.
  attempt.catch(() => undefined)
  expired.catch(() => undefined)

  let failure: AskFallbackReason | null = null
  let answer: Structured
  try {
    answer = await Promise.race([attempt, expired])
  } catch (error) {
    failure = error instanceof Fallback ? error.reason : 'error'
    answer = await fallback(request, deps.context)
  } finally {
    clearTimeout(timer)
  }

  return { answer: { ...answer, tookMs: Math.max(0, now() - started) }, usage, failure }
}

type Spend = <T>(call: (timeoutMs: number) => Promise<LlmResult<T>>) => Promise<T>

async function structured(
  request: AskRequest,
  context: GraphQLContext,
  provider: LlmProvider,
  signal: AbortSignal,
  spend: Spend,
): Promise<Structured> {
  const genres = await genreSlugs(context)
  const parse = await spend((timeoutMs) =>
    provider.parse(request.q, request.locale, { genres, signal, timeoutMs }),
  )
  const understood = sanitiseParse(parse, { genres })
  const base = {
    mode: 'structured' as const,
    interpretation: understood.interpretation,
    filter: understood.filter,
    catalogUrl: catalogUrl(understood.filter, understood.sort, request.locale),
  }

  // The model found nothing to look for — an empty request, or one that is not about games. A
  // list of popular games would be an answer to a question nobody asked.
  if (isEmpty(understood)) return { ...base, items: [] }

  let candidates: GameCard[]
  try {
    candidates = await retrieve(context, understood)
  } catch {
    throw new Fallback('retrieval')
  }

  if (candidates.length < MIN_RANKED) return { ...base, items: inRetrievalOrder(candidates) }

  const cards = await candidateCards(context, candidates)
  const ranking = await spend((timeoutMs) =>
    provider.rerank(request.q, cards, request.locale, { signal, timeoutMs }),
  )
  const ranked = rankedItems(candidates, ranking.items)
  return { ...base, items: ranked.length >= MIN_RANKED ? ranked : inRetrievalOrder(candidates) }
}

function isEmpty(understood: UnderstoodQuery): boolean {
  return (
    Object.keys(understood.filter).length === 0 &&
    understood.similarTo === null &&
    understood.sort === DEFAULT_SORT
  )
}

/** The live genre slugs, sorted; none when the taxonomy cannot be read right now. */
async function genreSlugs(context: GraphQLContext): Promise<string[]> {
  try {
    const raw = (await context.rawg('genres')) as RawgList<RawgTaxonomy>
    return (raw.results ?? [])
      .filter((item) => item.slug)
      .map((item) => mapTaxonomy(item).slug)
      .sort()
  } catch {
    return []
  }
}

async function retrieve(context: GraphQLContext, understood: UnderstoodQuery): Promise<GameCard[]> {
  const hasFilter = Object.keys(understood.filter).length > 0 || understood.sort !== DEFAULT_SORT
  const byFilter = () =>
    catalogPage(context, {
      filter: understood.filter,
      sort: understood.sort,
      page: 1,
      pageSize: MAX_CANDIDATES,
    }).then((page) => page.items)

  if (understood.similarTo === null) return byFilter()

  // Both start at once: the filter's page does not wait for the game to be resolved.
  const [similar, filtered] = await Promise.all([
    similarTo(context, understood.similarTo),
    hasFilter ? byFilter() : Promise.resolve(null),
  ])
  if (!similar) return filtered ?? (await byFilter())

  const others = (filtered ?? []).filter((card) => card.id !== similar.id)
  if (filtered === null) return similar.cards.slice(0, MAX_CANDIDATES)
  const inFilter = new Set(others.map((card) => card.id))
  const inList = new Set(similar.cards.map((card) => card.id))
  return [
    ...similar.cards.filter((card) => inFilter.has(card.id)),
    ...similar.cards.filter((card) => !inFilter.has(card.id)),
    ...others.filter((card) => !inList.has(card.id)),
  ].slice(0, MAX_CANDIDATES)
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
): Promise<{ id: string; cards: GameCard[] } | null> {
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
    const cards = game.similar
      ? await storedSimilar(context, game)
      : await sameGenre(context, game, state.version)
    return { id: String(game.id), cards: state.stale ? withoutPrices(cards) : cards }
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
    const localisation = card.localisation
    return {
      id: card.id,
      name: card.name,
      year: card.released ? Number(card.released.slice(0, 4)) || null : null,
      genres: document?.genres ?? card.genres.map((genre) => genre.slug),
      tags: (document?.tags ?? []).slice(0, CARD_TAGS),
      modes: document?.gameModes ?? [],
      priceUah: card.price?.bestUah ?? null,
      discountPercent: card.price?.discountPercent ?? 0,
      free: card.price?.isFree ?? false,
      ukrainian: localisation?.audio ? 'audio' : localisation?.text ? 'text' : null,
      hours: card.playtime ?? null,
    }
  })
}

function reasonOf(reason: string): string | null {
  const text = reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH).trim()
  return text || null
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
 * header's search would send it. Even that failing is an answer — an empty one.
 */
async function fallback(request: AskRequest, context: GraphQLContext): Promise<Structured> {
  const search = request.q.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH).trim()
  const filter: CatalogFilter = search ? { search } : {}
  const items: AskItem[] = await catalogPage(context, {
    filter,
    sort: DEFAULT_SORT,
    page: 1,
    pageSize: FALLBACK_SIZE,
  }).then(
    (page) => page.items.slice(0, FALLBACK_SIZE).map((card) => ({ card, reason: null })),
    () => [],
  )
  return {
    mode: 'fallback',
    interpretation: null,
    filter,
    catalogUrl: catalogUrl(filter, DEFAULT_SORT, request.locale),
    items,
  }
}
