/**
 * A RAWG body with its pagination links cut down to all the site ever reads of them.
 *
 * A RAWG list ends in `next` and `previous`: the addresses of the neighbouring pages. Each is the
 * request's own address with another page number in it, so it repeats every parameter the request
 * carried — the API key, and whatever a visitor searched for. The transport keeps a body as it
 * came, so a list kept with those links is a list kept with the key in it: in this instance's
 * memory, and in the cache every instance shares, which outlives a deployment and on some plans
 * is one cache for a whole team's projects.
 *
 * So the site takes them out before the transport sees the body (`server/utils/rawg.ts`), and
 * nothing it keeps anywhere holds them. Nothing reads these links as links: a page is known to
 * have a next one by `next` being there at all (`mapGamePage` in `server/rawg/mappers.ts`). What
 * is left of a link is therefore its address without the query, which says the same thing; a
 * link that was nothing but a query is left as `/`, so that it still says it.
 *
 * The refresh job asks RAWG through a wiring of its own (`scripts/index/upstreams.ts`), keeps
 * what it is given in a map that dies with the process, and is not touched by this.
 *
 * What a kept list looks like is part of what the shared cache stores: change it, and
 * `SHARED_CACHE_SCHEMA` (`server/upstream/layeredCache.ts`) has to change with it.
 */

const LINKS = ['next', 'previous'] as const

/** The link without its query and fragment — or what else says as much as the value did. */
function withoutQuery(link: unknown): unknown {
  // No link, or a plain yes or no: nothing of the request is in it.
  if (link === null || link === undefined || typeof link === 'boolean') return link
  // Not a link at all. Only whether it was there can matter, and that is all that is kept.
  if (typeof link !== 'string') return Boolean(link)
  const address = link.split(/[?#]/, 1)[0] ?? ''
  return address === '' && link !== '' ? '/' : address
}

export function withoutLinkQueries(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const list = body as Record<string, unknown>
  if (!LINKS.some((name) => name in list)) return body
  const kept = { ...list }
  for (const name of LINKS) {
    if (name in kept) kept[name] = withoutQuery(kept[name])
  }
  return kept
}
