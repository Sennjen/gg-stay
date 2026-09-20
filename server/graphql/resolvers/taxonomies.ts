import { MAX_SEARCH_LENGTH } from '../../../shared/catalog'
import { mapTaxonomy } from '../../rawg/mappers'
import type { RawgList, RawgTaxonomy } from '../../rawg/types'
import { withUpstreamErrors } from '../errors'
import type { GraphQLContext } from '../context'
import type { QueryResolvers } from '../__generated__/resolvers-types'

async function list(
  context: GraphQLContext,
  path: string,
  params?: Record<string, string | number>,
) {
  const raw = (await context.rawg(path, params)) as RawgList<RawgTaxonomy>
  return (raw.results ?? []).filter((item) => item.slug).map(mapTaxonomy)
}

export const genres: QueryResolvers['genres'] = (_parent, _args, context) =>
  withUpstreamErrors(() => list(context, 'genres'))

export const platforms: QueryResolvers['platforms'] = (_parent, _args, context) =>
  withUpstreamErrors(() => list(context, 'platforms'))

export const developers: QueryResolvers['developers'] = (_parent, { search }, context) =>
  withUpstreamErrors(async () => {
    // Capped for the same reason as the catalog's search term: it lands in a cache key.
    const term = search.trim().slice(0, MAX_SEARCH_LENGTH)
    if (term.length < 2) return []
    return list(context, 'developers', { search: term, page_size: 10 })
  })
