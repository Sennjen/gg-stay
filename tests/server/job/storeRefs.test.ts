import { describe, expect, it, vi } from 'vitest'
import { resolveAppIds } from '../../../scripts/index/appIds'
import { collectCandidates } from '../../../scripts/index/candidates'
import {
  countStoreRefs,
  gogSlugFromUrl,
  microsoftProductFromUrl,
  STORE_REF_CURSOR,
  STORE_REF_SWEEP_PER_RUN,
  storeLinksOf,
  storeRefsFromLinks,
  sweepStoreRefs,
  usableStoreRefs,
} from '../../../scripts/index/storeRefs'
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

  it('answers with an empty record for a game with neither, which is an answer', () => {
    expect(
      storeRefsFromLinks([{ store_id: 1, url: 'https://store.steampowered.com/app/620/' }]),
    ).toEqual({})
    expect(storeRefsFromLinks([])).toEqual({})
    expect(storeRefsFromLinks(null)).toEqual({})
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

async function candidatesOf(harness: JobHarness) {
  const { games } = await collectCandidates(harness.deps, { pages: JOB_PAGE_COUNT })
  harness.calls.length = 0
  return games
}

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

describe('sweepStoreRefs', () => {
  it('asks RAWG about every game with no record and keeps what the links say', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    const result = await sweepStoreRefs(harness.deps, games)

    expect(asked(harness)).toEqual(storesOf(...SLUGS))
    expect(result).toMatchObject({ attempted: 9, failures: 0, remaining: 0, stopped: false })
    expect(result.refs.get(101)).toEqual({ gog: 'hollow_cradle' })
    expect(result.refs.get(109)).toEqual({
      microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' },
    })
    // Asked, and neither store: an empty record, not a missing one.
    expect(result.refs.get(102)).toEqual({})
    expect(result.refs.get(103)).toEqual({})
    expect(result.refs.size).toBe(9)
    expect(await harness.writer.getStoreRefs([101, 103, 109, 999])).toEqual(
      new Map([
        [101, { gog: 'hollow_cradle' }],
        [103, {}],
        [109, { microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' } }],
      ]),
    )
    expect(countStoreRefs(games, result.refs)).toEqual({ asked: 9, gog: 1, microsoft: 1 })
  })

  it('asks about a game once in the life of the index, the ones with neither store included', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    await sweepStoreRefs(harness.deps, games)

    const nextNight = createJobHarness({ writer: harness.writer })
    const getCursor = vi.spyOn(nextNight.writer, 'getCursor')
    const result = await sweepStoreRefs(nextNight.deps, games)

    expect(nextNight.calls).toHaveLength(0)
    // Nothing to sweep, so not even the cursor is read.
    expect(getCursor).not.toHaveBeenCalled()
    expect(result).toMatchObject({ attempted: 0, failures: 0, remaining: 0 })
    expect(result.refs.get(101)).toEqual({ gog: 'hollow_cradle' })
  })

  it('spends twelve hundred lookups a run unless told otherwise', () => {
    expect(STORE_REF_SWEEP_PER_RUN).toBe(1200)
  })

  it('stops at the cap and goes on from the cursor on the next run', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    const first = await sweepStoreRefs(harness.deps, games, { limit: 4 })

    expect(asked(harness)).toEqual(storesOf(...SLUGS.slice(0, 4)))
    expect(first).toMatchObject({ attempted: 4, failures: 0, remaining: 5 })
    // The id of the last game asked about.
    expect(await harness.writer.getCursor(STORE_REF_CURSOR)).toBe('104')

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
    // Every game has been asked about: the cursor is not kept for nobody to read.
    expect(await third.writer.getCursor(STORE_REF_CURSOR)).toBeNull()
  })

  it('writes no record for a lookup that failed and asks again on the next run', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    harness.failNext((call) => call.path === 'games/quiet-orbit/stores')

    const first = await sweepStoreRefs(harness.deps, games)

    expect(first).toMatchObject({ attempted: 9, failures: 1, remaining: 1, stopped: false })
    expect(first.refs.has(105)).toBe(false)
    // Not written as "has neither store": that would make one timeout permanent.
    expect(await harness.writer.getStoreRefs([105])).toEqual(new Map())
    expect(harness.logs).toContain(
      'store references: quiet-orbit could not be read, leaving it for a later run',
    )

    const nextNight = createJobHarness({ writer: harness.writer })
    const second = await sweepStoreRefs(nextNight.deps, games)

    expect(asked(nextNight)).toEqual(storesOf('quiet-orbit'))
    expect(second).toMatchObject({ attempted: 1, failures: 0, remaining: 0 })
    expect(second.refs.get(105)).toEqual({})
  })

  it('does not remember an answer that is no list of links as "neither store"', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    harness.answerNextWith((call) => call.path === 'games/hollow-cradle/stores', null)

    const result = await sweepStoreRefs(harness.deps, games)

    expect(result).toMatchObject({ failures: 1, remaining: 1 })
    expect(await harness.writer.getStoreRefs([101])).toEqual(new Map())
  })

  it('meets a game RAWG keeps failing on after the others, not first every night', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
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
    const games = await candidatesOf(harness)
    for (const slug of SLUGS) harness.failNext((call) => call.path === `games/${slug}/stores`)

    const result = await sweepStoreRefs(harness.deps, games)

    // Five failures are shrugged off; the sixth, with nothing answered, ends the sweep.
    expect(result).toMatchObject({ attempted: 6, failures: 6, remaining: 9, stopped: true })
    expect(result.refs.size).toBe(0)
    expect(harness.logs.at(-1)).toMatch(/9 left for the next full run — stopped early/)
  })

  it('carries on through scattered failures', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    for (const slug of ['hollow-cradle', 'frost-relay', 'amber-trail', 'silent-meridian']) {
      harness.failNext((call) => call.path === `games/${slug}/stores`)
    }

    const result = await sweepStoreRefs(harness.deps, games)

    expect(result).toMatchObject({ attempted: 9, failures: 4, remaining: 4, stopped: false })
  })

  it('writes in batches, moves the cursor with each and renews the lock', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
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
    const games = await candidatesOf(harness)
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
  it('writes the references of every game it looks up, from the same response', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)

    await resolveAppIds(harness.deps, games)

    // Seven Steam candidates, seven requests — none of them made twice for the other stores.
    expect(harness.storeCalls()).toHaveLength(7)
    const refs = await harness.writer.getStoreRefs(games.map((game) => game.id))
    expect([...refs.keys()].sort()).toEqual([101, 102, 104, 105, 106, 107, 108])
    expect(refs.get(101)).toEqual({ gog: 'hollow_cradle' })
    expect(refs.get(104)).toEqual({})
  })

  it('leaves the sweep only the games it never asks about', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    await resolveAppIds(harness.deps, games)
    harness.calls.length = 0

    const result = await sweepStoreRefs(harness.deps, games)

    // 103 has no store at all and 109 is not on Steam: nobody had asked about them.
    expect(asked(harness)).toEqual(storesOf('paper-harbour', 'lost-canton'))
    expect(result.refs.get(109)).toEqual({
      microsoft: { id: JOB_MICROSOFT_ID, name: 'lost-canton' },
    })
    expect(result.refs.size).toBe(9)
  })

  it('writes no references for a lookup that failed, and none of "neither" for a bad answer', async () => {
    const harness = createJobHarness()
    const games = await candidatesOf(harness)
    harness.failNext((call) => call.path === 'games/amber-trail/stores')
    // An answer without a list: the app id stage has always read it as "no Steam page".
    harness.answerNextWith((call) => call.path === 'games/deep-signal/stores', { count: 0 })

    await resolveAppIds(harness.deps, games)

    const refs = await harness.writer.getStoreRefs([106, 107])
    expect(refs.has(106)).toBe(false)
    expect(refs.has(107)).toBe(false)
    expect(await harness.writer.getAppIds([107])).toEqual(new Map([[107, '']]))
  })
})
