import { describe, expect, it, vi } from 'vitest'
import type { RawgFetch } from '../../server/rawg/rawgFetch'
import detail from '../fixtures/rawg/game-the-witcher-3-wild-hunt.json' with { type: 'json' }
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import { FIXTURE_GAMES } from '../fixtures/index/games'
import { fixtureRawg, overriding, publishTestIndex, runQuery } from './support/yoga'

/**
 * The game page's "made in Ukraine" flag has two sources: the game's own RAWG developers, checked
 * against the studio list, which is right for any game RAWG knows — inside the index or not — and
 * the index document's flag, which the refresh job set from the same list. Either one is enough.
 */

const GAME = /* GraphQL */ `
  query Game($slug: String!) {
    game(slug: $slug) {
      id
      madeInUkraine
    }
  }
`

const SLUG = 'the-witcher-3-wild-hunt'

/** The recorded game page, credited to `developers` instead of the studio it names. */
function developedBy(...developers: string[]): RawgFetch {
  return async (path, params, options) =>
    path === `games/${SLUG}`
      ? { ...detail, developers: developers.map((slug, id) => ({ id, slug, name: slug })) }
      : fixtureRawg(path, params, options)
}

describe('the made-in-Ukraine flag on the game page', () => {
  it('comes from the game developers for a game the index has never seen', async () => {
    const index = await publishTestIndex(FIXTURE_GAMES)

    const { data, errors } = await runQuery(
      { index, rawg: developedBy('valve-software', '4a-games') },
      GAME,
      { slug: SLUG },
    )

    expect(errors).toBeUndefined()
    expect(data!.game.madeInUkraine).toBe(true)
  })

  it('comes from the developers when the index has nothing published', async () => {
    const { data } = await runQuery({ rawg: developedBy('gsc-game-world') }, GAME, { slug: SLUG })

    expect(data!.game.madeInUkraine).toBe(true)
  })

  it('comes from the developers when the index fails to answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index = overriding(await publishTestIndex(DEV_FIXTURE_GAMES), {
      getOne: () => Promise.reject(new Error('ECONNRESET')),
    })

    const { data, errors } = await runQuery({ index, rawg: developedBy('gsc-game-world') }, GAME, {
      slug: SLUG,
    })

    expect(errors).toBeUndefined()
    expect(data!.game.madeInUkraine).toBe(true)
    warn.mockRestore()
  })

  it('comes from the index when the developers do not say so', async () => {
    const index = await publishTestIndex([{ ...DEV_FIXTURE_GAMES[0]!, madeInUkraine: true }])

    const { data } = await runQuery({ index }, GAME, { slug: SLUG })

    expect(data!.game.madeInUkraine).toBe(true)
  })

  it('stays off when neither source says so', async () => {
    const index = await publishTestIndex(DEV_FIXTURE_GAMES)

    const { data } = await runQuery({ index }, GAME, { slug: SLUG })

    expect(data!.game.madeInUkraine).toBe(false)
  })
})
