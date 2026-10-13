import { describe, expect, it } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import {
  countStoreRefs,
  isPlaystationProductId,
  isPlaystationTitleId,
  needsStoreLookup,
  playstationTitleFromUrl,
  storeRefsFromLinks,
  sweepStoreRefs,
  usableStoreRefs,
} from '../../../scripts/index/storeRefs'
import type { IndexedStoreRefs } from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { JOB_PLAYSTATION_TITLES } from '../../fixtures/index/jobPlaystation'
import { JOB_MICROSOFT_ID } from '../../fixtures/index/jobStores'
import { createJobHarness, type JobHarness } from './harness'

/**
 * Where a game's PlayStation title comes from: RAWG's own link to the PlayStation Store, read by
 * its shape. All twenty-five links looked at on 2026-10-12 had one shape —
 * `store.playstation.com/en-us/product/{productId}` — and each near-miss below is a link that
 * looks like one and is not.
 */

describe('playstationTitleFromUrl', () => {
  it.each([
    // As RAWG's links were seen: an American product id under `en-us`.
    [
      'https://store.playstation.com/en-us/product/UP1004-CUSA00419_00-GTAVDIGITALDOWNL',
      'CUSA00419_00',
    ],
    [
      'https://store.playstation.com/en-us/product/UP4497-CUSA00527_00-0000000000000002',
      'CUSA00527_00',
    ],
    // One link seen had a stray query after the id; a query is no part of the path.
    [
      'https://store.playstation.com/en-us/product/UP1004-CUSA03041_00-PARENTPRODUCT000?aaaa',
      'CUSA03041_00',
    ],
    // Not seen in a link of RAWG's, and the same kind of page: a PlayStation 5 title, a European
    // product, another locale, a locale with a script in it, plain http, a trailing slash.
    [
      'https://store.playstation.com/en-us/product/UP4497-PPSA04027_00-00000000000000N1',
      'PPSA04027_00',
    ],
    [
      'https://store.playstation.com/uk-ua/product/EP9000-CUSA07412_00-0000000GODOFWARN',
      'CUSA07412_00',
    ],
    [
      'https://store.playstation.com/zh-hans-hk/product/HP4497-CUSA16596_00-0000000000000004',
      'CUSA16596_00',
    ],
    [
      'http://store.playstation.com/en-us/product/UP2097-CUSA00080_00-WARFRAMEFINAL001/',
      'CUSA00080_00',
    ],
    [
      'HTTPS://STORE.PLAYSTATION.COM/en-US/product/UP2054-CUSA01664_00-PLAYDEADD11LIMBO#reviews',
      'CUSA01664_00',
    ],
  ])('reads the title of %s', (url, titleId) => {
    expect(playstationTitleFromUrl(url)).toBe(titleId)
  })

  const product = 'UP1004-CUSA00419_00-GTAVDIGITALDOWNL'
  const store = 'https://store.playstation.com'

  it.each([
    // The titles the current store does not carry at all: every one of RAWG's that is not PS4.
    [
      'a PlayStation 3 digital title',
      `${store}/en-us/product/UP2061-NPUB31077_00-PORTAL2DIGITAL01`,
    ],
    ['a PlayStation 3 disc title', `${store}/en-us/product/UP1003-BLUS30778_00-TESVSKYRIM000000`],
    ['a Vita title', `${store}/en-us/product/UP9012-PCSE00383_00-BORDERLANDS2PSV1`],
    [
      'a title family nobody has seen',
      `${store}/en-us/product/UP1004-CUSB00419_00-GTAVDIGITALDOWNL`,
    ],
    // A product id that is nearly one.
    ['a product id with no label', `${store}/en-us/product/UP1004-CUSA00419_00`],
    ['a label a character short', `${store}/en-us/product/UP1004-CUSA00419_00-GTAVDIGITALDOWN`],
    ['a label a character long', `${store}/en-us/product/UP1004-CUSA00419_00-GTAVDIGITALDOWNLX`],
    ['a label with a hyphen in it', `${store}/en-us/product/UP1004-CUSA00419_00-GTAVDIGITAL-OWNL`],
    ['a title number a digit short', `${store}/en-us/product/UP1004-CUSA0419_00-GTAVDIGITALDOWNL`],
    ['a title with no revision', `${store}/en-us/product/UP1004-CUSA00419-GTAVDIGITALDOWNL`],
    ['a publisher of three digits', `${store}/en-us/product/UP104-CUSA00419_00-GTAVDIGITALDOWNL`],
    ['a product id in lower case', `${store}/en-us/product/${product.toLowerCase()}`],
    [
      'a product id with an escape in it',
      `${store}/en-us/product/UP1004-CUSA00419%5F00-GTAVDIGITALDOWNL`,
    ],
    ['an SKU, which is a product id and more', `${store}/en-us/product/${product}-U001`],
    // A path that is nearly the one.
    ['a product page with no locale', `${store}/product/${product}`],
    ['a language without a country', `${store}/en/product/${product}`],
    ['two locales', `${store}/en-us/uk-ua/product/${product}`],
    ['a path that goes on after the id', `${store}/en-us/product/${product}/reviews`],
    ['an empty segment', `${store}/en-us//product/${product}`],
    ['a concept page', `${store}/en-us/concept/201930`],
    ['a concept page with a product id on it', `${store}/en-us/concept/${product}`],
    ['a category', `${store}/en-us/category/28c9c2b2-cecc-415c-9a08-482a605cb104`],
    ['the old store, with the id after a hash', `${store}/#!/en-us/games/cid=${product}`],
    ['the store’s front page', `${store}/en-us/`],
    // Another place altogether.
    ['the PlayStation site', `https://www.playstation.com/en-us/product/${product}`],
    ['a host that only starts like the store', `${store}.example.org/en-us/product/${product}`],
    [
      'the store in the path of another host',
      `https://example.org/store.playstation.com/en-us/product/${product}`,
    ],
    ['a port', `https://store.playstation.com:8443/en-us/product/${product}`],
    ['another scheme', `ftp://store.playstation.com/en-us/product/${product}`],
    ['no scheme', `store.playstation.com/en-us/product/${product}`],
    ['a protocol-relative link', `//store.playstation.com/en-us/product/${product}`],
    ['a Steam link', 'https://store.steampowered.com/app/271590/'],
    ['nothing', ''],
  ])('reads no title from %s', (_what, url) => {
    expect(playstationTitleFromUrl(url)).toBeNull()
  })

  it('reads none from a link that is not there', () => {
    expect(playstationTitleFromUrl(null)).toBeNull()
    expect(playstationTitleFromUrl(undefined)).toBeNull()
  })

  it('knows a title of the two consoles, and a product id, by their shape alone', () => {
    expect(isPlaystationTitleId('CUSA00419_00')).toBe(true)
    expect(isPlaystationTitleId('PPSA01721_00')).toBe(true)
    for (const other of ['NPUB31077_00', 'cusa00419_00', 'CUSA00419', 'CUSA00419_00 ', '', 7]) {
      expect(isPlaystationTitleId(other), String(other)).toBe(false)
    }
    // A product may be of any title family: it is a page's address, not what Sony is asked about.
    expect(isPlaystationProductId('EP1004-PPSA01721_00-GTAOSTANDALONE01')).toBe(true)
    expect(isPlaystationProductId('EP2319-CUSA26625_00-2010147637670638')).toBe(true)
    for (const other of [
      'EP1004-PPSA01721_00-GTAOSTANDALONE0',
      'EP1004-PPSA01721_00-GTAOSTANDALONE01/../x',
      'ep1004-ppsa01721_00-gtaostandalone01',
      'EP1004-PPSA01721_00-GTAOSTANDALONE01-E005',
      '',
      null,
    ]) {
      expect(isPlaystationProductId(other), String(other)).toBe(false)
    }
  })
})

const GTA = 'https://store.playstation.com/en-us/product/UP1004-CUSA00419_00-GTAVDIGITALDOWNL'
const PORTAL = 'https://store.playstation.com/en-us/product/UP2061-NPUB31077_00-PORTAL2DIGITAL01'

describe('storeRefsFromLinks and the PlayStation Store', () => {
  it('keeps the title of the PlayStation Store row, beside the other stores’', () => {
    expect(
      storeRefsFromLinks([
        { store_id: 1, url: 'https://store.steampowered.com/app/271590/' },
        { store_id: 5, url: 'https://www.gog.com/game/limbo' },
        { store_id: 3, url: GTA },
      ]),
    ).toEqual({ gog: 'limbo', playstation: { titleId: 'CUSA00419_00' } })
  })

  it('records a store the game is listed on with no title to read as asked, with nothing to read', () => {
    // No row at all, and a row that is a PlayStation 3 product: the same answer.
    expect(storeRefsFromLinks([], ['playstation-store'])).toEqual({ playstation: null })
    expect(storeRefsFromLinks([{ store_id: 3, url: PORTAL }], ['playstation-store'])).toEqual({
      playstation: null,
    })
    // And nothing at all when the game is not even listed there.
    expect(storeRefsFromLinks([{ store_id: 3, url: PORTAL }], ['steam'])).toEqual({})
  })

  it('takes the title only from the row of its own store, and the first row that has one', () => {
    // A PlayStation link filed under the Xbox store is not a reference.
    expect(storeRefsFromLinks([{ store_id: 2, url: GTA }])).toEqual({})
    expect(
      storeRefsFromLinks([
        { store_id: 3, url: PORTAL },
        { store_id: 3, url: null },
        { store_id: 3, url: GTA },
        {
          store_id: 3,
          url: 'https://store.playstation.com/en-us/product/UP1004-PPSA03420_00-GTAVDIGITALDOWNL',
        },
      ]),
    ).toEqual({ playstation: { titleId: 'CUSA00419_00' } })
  })

  it('carries what Sony said about the title into a record rewritten from RAWG’s links', () => {
    const asked = '2026-10-13T06:15:00.000Z'
    const previous: IndexedStoreRefs = {
      gog: 'an_old_slug',
      playstation: { titleId: 'CUSA00419_00', conceptId: 201_930, unpricedAt: asked },
    }

    // Everything RAWG knows is replaced; what was never RAWG's is kept.
    expect(storeRefsFromLinks([{ store_id: 3, url: GTA }], ['gog'], previous)).toEqual({
      gog: null,
      playstation: { titleId: 'CUSA00419_00', conceptId: 201_930, unpricedAt: asked },
    })
    // "Sony has none" is an answer about the title too.
    expect(
      storeRefsFromLinks([{ store_id: 3, url: GTA }], [], {
        playstation: { titleId: 'CUSA00419_00', conceptId: null },
      }),
    ).toEqual({ playstation: { titleId: 'CUSA00419_00', conceptId: null } })
  })

  it('drops what Sony said when the link names another title, or no title any more', () => {
    const previous: IndexedStoreRefs = {
      playstation: { titleId: 'CUSA00411_00', conceptId: 201_930 },
    }

    expect(storeRefsFromLinks([{ store_id: 3, url: GTA }], [], previous)).toEqual({
      playstation: { titleId: 'CUSA00419_00' },
    })
    expect(storeRefsFromLinks([], ['playstation-store'], previous)).toEqual({ playstation: null })
    // And nothing is taken from a record that is not what this job writes.
    expect(
      storeRefsFromLinks([{ store_id: 3, url: GTA }], [], {
        playstation: { titleId: 'CUSA00419_00', conceptId: '201930' },
      } as never),
    ).toEqual({ playstation: { titleId: 'CUSA00419_00' } })
  })
})

describe('usableStoreRefs and the PlayStation Store', () => {
  const corrupt = (record: unknown) => usableStoreRefs(record as never)

  it('passes on a title with what Sony said about it, in each of its three states', () => {
    const unpricedAt = '2026-10-13T06:15:00.000Z'
    for (const playstation of [
      { titleId: 'CUSA00419_00' },
      { titleId: 'CUSA00419_00', conceptId: null },
      { titleId: 'PPSA01721_00', conceptId: 201_930 },
      { titleId: 'PPSA01721_00', conceptId: 201_930, unpricedAt },
    ]) {
      expect(usableStoreRefs({ playstation })).toEqual({ playstation })
    }
    expect(usableStoreRefs({ playstation: null })).toEqual({})
  })

  it('has no reference for a title that is not one, and keeps the other stores', () => {
    expect(corrupt({ gog: 'limbo', playstation: { titleId: 'NPUB31077_00' } })).toEqual({
      gog: 'limbo',
    })
    expect(corrupt({ playstation: { titleId: 'CUSA00419_00/concepts?country=US' } })).toEqual({})
    expect(corrupt({ playstation: 'CUSA00419_00' })).toEqual({})
    expect(corrupt({ playstation: { conceptId: 201_930 } })).toEqual({})
  })

  it('reads a concept or a date that is not one as "not asked yet", and keeps the title', () => {
    const title = { playstation: { titleId: 'CUSA00419_00' } }
    for (const conceptId of ['201930', 0, -5, 1.5, Number.NaN, 2 ** 60, {}, true]) {
      expect(corrupt({ playstation: { titleId: 'CUSA00419_00', conceptId } })).toEqual(title)
    }
    // A date without a zone, a date in words, a number: none is one this job wrote.
    for (const unpricedAt of [
      '2026-10-13T06:15:00',
      '13.10.2026',
      'yesterday',
      1_792_000_000_000,
    ]) {
      expect(corrupt({ playstation: { titleId: 'CUSA00419_00', unpricedAt } })).toEqual(title)
    }
    // And nothing else a record holds there is passed on.
    expect(
      corrupt({ playstation: { titleId: 'CUSA00419_00', conceptId: 7, productId: 'x' } }),
    ).toEqual({ playstation: { titleId: 'CUSA00419_00', conceptId: 7 } })
  })
})

describe('needsStoreLookup and the PlayStation Store', () => {
  const game = (...stores: string[]) => ({ stores })

  it('asks about a game listed there whose record says nothing about it', () => {
    expect(needsStoreLookup(game('playstation-store'), undefined)).toBe(true)
    // What every record looked like the day the store joined the list: written for GOG and the
    // Xbox store, and silent about this one.
    expect(needsStoreLookup(game('gog', 'playstation-store'), { gog: 'limbo' })).toBe(true)
    expect(needsStoreLookup(game('steam', 'playstation-store'), {})).toBe(true)
  })

  it('does not ask again once the record has an answer, whichever it was', () => {
    const title = { titleId: 'CUSA00419_00' }
    expect(needsStoreLookup(game('playstation-store'), { playstation: title })).toBe(false)
    expect(needsStoreLookup(game('playstation-store'), { playstation: null })).toBe(false)
    expect(
      needsStoreLookup(game('playstation-store'), { playstation: { ...title, conceptId: null } }),
    ).toBe(false)
    // And never about a game RAWG does not list there.
    expect(needsStoreLookup(game('steam', 'nintendo'), undefined)).toBe(false)
  })
})

async function candidatesOf(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  harness.calls.length = 0
  return games
}

const asked = (harness: JobHarness) => harness.storeCalls().map((call) => call.path)
const HOLLOW = { gog: 'hollow_cradle', playstation: { titleId: JOB_PLAYSTATION_TITLES[101] } }
const AMBER = { playstation: { titleId: JOB_PLAYSTATION_TITLES[106] } }
const MERIDIAN = { playstation: { titleId: JOB_PLAYSTATION_TITLES[108] } }

describe('the PlayStation title in the job’s two lookups', () => {
  it('comes with the app id of a Steam game, from the very same answer', async () => {
    const harness = createJobHarness({ playstation: true })
    const games = await candidatesOf(harness)

    await resolveAppIds(harness.deps, games)

    // Seven Steam games, seven lookups, as on any first night: the three of them RAWG lists on
    // the PlayStation Store cost nothing more.
    expect(asked(harness)).toHaveLength(7)
    const refs = await harness.writer.getStoreRefs(games.map((game) => game.id))
    expect(refs.get(106)).toEqual(AMBER)
    expect(refs.get(108)).toEqual(MERIDIAN)
    // Beside the GOG page the same answer named.
    expect(refs.get(101)).toEqual(HOLLOW)
  })

  it('is swept for a game that is not on Steam, and asked about once', async () => {
    const harness = createJobHarness({ playstation: true })
    const games = await candidatesOf(harness)
    await resolveAppIds(harness.deps, games)
    harness.calls.length = 0

    const result = await sweepStoreRefs(harness.deps, games)

    // What the app ids left: 103, listed there and on nothing else, and 109 on the Xbox store.
    expect(asked(harness)).toEqual(['games/paper-harbour/stores', 'games/lost-canton/stores'])
    // Listed, asked, and its link is a PlayStation 3 product: no reference, and that is an answer.
    expect(result.refs.get(103)).toEqual({ playstation: null })
    expect(countStoreRefs(games, result.refs)).toEqual({
      listed: 5,
      asked: 5,
      gog: 1,
      microsoft: 1,
      playstation: 3,
    })

    const nextNight = createJobHarness({ writer: harness.writer, playstation: true })
    const again = await sweepStoreRefs(nextNight.deps, await candidatesOf(nextNight))
    expect(nextNight.calls).toHaveLength(0)
    expect(again).toMatchObject({ attempted: 0, remaining: 0 })
  })

  it('sweeps the games that were asked about before the store was read, once each', async () => {
    // The mapping as the build before this one left it: every game asked about GOG and the Xbox
    // store, and not a word about the PlayStation Store.
    const before = createJobHarness()
    const old = await candidatesOf(before)
    await resolveAppIds(before.deps, old)
    await sweepStoreRefs(before.deps, old)
    expect((await before.writer.getStoreRefs([101, 103, 106, 108, 109])).size).toBe(2)

    const harness = createJobHarness({ writer: before.writer, playstation: true })
    const games = await candidatesOf(harness)
    // The app ids are all known, so that stage asks nothing.
    await resolveAppIds(harness.deps, games)
    expect(harness.calls).toHaveLength(0)

    const result = await sweepStoreRefs(harness.deps, games)

    // The four games RAWG lists on the PlayStation Store, and no other: one request each. Game
    // 101 had been asked about before, for GOG; its record said nothing of this store.
    expect(asked(harness)).toEqual([
      'games/hollow-cradle/stores',
      'games/paper-harbour/stores',
      'games/amber-trail/stores',
      'games/silent-meridian/stores',
    ])
    expect(result).toMatchObject({ attempted: 4, failures: 0, remaining: 0, stopped: null })
    expect(result.refs.get(106)).toEqual(AMBER)
    expect(result.refs.get(101)).toEqual(HOLLOW)
    expect(result.refs.get(109)).toEqual({
      microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' },
    })
  })

  it('keeps what Sony said when the sweep rewrites a game’s record', async () => {
    const harness = createJobHarness({ playstation: true })
    const games = await candidatesOf(harness)
    // Game 106 as a run left it when RAWG did not yet list it on GOG: mapped by Sony, and with
    // nothing said about GOG.
    const known = { playstation: { titleId: JOB_PLAYSTATION_TITLES[106], conceptId: 10_106 } }
    await harness.writer.setStoreRefs([[106, known]])
    const onGog = games.map((game) =>
      game.id === 106 ? { ...game, stores: [...game.stores, 'gog'] } : game,
    )

    const result = await sweepStoreRefs(harness.deps, onGog)

    expect(asked(harness)).toContain('games/amber-trail/stores')
    expect(result.refs.get(106)).toEqual({ gog: null, ...known })
    expect((await harness.writer.getStoreRefs([106])).get(106)).toEqual({ gog: null, ...known })
  })

  it('keeps what Sony said when the app-id stage rewrites a game’s record', async () => {
    const harness = createJobHarness({ playstation: true })
    const games = await candidatesOf(harness)
    // Game 108 had a record before it had an app id: the sweep wrote it, and Sony mapped it,
    // while RAWG did not list the game on Steam.
    const known = { playstation: { titleId: JOB_PLAYSTATION_TITLES[108], conceptId: 10_108 } }
    await harness.writer.setStoreRefs([[108, known]])

    await resolveAppIds(harness.deps, games)

    expect(asked(harness)).toContain('games/silent-meridian/stores')
    expect((await harness.writer.getStoreRefs([108])).get(108)).toEqual(known)
  })
})
