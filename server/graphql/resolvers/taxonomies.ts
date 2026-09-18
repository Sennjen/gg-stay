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
    const term = search.trim()
    if (term.length < 2) return []
    return list(context, 'developers', { search: term, page_size: 10 })
  })
