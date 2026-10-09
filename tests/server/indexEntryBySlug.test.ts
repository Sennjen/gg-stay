import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphQLContext } from '../../server/graphql/context'
import {
  indexEntry,
  indexEntryBySlug,
  indexFailed,
  warnIndexOnce,
} from '../../server/graphql/indexPath'
import type { GameIndex } from '../../server/index/GameIndex'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import { countCalls, overriding, publishTestIndex, type CountingIndex } from './support/yoga'

/**
 * `indexEntryBySlug`: how the game page finds its index document before RAWG has told it the
 * game's id. Asked directly here, one request at a time, so that every way it can decline is
 * pinned on its own; `gamePageBudget.test.ts` shows what the page does with the answer.
 */

const WITCHER = DEV_FIXTURE_GAMES[0]!
const SLUG = WITCHER.slug

/** One request. Its index state lives and dies with this object, as it does with yoga's context. */
const requestOn = (index: GameIndex) => ({ index }) as GraphQLContext

const published = async (): Promise<CountingIndex> =>
  countCalls(await publishTestIndex(DEV_FIXTURE_GAMES))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('indexEntryBySlug', () => {
  it('finds the document with one lookup of the slug and one read of the id it stands for', async () => {
    const index = await published()

    expect(await indexEntryBySlug(requestOn(index), SLUG)).toEqual(WITCHER)
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])
  })

  it('looks a slug up once per request, however often it is asked for', async () => {
    const index = await published()
    const request = requestOn(index)

    const [first, second] = await Promise.all([
      indexEntryBySlug(request, SLUG),
      indexEntryBySlug(request, SLUG),
    ])
    expect(await indexEntryBySlug(request, SLUG)).toEqual(first)
    expect(second).toEqual(first)
    expect(index.calls.idBySlug).toEqual([SLUG])
    expect(index.calls.getOne).toEqual([3328])

    // Another slug is another lookup, and another request starts from nothing.
    await indexEntryBySlug(request, 'portal-2')
    await indexEntryBySlug(requestOn(index), SLUG)
    expect(index.calls.idBySlug).toEqual([SLUG, 'portal-2', SLUG])
  })

  it('shares its read of the document with a read by id, whichever of the two comes first', async () => {
    const bySlugFirst = await published()
    const first = requestOn(bySlugFirst)
    await indexEntryBySlug(first, SLUG)
    expect(await indexEntry(first, 3328)).toEqual(WITCHER)
    expect(bySlugFirst.calls.getOne).toEqual([3328])

    const byIdFirst = await published()
    const second = requestOn(byIdFirst)
    await indexEntry(second, 3328)
    expect(await indexEntryBySlug(second, SLUG)).toEqual(WITCHER)
    expect(byIdFirst.calls.getOne).toEqual([3328])
  })

  it('answers null for a slug the index does not hold, and reads no document for it', async () => {
    const index = await published()
    const request = requestOn(index)

    expect(await indexEntryBySlug(request, 'no-such-game')).toBeNull()
    expect(index.calls.getOne).toEqual([])
    // Not knowing a slug is not a failure: the request's index is as good as it was.
    expect(indexFailed(request)).toBe(false)
  })

  it('answers null for every slug of a version published without slugs, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(
      overriding(await publishTestIndex(DEV_FIXTURE_GAMES), { idBySlug: async () => null }),
    )
    const request = requestOn(index)

    expect(await indexEntryBySlug(request, SLUG)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    // The documents are all still there for whoever knows the id.
    expect(await indexEntry(request, 3328)).toEqual(WITCHER)
  })

  it('answers null when the lookup fails, warns once and marks the request’s index as failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(
      overriding(await publishTestIndex(DEV_FIXTURE_GAMES), {
        idBySlug: () => Promise.reject(new Error('ECONNRESET')),
      }),
    )
    const request = requestOn(index)

    expect(await indexEntryBySlug(request, SLUG)).toBeNull()
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[index] the game page could not look its slug up in the index: ECONNRESET',
    )
    expect(indexFailed(request)).toBe(true)
    // Nothing more is asked of an index that has let the request down.
    expect(await indexEntry(request, 3328)).toBeNull()
    expect(index.calls.getOne).toEqual([])
  })

  it('is not even made once the index has failed in this request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = await published()
    const request = requestOn(index)
    warnIndexOnce(request, 'an earlier read failed', new Error('ECONNRESET'))

    expect(await indexEntryBySlug(request, SLUG)).toBeNull()
    expect(index.calls.idBySlug).toEqual([])
    expect(index.calls.getOne).toEqual([])
  })

  it('answers null when the document cannot be read, as a read by id does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = countCalls(
      overriding(await publishTestIndex(DEV_FIXTURE_GAMES), {
        getOne: () => Promise.reject(new Error('ECONNRESET')),
      }),
    )
    const request = requestOn(index)

    expect(await indexEntryBySlug(request, SLUG)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(indexFailed(request)).toBe(true)
  })

  it('answers null for a document that carries another slug, and leaves the read by id alone', async () => {
    // The lookup and the read straddled a publication: the id the slug stood for now belongs to a
    // document under another address.
    const moved = { ...WITCHER, slug: 'the-witcher-3-game-of-the-year' }
    const index = countCalls(
      overriding(await publishTestIndex([moved]), { idBySlug: async () => 3328 }),
    )
    const request = requestOn(index)

    expect(await indexEntryBySlug(request, SLUG)).toBeNull()
    // The document is still the document of game 3328 for whoever asks for it by id.
    expect(await indexEntry(request, 3328)).toEqual(moved)
    expect(index.calls.getOne).toEqual([3328])
    expect(indexFailed(request)).toBe(false)
  })

  it('answers null when the id the slug stood for is gone by the time it is read', async () => {
    const index = countCalls(
      overriding(await publishTestIndex(DEV_FIXTURE_GAMES), { idBySlug: async () => 999_999 }),
    )

    expect(await indexEntryBySlug(requestOn(index), SLUG)).toBeNull()
    expect(index.calls.getOne).toEqual([999_999])
  })
})
