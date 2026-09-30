import { describe, expect, it } from 'vitest'
import { rawgListOrThrow, UpstreamError, type RawgFetch } from '../../server/rawg/rawgFetch'
import { fixtureRawg, runQuery } from './support/yoga'

/**
 * RAWG has been seen answering a list with an empty body under a 200. The transport hands such a
 * body back once without caching it; the site's list readers turn it into the upstream error it
 * stands for, so a page fails through the ordinary error mapping — never on a property read.
 */

const CATALOG = /* GraphQL */ `
  query {
    games {
      total
    }
  }
`

const LANDING = /* GraphQL */ `
  query {
    landing {
      totalGames
    }
  }
`

/** The fixture RAWG, except that every `games` list comes back as `body`. */
function listsAnswering(body: unknown): RawgFetch {
  return async (path, params, options) =>
    path === 'games' ? body : fixtureRawg(path, params, options)
}

describe('rawgListOrThrow', () => {
  it('passes a list through', () => {
    const list = { count: 1, next: null, results: [{ id: 1 }] }
    expect(rawgListOrThrow(list)).toBe(list)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'Service Unavailable'],
    ['an object whose results are not a list', { results: 'none' }],
  ])('turns %s into a RAWG upstream error', (_name, body) => {
    expect(() => rawgListOrThrow(body)).toThrow(UpstreamError)
    expect(() => rawgListOrThrow(body)).toThrow(expect.objectContaining({ kind: 'ERROR' }))
  })
})

describe('a list RAWG answered with an empty body', () => {
  it.each([
    ['the catalog', CATALOG],
    ['the landing page', LANDING],
  ])('fails %s as an upstream error', async (_name, query) => {
    const { data, errors } = await runQuery({ rawg: listsAnswering(null) }, query)

    expect(data).toBeNull()
    expect(errors?.[0]).toMatchObject({
      message: 'The data source failed',
      extensions: { code: 'UPSTREAM_ERROR' },
    })
  })
})
