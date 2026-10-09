import { describe, expect, it } from 'vitest'
import { withoutLinkQueries } from '../../server/rawg/paginationLinks'

/**
 * What the site keeps of a RAWG list's links to its neighbouring pages: that there is one, and
 * nothing of the request it repeats — the API key first of all.
 */

const KEY = 'a-very-secret-rawg-key'
const LIST = `https://api.rawg.io/api/games?key=${KEY}&page=3&search=half+life`

describe('a RAWG body with its pagination links cut', () => {
  it('keeps the address of each link and drops its query, the key and the search with it', () => {
    const kept = withoutLinkQueries({
      count: 100,
      next: LIST,
      previous: LIST.replace('page=3', 'page=1'),
      results: [{ id: 1 }],
    })

    expect(kept).toEqual({
      count: 100,
      next: 'https://api.rawg.io/api/games',
      previous: 'https://api.rawg.io/api/games',
      results: [{ id: 1 }],
    })
    for (const hidden of [KEY, 'key=', 'half', 'search', 'page=', '?', '&']) {
      expect(JSON.stringify(kept)).not.toContain(hidden)
    }
  })

  it('still says whether there is another page, which is all anyone reads of a link', () => {
    const pages = [
      [LIST, true],
      ['https://api.rawg.io/api/games#key=x', true],
      // A link that is nothing but a query, or a fragment, is still a link.
      ['?page=2&key=x', true],
      ['#next', true],
      [null, false],
      [undefined, false],
      ['', false],
    ] as const
    for (const [next, more] of pages) {
      const kept = withoutLinkQueries({ next }) as { next: unknown }
      expect(Boolean(kept.next)).toBe(more)
      expect(String(kept.next)).not.toMatch(/[?#]|key/)
    }
    expect(withoutLinkQueries({ next: '?page=2&key=x' })).toEqual({ next: '/' })
    expect(withoutLinkQueries({ next: null, previous: null })).toEqual({
      next: null,
      previous: null,
    })
  })

  it('keeps of a link that is no text only whether it was there', () => {
    expect(withoutLinkQueries({ next: { url: LIST }, previous: [LIST], count: 3 })).toEqual({
      next: true,
      previous: true,
      count: 3,
    })
    expect(withoutLinkQueries({ next: 0, previous: false })).toEqual({
      next: false,
      previous: false,
    })
    expect(withoutLinkQueries({ next: true })).toEqual({ next: true })
  })

  it('leaves everything else of the body as it was, and the body it was given untouched', () => {
    const results = [{ id: 1, website: 'https://example.com/?ref=rawg' }]
    const body = { count: 1, next: LIST, previous: null, results }

    const kept = withoutLinkQueries(body) as typeof body

    expect(kept).not.toBe(body)
    expect(kept.results).toBe(results)
    expect(body.next).toBe(LIST)
  })

  it('hands back a body that has no such links as the very one it was given', () => {
    const detail = { id: 4200, name: 'Portal 2', website: 'https://example.com/?a=b' }
    expect(withoutLinkQueries(detail)).toBe(detail)

    const list = [{ next: LIST }]
    expect(withoutLinkQueries(list)).toBe(list)
    for (const body of [null, undefined, '', 'Service Unavailable', 42]) {
      expect(withoutLinkQueries(body)).toBe(body)
    }
  })
})
