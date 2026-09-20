import { MAX_PAGE, MAX_PAGE_SIZE } from '../../../shared/catalog'
import { IndexUnavailableError } from '../../index/index'
import { toGameCard } from '../../index/toGraphql'
import { filterToParams } from '../../rawg/filterToParams'
import { mapGameCard, mapGamePage, type GamePageIndexState } from '../../rawg/mappers'
import { postFilter } from '../../rawg/postFilter'
import type { RawgGameListItem, RawgList } from '../../rawg/types'
import type { GraphQLContext } from '../context'
import { withUpstreamErrors } from '../errors'
import {
  attachIndexData,
  indexFacetFiltersUsed,
  indexFailed,
  INDEX_SORTS,
  indexState,
  priceFiltersUsed,
  pageCacheKey,
  PAGE_CACHE_TTL_SECONDS,
  rawgOnlyFiltersUsed,
  toIndexQuery,
  warnIndexOnce,
  withoutPriceFilters,
  withoutPrices,
  type CachedIndexPage,
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
 */

interface PageInput {
  filter?: GameFilter | null
  sort: GameSort
  page: number
  pageSize: number
}

export const games: QueryResolvers['games'] = (_parent, args, context) =>
  withUpstreamErrors(async () => {
    const page = args.page ?? 1
    const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), MAX_PAGE_SIZE)
    const sort = args.sort ?? 'POPULARITY_DESC'
    const input: PageInput = { filter: args.filter, sort, page, pageSize }
    const state = await indexState(context)
    // Even an empty page reports what the index is doing, so a banner does not flicker off when a
    // visitor pages past the end.
    const freshness: GamePageIndexState = {
      indexStale: state.stale,
      indexUpdatedAt: state.updatedAt,
    }

    if (page < 1 || page > MAX_PAGE)
      return mapGamePage({ count: 0, next: null }, [], page, pageSize, freshness)

    const priceFilters = priceFiltersUsed(args.filter, sort)
    const facetFilters = indexFacetFiltersUsed(args.filter)

    if (priceFilters.length === 0 && facetFilters.length === 0) {
      return rawgPage(context, input, freshness, { attach: true, prices: !state.stale })
    }

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
        { ...freshness, ignoredFilters },
        // A language list does not go stale with the prices, so the attachment still runs.
        { attach: true, prices: false },
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
        { ...freshness, ignoredFilters: [...priceFilters, ...facetFilters] },
        // The index just failed; asking it again for the documents of this page would only fail
        // again, one round trip later.
        { attach: false, prices: false },
      )
    }
  })

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
  const key = pageCacheKey(query, state.version)
  const meta: GamePageIndexState = {
    indexedOnly: true,
    indexStale: state.stale,
    indexUpdatedAt: state.updatedAt,
    ignoredFilters: [...ignoredFilters, ...rawgOnlyFiltersUsed(input.filter)],
  }

  const cached = await context.cache.get<CachedIndexPage>(key)
  const answer = cached ?? (await searchIndex())
  if (!cached) await context.cache.set(key, answer, PAGE_CACHE_TTL_SECONDS)

  // The cached page is the canonical one, prices included; a stale answer strips them on the way
  // out, so the cache does not need a second entry per staleness state.
  const items = state.stale ? withoutPrices(answer.items) : answer.items
  return buildPage(items, answer.total, input, meta)

  async function searchIndex(): Promise<CachedIndexPage> {
    const result = await context.index.search(query)
    return { items: result.games.map(toGameCard), total: result.total }
  }
}

async function rawgPage(
  context: GraphQLContext,
  input: PageInput,
  meta: GamePageIndexState,
  options: { attach: boolean; prices: boolean },
): Promise<GamePage> {
  const params = filterToParams({
    filter: input.filter,
    sort: input.sort,
    page: input.page,
    pageSize: input.pageSize,
    today: context.today,
  })
  const raw = (await context.rawg('games', params)) as RawgList<RawgGameListItem>
  const items = postFilter(raw.results ?? [], input.filter).map(mapGameCard)
  if (options.attach) await attachIndexData(context, items, { prices: options.prices })
  return mapGamePage(raw, items, input.page, input.pageSize, meta)
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
