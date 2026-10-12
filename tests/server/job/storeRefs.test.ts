import { describe, expect, it, vi } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import {
  countStoreRefs,
  gogSlugFromUrl,
  listedOfferStores,
  microsoftProductFromUrl,
  needsStoreLookup,
  STORE_REF_CURSOR,
  STORE_REF_SWEEP_BUDGET_MS,
  STORE_REF_SWEEP_PER_RUN,
  storeLinksOf,
  storeRefsFromLinks,
  sweepStoreRefs,
  usableStoreRefs,
} from '../../../scripts/index/storeRefs'
import type { IndexedGame, IndexedStoreRefs } from '../../../server/index/document'
import { JOB_PAGE_COUNT } from '../../fixtures/index/jobCatalog'
import { JOB_MICROSOFT_ID } from '../../fixtures/index/jobStores'
import { createJobHarness, type JobHarness } from './harness'

/**
 * Where a game's GOG page and Microsoft product come from: RAWG's own links, read by their shape.
 * The shapes below are the ones RAWG's links were seen in on 2026-10-12 (the design's "Verified"
 * section lists them), and each near-miss is a link that looks like one and is not.
 */

describe('gogSlugFromUrl', () => {
  it.each([
    ['https://www.gog.com/game/the_witcher_3_wild_hunt', 'the_witcher_3_wild_hunt'],
    ['http://www.gog.com/game/life_is_strange_complete_season', 'life_is_strange_complete_season'],
    ['https://www.gog.com/fr/game/doom_2016', 'doom_2016'],
    ['https://www.gog.com/en/game/middleearth_shadow_of_mordor', 'middleearth_shadow_of_mordor'],
    ['http://www.gog.com/game/walking_dead_season_1_the', 'walking_dead_season_1_the'],
    // Not seen, and the same page: no `www`, a locale with a region, a trailing slash, a query.
    ['https://gog.com/game/limbo', 'limbo'],
    ['https://www.gog.com/en-US/game/limbo', 'limbo'],
    ['https://www.gog.com/game/limbo/', 'limbo'],
    ['https://www.gog.com/game/limbo?pp=2863d7ae#reviews', 'limbo'],
    ['HTTPS://WWW.GOG.COM/game/limbo', 'limbo'],
  ])('reads the slug of %s', (url, slug) => {
    expect(gogSlugFromUrl(url)).toBe(slug)
  })

  it.each([
    ['a catalog page', 'https://www.gog.com/games/limbo'],
    ['a search', 'https://www.gog.com/en/games?query=limbo'],
    ['a game path with no slug', 'https://www.gog.com/game/'],
    ['a locale and no slug', 'https://www.gog.com/en/game/'],
    ['a path that goes on after the slug', 'https://www.gog.com/game/limbo/extras'],
    ['two locales', 'https://www.gog.com/en/fr/game/limbo'],
    ['a forum thread', 'https://www.gog.com/forum/limbo/a_thread_about_it'],
    ['a film', 'https://www.gog.com/movie/limbo'],
    ['a slug in capitals', 'https://www.gog.com/game/Limbo'],
    ['a slug with a hyphen', 'https://www.gog.com/game/limbo-2'],
    ['a slug with an escape in it', 'https://www.gog.com/game/limbo%5Fone'],
    ['an empty segment', 'https://www.gog.com//game/limbo'],
    ['another host of GOG', 'https://store.gog.com/game/limbo'],
    ['a host that only starts like GOG', 'https://www.gog.com.example.org/game/limbo'],
    ['GOG in the path of another host', 'https://example.org/www.gog.com/game/limbo'],
    ['a port', 'https://www.gog.com:8443/game/limbo'],
    ['another scheme', 'ftp://www.gog.com/game/limbo'],
    ['a script', 'javascript:alert(1)//www.gog.com/game/limbo'],
    ['no scheme', 'www.gog.com/game/limbo'],
    ['a protocol-relative link', '//www.gog.com/game/limbo'],
    ['a Steam link', 'https://store.steampowered.com/app/48000/LIMBO/'],
    ['nothing', ''],
  ])('reads no slug from %s', (_what, url) => {
    expect(gogSlugFromUrl(url)).toBeNull()
  })

  it('reads none from a link that is not there', () => {
    expect(gogSlugFromUrl(null)).toBeNull()
    expect(gogSlugFromUrl(undefined)).toBeNull()
  })
})

describe('microsoftProductFromUrl', () => {
  it.each([
    [
      'https://www.microsoft.com/en-us/p/the-witcher-3-wild-hunt/br765873cqjd',
      'BR765873CQJD',
      'the-witcher-3-wild-hunt',
    ],
    [
      'https://www.microsoft.com/en-us/store/p/grand-theft-auto-v/bpj686w6s0nh?cid=msft_web_chart',
      'BPJ686W6S0NH',
      'grand-theft-auto-v',
    ],
    [
      'https://www.microsoft.com/en-us/p/cyberpunk-2077/bx3m8l83bbrw?activetab=pivot:overviewtab',
      'BX3M8L83BBRW',
      'cyberpunk-2077',
    ],
    ['https://www.microsoft.com/en-us/store/r/starfield/9ncjsxwztp88', '9NCJSXWZTP88', 'starfield'],
    [
      'https://www.microsoft.com/en-us/p/microsoft-flight-simulator-standard---preorder/9NXN8GF8N9HT?source=lp&activetab=pivot:overviewtab',
      '9NXN8GF8N9HT',
      'microsoft-flight-simulator-standard---preorder',
    ],
    // The shape the design names for xbox.com; no link seen had it.
    [
      'https://www.xbox.com/en-US/games/store/forza-horizon-5-standard-edition/9nkx70bbcdrn',
      '9NKX70BBCDRN',
      'forza-horizon-5-standard-edition',
    ],
    // Not seen, and the same page: no locale, no `www`, a trailing slash, a name in capitals.
    ['https://www.microsoft.com/p/limbo/btqmhk78zpf9', 'BTQMHK78ZPF9', 'limbo'],
    ['https://microsoft.com/uk-ua/p/limbo/btqmhk78zpf9', 'BTQMHK78ZPF9', 'limbo'],
    ['https://www.xbox.com/games/store/limbo/btqmhk78zpf9/', 'BTQMHK78ZPF9', 'limbo'],
    ['https://www.microsoft.com/en-us/p/LIMBO/BTQMHK78ZPF9', 'BTQMHK78ZPF9', 'limbo'],
  ])('reads the product of %s', (url, id, name) => {
    expect(microsoftProductFromUrl(url)).toEqual({ id, name })
  })

  it.each([
    ['an id of eleven characters', 'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf'],
    ['an id of thirteen characters', 'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf91'],
    ['an id with a hyphen in it', 'https://www.microsoft.com/en-us/p/limbo/btqmhk-8zpf9'],
    ['an id and no name', 'https://www.microsoft.com/en-us/p/btqmhk78zpf9'],
    ['a name and no id', 'https://www.microsoft.com/en-us/p/limbo'],
    [
      'a path that goes on after the id',
      'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf9/reviews',
    ],
    ['an edition after the id', 'https://www.xbox.com/en-US/games/store/limbo/btqmhk78zpf9/0010'],
    ['an empty name', 'https://www.microsoft.com/en-us/p//btqmhk78zpf9'],
    ['a name with an underscore', 'https://www.microsoft.com/en-us/p/lim_bo/btqmhk78zpf9'],
    ['an app page', 'https://www.microsoft.com/en-us/store/apps/limbo/btqmhk78zpf9'],
    ['a collection', 'https://www.microsoft.com/en-us/store/b/xboxgames'],
    [
      'the xbox.com path on microsoft.com',
      'https://www.microsoft.com/en-us/games/store/limbo/btqmhk78zpf9',
    ],
    ['the microsoft.com path on xbox.com', 'https://www.xbox.com/en-us/p/limbo/btqmhk78zpf9'],
    ['an Xbox game page that is not a store page', 'https://www.xbox.com/en-US/games/limbo'],
    ['the apps site', 'https://apps.microsoft.com/detail/9nblggh4r315'],
    [
      'the Xbox 360 marketplace',
      'https://marketplace.xbox.com/en-US/Product/Portal-2/66acd000-77fe-1000-9115-d802454107d8',
    ],
    [
      'a host that only starts like Microsoft',
      'https://www.microsoft.com.example.org/en-us/p/limbo/btqmhk78zpf9',
    ],
    ['a port', 'https://www.microsoft.com:8443/en-us/p/limbo/btqmhk78zpf9'],
    ['another scheme', 'ftp://www.microsoft.com/en-us/p/limbo/btqmhk78zpf9'],
    ['no scheme', 'www.microsoft.com/en-us/p/limbo/btqmhk78zpf9'],
    ['a GOG link', 'https://www.gog.com/game/limbo'],
    ['nothing', ''],
  ])('reads no product from %s', (_what, url) => {
    expect(microsoftProductFromUrl(url)).toBeNull()
  })

  it('reads none from a link that is not there', () => {
    expect(microsoftProductFromUrl(null)).toBeNull()
    expect(microsoftProductFromUrl(undefined)).toBeNull()
  })
})

describe('storeRefsFromLinks', () => {
  it('keeps the GOG slug and the Microsoft product of a game that has both', () => {
    expect(
      storeRefsFromLinks([
        { store_id: 1, url: 'https://store.steampowered.com/app/1091500/' },
        { store_id: 5, url: 'http://www.gog.com/game/cyberpunk_2077' },
        { store_id: 2, url: 'https://www.microsoft.com/en-us/p/cyberpunk-2077/bx3m8l83bbrw' },
        { store_id: 3, url: 'https://store.playstation.com/en-us/product/UP4497-CUSA00572_00' },
      ]),
    ).toEqual({ gog: 'cyberpunk_2077', microsoft: { id: 'BX3M8L83BBRW', name: 'cyberpunk-2077' } })
  })

  it('says nothing about a store the game is neither linked to nor listed on', () => {
    const steamOnly = [{ store_id: 1, url: 'https://store.steampowered.com/app/620/' }]

    expect(storeRefsFromLinks(steamOnly)).toEqual({})
    expect(storeRefsFromLinks(steamOnly, ['steam', 'epic-games'])).toEqual({})
    expect(storeRefsFromLinks([])).toEqual({})
    expect(storeRefsFromLinks(null)).toEqual({})
  })

  it('records a store the game is listed on and has no link for as asked, with nothing to read', () => {
    const steamOnly = [{ store_id: 1, url: 'https://store.steampowered.com/app/620/' }]

    expect(storeRefsFromLinks(steamOnly, ['steam', 'gog'])).toEqual({ gog: null })
    expect(storeRefsFromLinks(steamOnly, ['xbox-store'])).toEqual({ microsoft: null })
    expect(storeRefsFromLinks([], ['gog', 'xbox-store'])).toEqual({ gog: null, microsoft: null })
    // A link of the store that is not a product page is no link to read either.
    expect(
      storeRefsFromLinks(
        [{ store_id: 5, url: 'https://www.gog.com/en/games?query=limbo' }],
        ['gog'],
      ),
    ).toEqual({ gog: null })
  })

  it('keeps a reference a link gives, whether or not the list names the store', () => {
    const links = [
      { store_id: 5, url: 'https://www.gog.com/game/limbo' },
      { store_id: 2, url: 'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf9' },
    ]
    const both = { gog: 'limbo', microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo' } }

    expect(storeRefsFromLinks(links, [])).toEqual(both)
    expect(storeRefsFromLinks(links, ['gog'])).toEqual(both)
    expect(storeRefsFromLinks(links, ['gog', 'xbox-store'])).toEqual(both)
  })

  it('takes a link only from the row of its own store', () => {
    expect(
      storeRefsFromLinks([
        // A GOG page filed under Steam, a Microsoft product filed under the Xbox 360 store.
        { store_id: 1, url: 'https://www.gog.com/game/limbo' },
        { store_id: 7, url: 'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf9' },
      ]),
    ).toEqual({})
  })

  it('skips a row of the store whose link is not a product, and takes the first that is', () => {
    expect(
      storeRefsFromLinks([
        { store_id: 5, url: 'https://www.gog.com/en/games?query=limbo' },
        { store_id: 5, url: 'https://www.gog.com/game/limbo' },
        { store_id: 5, url: 'https://www.gog.com/game/limbo_special_edition' },
        { store_id: 2, url: null },
        { store_id: 2, url: 'https://www.microsoft.com/en-us/p/limbo/btqmhk78zpf9' },
      ]),
    ).toEqual({ gog: 'limbo', microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo' } })
  })
})

describe('storeLinksOf', () => {
  it('reads the links of an answer that has a list of them', () => {
    expect(storeLinksOf({ count: 0, results: [] })).toEqual([])
    expect(storeLinksOf({ results: [{ store_id: 5, url: 'x' }] })).toEqual([
      { store_id: 5, url: 'x' },
    ])
  })

  it('reads nothing from an answer that is not one, rather than "no links"', () => {
    // RAWG has been seen sending an empty body under a 200.
    for (const body of [null, undefined, '', [], {}, { results: null }, { results: 'none' }]) {
      expect(storeLinksOf(body)).toBeNull()
    }
  })
})

describe('usableStoreRefs', () => {
  it('passes on what this job would have written', () => {
    const record = { gog: 'limbo', microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo' } }
    expect(usableStoreRefs(record)).toEqual(record)
    expect(usableStoreRefs({})).toEqual({})
    expect(usableStoreRefs(undefined)).toEqual({})
  })

  it('has no reference for a store recorded as asked with nothing to read', () => {
    expect(usableStoreRefs({ gog: null, microsoft: null })).toEqual({})
    expect(usableStoreRefs({ gog: 'limbo', microsoft: null })).toEqual({ gog: 'limbo' })
  })

  it('drops a field no link could have produced, and keeps the other', () => {
    const corrupt = (record: unknown) => usableStoreRefs(record as never)
    expect(
      corrupt({ gog: 'limbo&countryCode=US', microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo' } }),
    ).toEqual({
      microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo' },
    })
    expect(corrupt({ gog: 'limbo', microsoft: { id: 'btqmhk78zpf9', name: 'limbo' } })).toEqual({
      gog: 'limbo',
    })
    expect(corrupt({ gog: 42, microsoft: 'BTQMHK78ZPF9' })).toEqual({})
    expect(corrupt({ microsoft: { id: 'BTQMHK78ZPF9', name: 'limbo/../x' } })).toEqual({})
  })
})

describe('needsStoreLookup', () => {
  const game = (...stores: string[]) => ({ stores })
  const limbo = { id: 'BTQMHK78ZPF9', name: 'limbo' }

  it('is the documents’ own list of stores that says which games are asked about', () => {
    // The slugs the site knows the two stores by, which is what a document's `stores` holds.
    expect(listedOfferStores(game('steam', 'gog', 'xbox-store', 'nintendo'))).toEqual([
      'gog',
      'xbox-store',
    ])
    expect(listedOfferStores(game('steam', 'epic-games', 'playstation-store'))).toEqual([])
    expect(listedOfferStores(game())).toEqual([])
  })

  it('never asks about a game on neither store, whatever its record', () => {
    expect(needsStoreLookup(game('steam', 'nintendo'), undefined)).toBe(false)
    expect(needsStoreLookup(game(), undefined)).toBe(false)
    expect(needsStoreLookup(game('steam'), {})).toBe(false)
  })

  it('asks about a listed game with no record, and not again once the store has an answer', () => {
    expect(needsStoreLookup(game('gog'), undefined)).toBe(true)
    expect(needsStoreLookup(game('gog'), {})).toBe(true)
    expect(needsStoreLookup(game('gog'), { gog: 'limbo' })).toBe(false)
    // "No link to read" is an answer.
    expect(needsStoreLookup(game('gog'), { gog: null })).toBe(false)
    expect(needsStoreLookup(game('xbox-store'), { microsoft: limbo })).toBe(false)
    expect(needsStoreLookup(game('xbox-store'), { microsoft: null })).toBe(false)
  })

  it('asks again when the game gains a store its record says nothing about', () => {
    expect(needsStoreLookup(game('gog', 'xbox-store'), { gog: 'limbo' })).toBe(true)
    expect(needsStoreLookup(game('gog', 'xbox-store'), { microsoft: null })).toBe(true)
    expect(needsStoreLookup(game('gog', 'xbox-store'), { gog: null, microsoft: limbo })).toBe(false)
    // A reference a link gave before the list named the store counts as its answer.
    expect(needsStoreLookup(game('xbox-store'), { gog: 'limbo', microsoft: limbo })).toBe(false)
  })
})

async function candidatesOf(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  harness.calls.length = 0
  return games
}

/**
 * The same games with RAWG listing every one of them on GOG, so that all nine wait to be asked.
 * Their links are the catalog's own: one GOG page (101), one Microsoft product (109).
 */
const allOnGog = (games: IndexedGame[]): IndexedGame[] =>
  games.map((game) => ({ ...game, stores: [...new Set([...game.stores, 'gog'])] }))

const asked = (harness: JobHarness) => harness.storeCalls().map((call) => call.path)
const storesOf = (...slugs: string[]) => slugs.map((slug) => `games/${slug}/stores`)

/** The nine games of the job catalog in the order of their RAWG ids, which is the sweep's. */
const SLUGS = [
  'hollow-cradle',
  'neon-district',
  'paper-harbour',
  'frost-relay',
  'quiet-orbit',
  'amber-trail',
  'deep-signal',
  'silent-meridian',
  'lost-canton',
]

const LOST_CANTON = { microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' } }

describe('sweepStoreRefs', () => {
  it('asks RAWG about the games it lists on GOG or on the Xbox store, and about no other', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    const result = await sweepStoreRefs(harness.deps, games)

    // Of nine games, two: 101 is on GOG and 109 on the Xbox store.
    expect(asked(harness)).toEqual(storesOf('hollow-cradle', 'lost-canton'))
    expect(result).toMatchObject({ attempted: 2, failures: 0, remaining: 0, stopped: null })
    expect(result.refs.get(101)).toEqual({ gog: 'hollow_cradle' })
    expect(result.refs.get(109)).toEqual(LOST_CANTON)
    // A game on neither store was not asked, and nothing is remembered about it.
    expect(result.refs.size).toBe(2)
    expect(await harness.writer.getStoreRefs(games.map((game) => game.id))).toEqual(
      new Map<number, IndexedStoreRefs>([
        [101, { gog: 'hollow_cradle' }],
        [109, LOST_CANTON],
      ]),
    )
    expect(countStoreRefs(games, result.refs)).toEqual({
      listed: 2,
      asked: 2,
      gog: 1,
      microsoft: 1,
    })
  })

  it('remembers a listed store it found no link for, and does not ask about it again', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))

    const result = await sweepStoreRefs(harness.deps, games)

    expect(asked(harness)).toEqual(storesOf(...SLUGS))
    expect(result).toMatchObject({ attempted: 9, failures: 0, remaining: 0 })
    expect(result.refs.get(101)).toEqual({ gog: 'hollow_cradle' })
    // Listed on GOG, and RAWG has no GOG link for it: an answer, kept as one.
    expect(result.refs.get(102)).toEqual({ gog: null })
    expect(result.refs.get(103)).toEqual({ gog: null })
    expect(result.refs.get(109)).toEqual({ gog: null, ...LOST_CANTON })
    expect(countStoreRefs(games, result.refs)).toEqual({
      listed: 9,
      asked: 9,
      gog: 1,
      microsoft: 1,
    })

    const nextNight = createJobHarness({ writer: harness.writer })
    const getCursor = vi.spyOn(nextNight.writer, 'getCursor')
    const again = await sweepStoreRefs(nextNight.deps, games)

    expect(nextNight.calls).toHaveLength(0)
    // Nothing to sweep, so the cursor is not read: there is no place to start from.
    expect(getCursor).not.toHaveBeenCalled()
    expect(again).toMatchObject({ attempted: 0, failures: 0, remaining: 0 })
    expect(again.refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })

  it('asks about a game when it gains one of the two stores, and not before', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    await sweepStoreRefs(harness.deps, games)
    const byId = (list: IndexedGame[], id: number) => list.find((game) => game.id === id)!

    // A later night: RAWG now lists 102 on GOG, which it was on neither store before, and 101,
    // already asked about GOG, on the Xbox store as well.
    const later = games.map((game) => ({ ...game, stores: [...game.stores] }))
    byId(later, 102).stores.push('gog')
    byId(later, 101).stores.push('xbox-store')
    const nextNight = createJobHarness({ writer: harness.writer })
    nextNight.answerNextWith((call) => call.path === 'games/neon-district/stores', {
      results: [{ store_id: 5, url: 'https://www.gog.com/game/neon_district' }],
    })

    const result = await sweepStoreRefs(nextNight.deps, later)

    expect(asked(nextNight)).toEqual(storesOf('hollow-cradle', 'neon-district'))
    expect(result.refs.get(102)).toEqual({ gog: 'neon_district' })
    // The whole of what RAWG links now: the GOG page it had, and no Microsoft product to read.
    expect(result.refs.get(101)).toEqual({ gog: 'hollow_cradle', microsoft: null })
    expect(result).toMatchObject({ attempted: 2, remaining: 0 })

    const after = createJobHarness({ writer: harness.writer })
    await sweepStoreRefs(after.deps, later)
    expect(after.calls).toHaveLength(0)
  })

  it('clears a cursor it finds nobody waiting behind, on a night with nothing to do', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    // A capped night leaves five games waiting and the cursor at the fourth.
    await sweepStoreRefs(harness.deps, games, { limit: 4 })
    expect(await harness.writer.getCursor(STORE_REF_CURSOR)).toBe('104')

    // Before the next full run the five are settled another way — here, as when the app-id
    // stage writes their records — so the sweep finds nothing to ask.
    await harness.writer.setStoreRefs(
      games
        .filter((game) => game.id > 104)
        .map((game) => [game.id, { gog: null, microsoft: null }]),
    )
    const nextNight = createJobHarness({ writer: harness.writer })
    const result = await sweepStoreRefs(nextNight.deps, games)

    expect(nextNight.calls).toHaveLength(0)
    expect(result).toMatchObject({ attempted: 0, remaining: 0, stopped: null })
    // The key nobody will read again is gone, not left for good.
    expect(await nextNight.writer.getCursor(STORE_REF_CURSOR)).toBeNull()
  })

  it('stops for the night once it has used its twenty minutes, and keeps what it read', async () => {
    expect(STORE_REF_SWEEP_BUDGET_MS).toBe(20 * 60_000)
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    // RAWG answers every lookup, and takes six minutes over each: nothing fails, nothing is fast.
    const slow = { ...harness.deps }
    slow.rawg = async (path, params) => {
      harness.clock.advance(6 * 60_000)
      return harness.deps.rawg(path, params)
    }

    const result = await sweepStoreRefs(slow, games)

    // Asked at 0, 6, 12 and 18 minutes; at 24 the fifth is not begun.
    expect(asked(harness)).toEqual(storesOf(...SLUGS.slice(0, 4)))
    expect(result).toMatchObject({ attempted: 4, failures: 0, remaining: 5, stopped: 'time' })
    expect(result.refs.size).toBe(4)
    expect(await harness.writer.getStoreRefs([101, 104, 105])).toEqual(
      new Map<number, IndexedStoreRefs>([
        [101, { gog: 'hollow_cradle' }],
        [104, { gog: null }],
      ]),
    )
    expect(await harness.writer.getCursor(STORE_REF_CURSOR)).toBe('104')
    expect(harness.logs.at(-1)).toBe(
      'store references: 4 games read this run, 0 failed, 5 left for the next full run — stopped early, the sweep had used its twenty minutes',
    )

    // The next full run goes on from there, with a budget of its own.
    const nextNight = createJobHarness({ writer: harness.writer })
    const rest = await sweepStoreRefs(nextNight.deps, games)
    expect(asked(nextNight)).toEqual(storesOf(...SLUGS.slice(4)))
    expect(rest).toMatchObject({ attempted: 5, remaining: 0, stopped: null })
  })

  it('does not stop a sweep that is merely long: the budget is time, not lookups', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    const steady = { ...harness.deps }
    // Two minutes a lookup: the ninth begins at sixteen minutes, inside the twenty.
    steady.rawg = async (path, params) => {
      harness.clock.advance(2 * 60_000)
      return harness.deps.rawg(path, params)
    }

    expect(await sweepStoreRefs(steady, games)).toMatchObject({
      attempted: 9,
      remaining: 0,
      stopped: null,
    })
  })

  it('spends twelve hundred lookups a run unless told otherwise', () => {
    expect(STORE_REF_SWEEP_PER_RUN).toBe(1200)
  })

  it('stops at the cap and goes on from the cursor on the next run', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))

    const first = await sweepStoreRefs(harness.deps, games, { limit: 4 })

    expect(asked(harness)).toEqual(storesOf(...SLUGS.slice(0, 4)))
    expect(first).toMatchObject({ attempted: 4, failures: 0, remaining: 5 })
    // The id of the last game asked about.
    expect(await harness.writer.getCursor(STORE_REF_CURSOR)).toBe('104')
    expect(countStoreRefs(games, first.refs)).toMatchObject({ listed: 9, asked: 4 })

    const second = createJobHarness({ writer: harness.writer })
    expect(await sweepStoreRefs(second.deps, games, { limit: 4 })).toMatchObject({
      attempted: 4,
      remaining: 1,
    })
    expect(asked(second)).toEqual(storesOf(...SLUGS.slice(4, 8)))
    expect(await second.writer.getCursor(STORE_REF_CURSOR)).toBe('108')

    const third = createJobHarness({ writer: harness.writer })
    const last = await sweepStoreRefs(third.deps, games, { limit: 4 })
    expect(asked(third)).toEqual(storesOf('lost-canton'))
    expect(last).toMatchObject({ attempted: 1, remaining: 0 })
    expect(last.refs.size).toBe(9)
    // Every listed game has been asked about: the cursor is not kept for nobody to read.
    expect(await third.writer.getCursor(STORE_REF_CURSOR)).toBeNull()
  })

  it('writes the name of a game it could not read on one line, whatever RAWG calls it', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    // A slug is RAWG's text, and the log is a runner's standard output, where a line that begins
    // with `::` is a command to the runner.
    const index = games.findIndex((game) => game.slug === 'quiet-orbit')
    games[index] = { ...games[index]!, slug: 'quiet-orbit\n::add-mask::secret' }

    const result = await sweepStoreRefs(harness.deps, games)

    expect(result.failures).toBe(1)
    expect(harness.logs).toContain(
      'store references: quiet-orbit ::add-mask::secret could not be read, leaving it for a later run',
    )
    expect(harness.logs.some((line) => /[\r\n]/.test(line))).toBe(false)
  })

  it('writes no record for a lookup that failed and asks again on the next run', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    harness.failNext((call) => call.path === 'games/quiet-orbit/stores')

    const first = await sweepStoreRefs(harness.deps, games)

    expect(first).toMatchObject({ attempted: 9, failures: 1, remaining: 1, stopped: null })
    expect(first.refs.has(105)).toBe(false)
    // Not written as "no link to read": that would make one timeout permanent.
    expect(await harness.writer.getStoreRefs([105])).toEqual(new Map())
    expect(harness.logs).toContain(
      'store references: quiet-orbit could not be read, leaving it for a later run',
    )

    const nextNight = createJobHarness({ writer: harness.writer })
    const second = await sweepStoreRefs(nextNight.deps, games)

    expect(asked(nextNight)).toEqual(storesOf('quiet-orbit'))
    expect(second).toMatchObject({ attempted: 1, failures: 0, remaining: 0 })
    expect(second.refs.get(105)).toEqual({ gog: null })
  })

  it('does not remember an answer that is no list of links as "no link to read"', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    harness.answerNextWith((call) => call.path === 'games/hollow-cradle/stores', null)

    const result = await sweepStoreRefs(harness.deps, games)

    expect(result).toMatchObject({ failures: 1, remaining: 1 })
    expect(await harness.writer.getStoreRefs([101])).toEqual(new Map())
  })

  it('meets a game RAWG keeps failing on after the others, not first every night', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    const failing = (call: { path: string }) => call.path === 'games/hollow-cradle/stores'

    harness.failNext(failing)
    await sweepStoreRefs(harness.deps, games, { limit: 3 })
    expect(asked(harness)).toEqual(storesOf(...SLUGS.slice(0, 3)))

    // The failed game has the lowest id of all, and the next two runs still start after the
    // cursor: every other game gets its turn before the failed one gets a second.
    const second = createJobHarness({ writer: harness.writer })
    await sweepStoreRefs(second.deps, games, { limit: 3 })
    expect(asked(second)).toEqual(storesOf(...SLUGS.slice(3, 6)))

    const third = createJobHarness({ writer: harness.writer })
    await sweepStoreRefs(third.deps, games, { limit: 3 })
    expect(asked(third)).toEqual(storesOf(...SLUGS.slice(6, 9)))

    // Then round to the start, where the failed one is waiting.
    const fourth = createJobHarness({ writer: harness.writer })
    const last = await sweepStoreRefs(fourth.deps, games, { limit: 3 })
    expect(asked(fourth)).toEqual(storesOf('hollow-cradle'))
    expect(last).toMatchObject({ attempted: 1, failures: 0, remaining: 0 })
  })

  it('gives up for the night, without failing the run, when RAWG fails wholesale', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    for (const slug of SLUGS) harness.failNext((call) => call.path === `games/${slug}/stores`)

    const result = await sweepStoreRefs(harness.deps, games)

    // Five failures are shrugged off; the sixth, with nothing answered, ends the sweep.
    expect(result).toMatchObject({
      attempted: 6,
      failures: 6,
      remaining: 9,
      stopped: 'failures',
    })
    expect(result.refs.size).toBe(0)
    expect(harness.logs.at(-1)).toMatch(/9 left for the next full run — stopped early/)
  })

  it('carries on through scattered failures', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    for (const slug of ['hollow-cradle', 'frost-relay', 'amber-trail', 'silent-meridian']) {
      harness.failNext((call) => call.path === `games/${slug}/stores`)
    }

    const result = await sweepStoreRefs(harness.deps, games)

    expect(result).toMatchObject({ attempted: 9, failures: 4, remaining: 4, stopped: null })
  })

  it('writes in batches, moves the cursor with each and renews the lock', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    const setStoreRefs = vi.spyOn(harness.writer, 'setStoreRefs')
    const setCursor = vi.spyOn(harness.writer, 'setCursor')
    const renewLock = vi.spyOn(harness.writer, 'renewLock')

    await sweepStoreRefs(harness.deps, games, { batchSize: 4 })

    expect(setStoreRefs.mock.calls.map(([entries]) => [...entries].map(([id]) => id))).toEqual([
      [101, 102, 103, 104],
      [105, 106, 107, 108],
      [109],
    ])
    expect(setCursor.mock.calls).toEqual([
      [STORE_REF_CURSOR, '104'],
      [STORE_REF_CURSOR, '108'],
      [STORE_REF_CURSOR, '109'],
    ])
    expect(renewLock).toHaveBeenCalledTimes(3)
  })

  it('keeps what it had read when the stage dies between two batches', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    // The index takes the first batch and refuses every one after it: the stage fails, and that
    // is the index failing, not RAWG.
    const write = harness.writer.setStoreRefs.bind(harness.writer)
    let batches = 0
    const setStoreRefs = vi
      .spyOn(harness.writer, 'setStoreRefs')
      .mockImplementation(async (entries) => {
        batches += 1
        if (batches > 1) throw new Error('the store is unreachable')
        return write(entries)
      })

    await expect(sweepStoreRefs(harness.deps, games, { batchSize: 4 })).rejects.toThrow(
      'the store is unreachable',
    )

    setStoreRefs.mockRestore()
    const resumed = createJobHarness({ writer: harness.writer })
    await sweepStoreRefs(resumed.deps, games)
    // The first batch was saved; only the rest is asked for again.
    expect(asked(resumed)).toEqual(storesOf(...SLUGS.slice(4)))
  })
})

describe('resolveAppIds and the store references', () => {
  it('writes the references of a game it looks up, from the same response', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    await resolveAppIds(harness.deps, games)

    // Seven Steam candidates, seven requests — none of them made twice for the other stores.
    expect(harness.storeCalls()).toHaveLength(7)
    const refs = await harness.writer.getStoreRefs(games.map((game) => game.id))
    // One of the seven is on GOG. The other six are on neither store: nothing is written about
    // them, so that a game which gains a store later is still asked about it.
    expect(refs).toEqual(new Map([[101, { gog: 'hollow_cradle' }]]))
  })

  it('leaves the sweep only the listed games it never asks about', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    await resolveAppIds(harness.deps, games)
    harness.calls.length = 0

    const result = await sweepStoreRefs(harness.deps, games)

    // 109 is on the Xbox store and not on Steam: nobody had asked about it. 103, on no store at
    // all, is asked about by nobody.
    expect(asked(harness)).toEqual(storesOf('lost-canton'))
    expect(result.refs.get(109)).toEqual(LOST_CANTON)
    expect(result.refs.size).toBe(2)
  })

  it('records a listed store the response has no link for, and a link the list does not name', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    // 102's links name a Microsoft product though RAWG's list does not put it on the Xbox store.
    harness.answerNextWith((call) => call.path === 'games/neon-district/stores', {
      results: [
        { store_id: 1, url: 'https://store.steampowered.com/app/412000/' },
        { store_id: 2, url: 'https://www.microsoft.com/en-us/p/neon-district/9nneondistr1' },
      ],
    })

    await resolveAppIds(harness.deps, games)

    const refs = await harness.writer.getStoreRefs([102, 104])
    expect(refs.get(102)).toEqual({
      gog: null,
      microsoft: { id: '9NNEONDISTR1', name: 'neon-district' },
    })
    expect(refs.get(104)).toEqual({ gog: null })
  })

  it('writes no references for a lookup that failed, and none for a bad answer', async () => {
    const harness = createJobHarness()
    const games = allOnGog(await candidatesOf(harness))
    harness.failNext((call) => call.path === 'games/amber-trail/stores')
    // An answer without a list: the app id stage has always read it as "no Steam page".
    harness.answerNextWith((call) => call.path === 'games/deep-signal/stores', { count: 0 })

    await resolveAppIds(harness.deps, games)

    const refs = await harness.writer.getStoreRefs([106, 107])
    expect(refs.has(106)).toBe(false)
    expect(refs.has(107)).toBe(false)
    expect(await harness.writer.getAppIds([107])).toEqual(new Map([[107, '']]))

    // Both are on GOG, so the sweep asks about them — and about 103 and 109, which are not on
    // Steam and were never the app id stage's to ask about.
    harness.calls.length = 0
    await sweepStoreRefs(harness.deps, games)
    expect(asked(harness)).toEqual(
      storesOf('paper-harbour', 'amber-trail', 'deep-signal', 'lost-canton'),
    )
  })
})
