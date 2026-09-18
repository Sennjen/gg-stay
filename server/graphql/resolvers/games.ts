import { MAX_PAGE, MAX_PAGE_SIZE } from '../../../shared/catalog'
import { filterToParams } from '../../rawg/filterToParams'
import { mapGameCard, mapGamePage } from '../../rawg/mappers'
import { postFilter } from '../../rawg/postFilter'
import type { RawgGameListItem, RawgList } from '../../rawg/types'
import { withUpstreamErrors } from '../errors'
import type { QueryResolvers } from '../__generated__/resolvers-types'

export const games: QueryResolvers['games'] = (_parent, args, context) =>
  withUpstreamErrors(async () => {
    const page = args.page ?? 1
    const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), MAX_PAGE_SIZE)
    if (page < 1 || page > MAX_PAGE)
      return mapGamePage({ count: 0, next: null }, [], page, pageSize)

    const params = filterToParams({
      filter: args.filter,
      sort: args.sort ?? 'POPULARITY_DESC',
      page,
      pageSize,
      today: context.today,
    })
    const raw = (await context.rawg('games', params)) as RawgList<RawgGameListItem>
    const items = postFilter(raw.results ?? [], args.filter).map(mapGameCard)
    return mapGamePage(raw, items, page, pageSize)
  })
