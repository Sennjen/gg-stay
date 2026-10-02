import { MAX_PAGE, MAX_PAGE_SIZE } from '../../../shared/catalog'
import { IndexUnavailableError } from '../../index/index'
import { filterToParams } from '../../rawg/filterToParams'
import { mapGameCard, mapGamePage, type GamePageIndexState } from '../../rawg/mappers'
import { postFilter } from '../../rawg/postFilter'
import { rawgListOrThrow } from '../../rawg/rawgFetch'
import type { RawgGameListItem } from '../../rawg/types'
import type { GraphQLContext } from '../context'
import { withUpstreamErrors } from '../errors'
import {
  attachIndexData,
  cachedIndexPage,
  indexFacetFiltersUsed,
  indexFailed,
  INDEX_SORTS,
  indexState,
  priceFiltersUsed,
  rawgOnlyFiltersUsed,
  toIndexQuery,
  warnIndexOnce,
  withoutPriceFilters,
  withoutPrices,
  type IndexState,
} from '../indexPath'
import type {
  GameFilter,
  GamePage,
  GameSort,
  QueryResolvers,
} from '../__generated__/resolvers-types'

/**
 * Which path answers a catalog page (see the design's "Which path serves a request"):
 *
 * - A filter or a sort only the index can express — a price ceiling, the free box, a discount
 *   floor, a Ukrainian localisation level, made in Ukraine, or a price or discount sort — is
 *   answered by the index alone, over the games it holds, with an exact total. `indexedOnly` says
 *   so, and the filters the index has no facet for (developers, publishers, tags) are reported in
 *   `ignoredFilters` rather than silently applied or silently dropped.
 * - Anything else is answered by RAWG over the whole catalog, exactly as before, and the prices,
 *   the language list and the made-in-Ukraine flag are attached afterwards with one index read.
 *
 * Neither the staleness of the index nor its total absence may fail a page. Stale means the
 * *prices* are stale (see `indexState`): the price filters and the price sorts are dropped and
 * named, no price is attached to any card, and everything that does not depend on a price — the
 * language filters, the badges, the made-in-Ukraine facet — keeps being answered by the index. An
 * index that cannot answer at all drops back to RAWG with no prices and names the same fields.
 *
 * A RAWG page is also never held hostage by RAWG itself: when RAWG has not answered within
 * `RAWG_HEDGE_MS` and the index can express the whole filter, the index answers that page
 * instead, `indexedOnly` and all (see `indexPageIfRawgIsSlow`).
 */

/**
 * How long a RAWG-served catalog page waits for RAWG before the index is asked for the same page.
 *
 * RAWG answers most pages in well under a second, and anything it has answered before comes out
 * of the per-instance response cache in a few milliseconds. Some filter combinations, though,
 * take it seven seconds on a cache miss, and one timeout plus one retry stretches that past ten —
 * while the index answers any filter it can express in a fraction of one, over the most popular
 * games it holds. Two and a half seconds is long enough that a page RAWG answers at its usual pace
 * is never second-guessed, and short enough that a visitor is not left looking at a skeleton for
 * the whole of RAWG's slow path.
 */
export const RAWG_HEDGE_MS = 2_500

interface PageInput {
  filter?: GameFilter | null
  sort: GameSort
  page: number
  pageSize: number
}

export const games: QueryResolvers['games'] = (_parent, args, context) =>
  withUpstreamErrors(() => catalogPage(context, args))

/** What a catalog page is asked for, as the `games` field takes it. */
export interface CatalogPageArgs {
  filter?: GameFilter | null
  sort?: GameSort | null
  page?: number | null
  pageSize?: number | null
}

/**
 * One catalog page, by whichever path `/games` would choose for it. The `games` field answers
 * with it, and so does `/api/ask`, which retrieves its candidates exactly as the catalog would.
 * Upstream errors are thrown as they are; the field turns them into GraphQL errors.
 */
export async function catalogPage(
  context: GraphQLContext,
  args: CatalogPageArgs,
): Promise<GamePage> {
  const page = args.page ?? 1
  const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), MAX_PAGE_SIZE)
  const sort = args.sort ?? 'POPULARITY_DESC'
  const input: PageInput = { filter: args.filter, sort, page, pageSize }
  const priceFilters = priceFiltersUsed(args.filter, sort)
  const facetFilters = indexFacetFiltersUsed(args.filter)

  // Started, never awaited yet. On a page RAWG answers, the index enhances the result and must
  // not be a step in front of the request it enhances: a store that is alive but slow would
  // otherwise add its whole latency to the page before the RAWG fetch had even begun.
  const pending = indexState(context)

  // Nothing is fetched for a page past the end — but it still reports what the index is doing,
  // so a banner does not flicker off when a visitor walks past it.
  if (page < 1 || page > MAX_PAGE) {
    return mapGamePage({ count: 0, next: null }, [], page, pageSize, freshnessOf(await pending))
  }

  if (priceFilters.length === 0 && facetFilters.length === 0) {
    return rawgPage(context, input, pending, { attach: true, prices: 'unless-stale' })
  }

  // Which path answers depends on how fresh the prices are, so from here the state is needed
  // before anything else can start.
  const state = await pending

  // Stale prices drop the price filters and the price sort wherever they were set, and are
  // named in `ignoredFilters`; what is left decides which path answers. A sort the index never
  // owned is the visitor's and survives — only a price or discount order has to go.
  const stripped: PageInput = state.stale
    ? { ...input, filter: withoutPriceFilters(args.filter), sort: withoutIndexSort(sort) }
    : input
  const ignoredFilters = state.stale ? priceFilters : []

  if (state.stale && facetFilters.length === 0) {
    return rawgPage(
      context,
      stripped,
      state,
      // A language list does not go stale with the prices, so the attachment still runs.
      { attach: true, prices: false, ignoredFilters },
    )
  }

  try {
    return await indexPage(context, stripped, state, ignoredFilters)
  } catch (error) {
    warnIndexOnce(context, 'the catalog fell back to RAWG', error)
    return rawgPage(
      context,
      { ...input, filter: withoutPriceFilters(args.filter), sort: withoutIndexSort(sort) },
      // The freshness the index reported before it failed is still the truth about it; what
      // this answer could not do is listed beside it.
      state,
      // The index just failed; asking it again for the documents of this page would only fail
      // again, one round trip later.
      {
        attach: false,
        prices: false,
        ignoredFilters: [...priceFilters, ...facetFilters],
      },
    )
  }
}

function freshnessOf(state: IndexState): GamePageIndexState {
  return { indexStale: state.stale, indexUpdatedAt: state.updatedAt }
}

/**
 * The sort a page falls back to when the index cannot order it: the visitor's own, unless the
 * visitor asked for one only the index has. `priceFiltersUsed` reports exactly those as `sort` in
 * `ignoredFilters`, so nothing is dropped without being named.
 */
function withoutIndexSort(sort: GameSort): GameSort {
  return INDEX_SORTS.includes(sort) ? 'POPULARITY_DESC' : sort
}

async function indexPage(
  context: GraphQLContext,
  input: PageInput,
  state: IndexState,
  ignoredFilters: string[],
): Promise<GamePage> {
  if (indexFailed(context)) {
    throw new IndexUnavailableError('an earlier call in this request did not answer')
  }
  const query = toIndexQuery({ ...input, today: context.today })
  const meta: GamePageIndexState = {
    indexedOnly: true,
    indexStale: state.stale,
    indexUpdatedAt: state.updatedAt,
    ignoredFilters: [...ignoredFilters, ...rawgOnlyFiltersUsed(input.filter)],
  }

  const answer = await cachedIndexPage(context, query, state.version)

  // The cached page is the canonical one, prices included; a stale answer strips them on the way
  // out, so the cache does not need a second entry per staleness state.
  const items = state.stale ? withoutPrices(answer.items) : answer.items
  return buildPage(items, answer.total, input, meta)
}

interface RawgPageOptions {
  attach: boolean
  /** `'unless-stale'` asks the state, which this path may not have waited for yet. */
  prices: boolean | 'unless-stale'
  ignoredFilters?: string[]
}

/**
 * A page RAWG answers, with whatever the index can add to it.
 *
 * The RAWG request is sent before anything is awaited, and the index state is awaited beside it,
 * so the two run at once: the index costs this page the greater of the two, not the sum. The
 * documents then follow as soon as the ids exist — one `getMany`, after RAWG has said which
 * games are on the page and the state has said whether their prices may be shown.
 *
 * When RAWG is slower than `RAWG_HEDGE_MS`, the index may answer the page instead — see
 * `indexPageIfRawgIsSlow` for when it may and what happens to the request it overtook. Whatever
 * RAWG says within the budget, an answer or an error, is taken exactly as it always was.
 */
async function rawgPage(
  context: GraphQLContext,
  input: PageInput,
  pending: IndexState | Promise<IndexState>,
  options: RawgPageOptions,
): Promise<GamePage> {
  const params = filterToParams({
    filter: input.filter,
    sort: input.sort,
    page: input.page,
    pageSize: input.pageSize,
    today: context.today,
  })
  const fetching = context
    .rawg('games', params)
    .then((body) => rawgListOrThrow<RawgGameListItem>(body))

  const overtaken = await indexPageIfRawgIsSlow(
    context,
    input,
    fetching,
    pending,
    options.ignoredFilters ?? [],
  )
  if (overtaken) return overtaken

  const [raw, state] = await Promise.all([fetching, pending])

  const items = postFilter(raw.results ?? [], input.filter).map(mapGameCard)
  const prices = options.prices === 'unless-stale' ? !state.stale : options.prices
  if (options.attach) await attachIndexData(context, items, { prices })

  return mapGamePage(raw, items, input.page, input.pageSize, {
    indexStale: state.stale,
    indexUpdatedAt: state.updatedAt,
    ignoredFilters: options.ignoredFilters ?? [],
  })
}

/**
 * The index's answer to a RAWG page, when RAWG is slower than `RAWG_HEDGE_MS` and the index can
 * give the same page; `null` whenever the caller should keep waiting for RAWG instead.
 *
 * The index may only stand in for a page it can actually express, so this declines, and the page
 * waits for RAWG exactly as before, when:
 *
 * - the filter names developers, publishers or tags — the index has no facet for them, and its
 *   page would be a different page rather than a faster one;
 * - the index has nothing to answer with: no metadata (unpublished, not configured, unreadable),
 *   or an earlier call in this request already let it down (`indexFailed`);
 * - the index page fails, or comes back empty. Empty is usually a page deeper than the games the
 *   index holds, where RAWG is the only one with something to show; a failure is warned about once
 *   like every other index failure, and the RAWG page then renders without prices, as it would
 *   after any failed index read.
 *
 * The answer is `indexPage`'s own, so it reads exactly like an index-served page: `indexedOnly`,
 * which shows the catalog's "searching the most popular games" note, and no prices when they are
 * stale — `input` reaches here with the price filters already taken out in that case, so nothing
 * stale is filtered on either. A title search is among what the index can express: it matches the
 * names of the games it holds rather than ranking RAWG's whole catalog by relevance, which is
 * exactly what that note tells the visitor. `/api/ask` reaches this through `catalogPage` too, and
 * takes the same answer inside its own, longer RAWG budget.
 *
 * The RAWG request it overtook is not cancelled. It keeps running so that its response lands in
 * the RAWG cache, and the next visitor asking for this page gets the whole catalog's answer in
 * milliseconds. On a platform that freezes a function once it has answered, `context.waitUntil`
 * keeps it alive until then; without one the request is simply left to finish. Either way it is
 * handed over already settled, so a rejection nobody is waiting for any more can never surface as
 * an unhandled one.
 *
 * One `console.info` line per overtaken page: the runtime logs are how this is seen in production.
 */
async function indexPageIfRawgIsSlow(
  context: GraphQLContext,
  input: PageInput,
  fetching: Promise<unknown>,
  pending: IndexState | Promise<IndexState>,
  ignoredFilters: string[],
): Promise<GamePage | null> {
  if (rawgOnlyFiltersUsed(input.filter).length > 0 || indexFailed(context)) return null
  if (!(await outlasts(fetching, RAWG_HEDGE_MS))) return null

  const state = await pending
  // Checked again: the state read itself may be what failed while RAWG was still out.
  if (state.meta === null || indexFailed(context)) return null

  let page: GamePage
  try {
    page = await indexPage(context, input, state, ignoredFilters)
  } catch (error) {
    warnIndexOnce(context, 'a slow RAWG page could not be answered from the index', error)
    return null
  }
  if (page.items.length === 0) return null

  const settled = fetching.then(
    () => undefined,
    () => undefined,
  )
  context.waitUntil?.(settled)
  console.info(`[catalog] RAWG slower than ${RAWG_HEDGE_MS} ms, answered from the index`)
  return page
}

/**
 * Whether `work` is still unsettled `ms` from now. Settling either way counts as in time — a RAWG
 * error inside the budget is the caller's to see, not a reason to look elsewhere — and clears the
 * timer at once, so a fast answer leaves nothing scheduled behind it.
 */
function outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    const settle = () => {
      clearTimeout(timer)
      resolve(false)
    }
    work.then(settle, settle)
  })
}

/**
 * The index knows the exact total, so `hasNext` is arithmetic rather than a cursor RAWG handed
 * back; `mapGamePage` reads it off the same `next` field either way.
 */
function buildPage(
  items: GamePage['items'],
  total: number,
  input: PageInput,
  meta: GamePageIndexState,
): GamePage {
  const hasNext = input.page * input.pageSize < total
  return mapGamePage(
    { count: total, next: hasNext ? 'more' : null },
    items,
    input.page,
    input.pageSize,
    meta,
  )
}
