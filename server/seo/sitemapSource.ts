import type { GameIndex, IndexedSlug } from '../index/GameIndex'

/**
 * What the sitemap routes read from the index: every slug and the publication date.
 *
 * `complete` tells the two empty answers apart. An index that is not configured holds nothing and
 * says so quietly (`unavailableGameIndex`), and a sitemap without games is the whole truth about
 * it. An index that let the read down is another matter: the sitemap still answers — the landing
 * and the catalog do not depend on it — but it is cached only briefly, so the games come back as
 * soon as the store does instead of hours later.
 */
export interface SitemapSource {
  slugs: IndexedSlug[]
  /** When the published version was published; `null` when there is none, or it was not read. */
  updatedAt: string | null
  complete: boolean
}

export async function readSitemapSource(index: GameIndex): Promise<SitemapSource> {
  try {
    const [meta, slugs] = await Promise.all([index.meta(), index.allSlugs()])
    return { slugs, updatedAt: meta?.updatedAt ?? null, complete: true }
  } catch {
    // Never fatal: the routes serve the static pages alone. The index layer has already logged.
    return { slugs: [], updatedAt: null, complete: false }
  }
}

/** What the static sitemap needs: the publication date alone. */
export interface SitemapMeta {
  updatedAt: string | null
  complete: boolean
}

/**
 * The publication date, for the static sitemap, without reading a single game: the landing and
 * the catalog are listed whatever the index holds, and `allSlugs` reads every document.
 */
export async function readSitemapMeta(index: GameIndex): Promise<SitemapMeta> {
  try {
    const meta = await index.meta()
    return { updatedAt: meta?.updatedAt ?? null, complete: true }
  } catch {
    return { updatedAt: null, complete: false }
  }
}

/** Six hours: the index is published once a night, and a crawler needs no fresher list than that. */
export const SITEMAP_CACHE_SECONDS = 6 * 60 * 60

/** A sitemap that is missing its games is kept only this long. */
export const INCOMPLETE_SITEMAP_CACHE_SECONDS = 10 * 60

/** `s-maxage` as well as `max-age`, so the CDN in front of the function keeps it too. */
export function sitemapCacheControl(complete: boolean): string {
  const seconds = complete ? SITEMAP_CACHE_SECONDS : INCOMPLETE_SITEMAP_CACHE_SECONDS
  return `public, max-age=${seconds}, s-maxage=${seconds}`
}
