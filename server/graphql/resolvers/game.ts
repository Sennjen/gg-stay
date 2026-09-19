import { mapGame } from '../../rawg/mappers'
import type { RawgGameDetail, RawgList, RawgScreenshot, RawgStoreLink } from '../../rawg/types'
import { withUpstreamErrors } from '../errors'
import type { QueryResolvers } from '../__generated__/resolvers-types'

export const game: QueryResolvers['game'] = (_parent, { slug }, context) =>
  withUpstreamErrors(async () => {
    const path = `games/${encodeURIComponent(slug)}`
    const [detail, storeLinks, screenshots] = await Promise.all([
      context.rawg(path) as Promise<RawgGameDetail>,
      // Store links are an enhancement: the page still renders without them.
      (context.rawg(`${path}/stores`) as Promise<RawgList<RawgStoreLink>>).catch(() => null),
      // Same pattern: screenshots are an enhancement, not required to render the page.
      (context.rawg(`${path}/screenshots`) as Promise<RawgList<RawgScreenshot>>).catch(() => null),
    ])
    return mapGame(detail, storeLinks?.results ?? [], screenshots?.results ?? [])
  })
