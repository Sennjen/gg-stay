import { parse } from 'graphql'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as operations from '../../app/graphql/__generated__/operations'
import { createYogaApp } from '../../server/graphql/yoga'
import {
  MAX_ALIASED_UPSTREAM_FIELDS,
  MAX_DEPTH,
  MAX_ROOT_FIELDS,
  checkQueryLimits,
} from '../../server/graphql/queryLimits'
import { UpstreamError, type RawgFetch } from '../../server/rawg/rawgFetch'
import type { SteamFetch } from '../../server/steam/steamFetch'
import games from '../fixtures/rawg/games.json'

const steam: SteamFetch = async () => {
  throw new UpstreamError('NOT_FOUND', 404)
}

/** Counts every upstream call so a rejected query can be proven to have reached none. */
function countingRawg() {
  const calls: string[] = []
  const rawg: RawgFetch = async (path) => {
    calls.push(path)
    if (path === 'games') return games
    throw new UpstreamError('NOT_FOUND', 404)
  }
  return { rawg, calls }
}

async function post(rawg: RawgFetch, body: unknown) {
  const yoga = createYogaApp(() => ({ rawg, steam, today: '2026-09-18' }))
  const response = await yoga.fetch('http://test/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

const ORIGINAL_ENV = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV
  vi.unstubAllEnvs()
})

describe('checkQueryLimits', () => {
  const check = (query: string, allowIntrospection = true) =>
    checkQueryLimits(parse(query), { allowIntrospection })

  it('accepts a normal page operation', () => {
    expect(check('{ games { total items { id cover { url } } } }')).toBeNull()
  })

  /** A chain of `levels` nested fields, e.g. `f { f { f } }` for 3. */
  const nest = (levels: number): string => (levels <= 1 ? 'f' : `f { ${nest(levels - 1)} }`)

  it('rejects an operation deeper than the limit', () => {
    // One level past MAX_DEPTH. The schema is not this deep, which is why the limit can be tight.
    const violation = check(`{ ${nest(MAX_DEPTH + 1)} }`)
    expect(violation?.code).toBe('QUERY_TOO_COMPLEX')
    expect(violation?.message).toMatch(/too deep/)
  })

  it('accepts an operation exactly at the depth limit', () => {
    expect(check(`{ ${nest(MAX_DEPTH)} }`)).toBeNull()
  })

  it('rejects more root fields than the limit, counting aliases', () => {
    const fields = Array.from({ length: MAX_ROOT_FIELDS + 1 }, (_, i) => `a${i}: genres { id }`)
    const violation = check(`{ ${fields.join(' ')} }`)
    expect(violation?.code).toBe('QUERY_TOO_COMPLEX')
    expect(violation?.message).toMatch(/too many root fields/)
  })

  it('rejects an upstream root field aliased beyond its per-operation cap', () => {
    const fields = Array.from(
      { length: MAX_ALIASED_UPSTREAM_FIELDS + 1 },
      (_, i) => `a${i}: game(slug: "x") { id }`,
    )
    const violation = check(`{ ${fields.join(' ')} }`)
    expect(violation?.code).toBe('QUERY_TOO_COMPLEX')
    expect(violation?.message).toMatch(/"game"/)
  })

  it('allows the cap itself', () => {
    const fields = Array.from(
      { length: MAX_ALIASED_UPSTREAM_FIELDS },
      (_, i) => `a${i}: game(slug: "x") { id }`,
    )
    expect(check(`{ ${fields.join(' ')} }`)).toBeNull()
  })

  it('counts depth through fragment spreads', () => {
    const query = `
      { landing { carousel { ...Card } } }
      fragment Card on GameCard { cover { url } }
    `
    // landing > carousel > cover > url = 4
    expect(check(query)).toBeNull()
  })

  it('does not hang on a cyclic fragment', () => {
    const query = `
      { landing { ...A } }
      fragment A on Landing { ...B }
      fragment B on Landing { ...A }
    `
    expect(check(query)).toBeNull()
  })

  it('rejects __schema and __type when introspection is not allowed', () => {
    expect(check('{ __schema { types { name } } }', false)?.code).toBe('INTROSPECTION_DISABLED')
    expect(check('{ __type(name: "Game") { name } }', false)?.code).toBe('INTROSPECTION_DISABLED')
  })

  it('still allows __typename when introspection is not allowed', () => {
    expect(check('{ __typename }', false)).toBeNull()
  })
})

describe('every shipped document passes the limits', () => {
  const documents = Object.entries(operations).filter(([name]) => name.endsWith('Document'))

  it.each(documents)('%s', (_name, document) => {
    expect(checkQueryLimits(document as never, { allowIntrospection: true })).toBeNull()
  })
})

describe('the endpoint enforces the limits', () => {
  it('rejects 200 aliased game fields without making a single upstream call', async () => {
    const { rawg, calls } = countingRawg()
    const fields = Array.from({ length: 200 }, (_, i) => `a${i}: game(slug: "x") { id }`)
    const response = await post(rawg, { query: `{ ${fields.join(' ')} }` })

    expect(response.status).toBe(200)
    expect(response.json().errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX')
    expect(calls).toEqual([])
  })

  it('lets a normal catalog operation through', async () => {
    const { rawg, calls } = countingRawg()
    const response = await post(rawg, { query: '{ games { total items { id name } } }' })

    expect(response.status).toBe(200)
    expect(response.json().errors).toBeUndefined()
    expect(calls).toEqual(['games'])
  })

  it('rejects introspection when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { rawg } = countingRawg()
    const response = await post(rawg, { query: '{ __schema { types { name } } }' })

    expect(response.status).toBe(200)
    expect(response.json().errors?.[0]?.extensions?.code).toBe('INTROSPECTION_DISABLED')
  })

  it('serves introspection outside production', async () => {
    const { rawg } = countingRawg()
    const response = await post(rawg, { query: '{ __schema { queryType { name } } }' })

    expect(response.json().data?.__schema?.queryType?.name).toBe('Query')
  })

  it('rejects a batched (array body) request', async () => {
    const { rawg, calls } = countingRawg()
    const response = await post(rawg, [
      { query: '{ genres { id } }' },
      { query: '{ genres { id } }' },
    ])

    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })
})
