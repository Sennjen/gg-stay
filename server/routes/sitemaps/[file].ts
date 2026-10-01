import { useGameIndex } from '../../index/index'
import { send, siteUrlOf } from '../../seo/respond'
import {
  gamesSitemapResponse,
  isGamesFile,
  staticSitemapResponse,
} from '../../seo/sitemapResponses'
import { readSitemapMeta, readSitemapSource } from '../../seo/sitemapSource'

/**
 * `/sitemaps/static.xml` (the publication date only) and `/sitemaps/games-<n>.xml` (every slug of
 * the published index, sliced); anything else is a 404 without touching the index.
 */
export default defineEventHandler(async (event) => {
  const file = getRouterParam(event, 'file') ?? ''
  const siteUrl = siteUrlOf(event)
  if (file === 'static.xml') {
    return send(event, staticSitemapResponse(siteUrl, await readSitemapMeta(await useGameIndex())))
  }
  const source = isGamesFile(file)
    ? await readSitemapSource(await useGameIndex())
    : { slugs: [], updatedAt: null, complete: true }
  return send(event, gamesSitemapResponse(siteUrl, file, source))
})
