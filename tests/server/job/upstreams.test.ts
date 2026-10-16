import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobClock } from '../../../scripts/index/deps'
import { parseUsdRate } from '../../../scripts/index/bank'
import { walkGogCatalog } from '../../../scripts/index/gog'
import {
  parseMicrosoftProducts,
  parseMicrosoftRelations,
  parseMicrosoftSearch,
} from '../../../scripts/index/microsoft'
import { PlaystationStopped } from '../../../scripts/index/playstation'
import { createRequestMeter } from '../../../scripts/index/requestMeter'
import {
  createJobBank,
  createJobGog,
  createJobMicrosoft,
  createJobPlaystation,
  createJobRawg,
  createJobSteam,
  STORE_USER_AGENT,
} from '../../../scripts/index/upstreams'

/**
 * The transports the refresh job builds for itself. They are the site's transports with a plain
 * `fetch` under them, and the one thing the job decides differently is what they write: nothing.
 * A stage reports every upstream failure itself, through the job's log; the transports' own line
 * about an attempt is for the site.
 */

/** A network that answers every request with `status` and `body`. */
function stubNetwork(status: number, body: unknown) {
  const network = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', network)
  return network
}

/** A clock on which every attempt appears to take `perRead` milliseconds per look at it. */
function clockAdvancingBy(perRead: number): JobClock {
  let now = 0
  return { now: () => (now += perRead), sleep: async () => {} }
}

const options = (clock: JobClock) => ({ apiKey: 'test-key', fixtures: false, clock })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the refresh job’s transports', () => {
  it('write no line of their own about a failed attempt, on any of the three paths', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = stubNetwork(502, null)
    const clock = clockAdvancingBy(0)
    const rawg = createJobRawg(options(clock))
    const steam = createJobSteam(options(clock))

    // Each fails after its one retry, and each failure is the stage's to report.
    await expect(rawg('games', { page: 1 })).rejects.toMatchObject({
      source: 'RAWG',
      kind: 'ERROR',
      status: 502,
    })
    await expect(steam.fetchPrices(['292030'])).rejects.toMatchObject({ source: 'STEAM' })
    await expect(steam.fetchAppLanguages('292030')).rejects.toMatchObject({ source: 'STEAM' })

    expect(network).toHaveBeenCalledTimes(6)
    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('keep the pacing they always had, with no burst: that is the site’s alone', async () => {
    stubNetwork(200, { results: [] })
    // A clock that stands still until the case moves it, so each wait is how far behind the first
    // request of its round a slot was.
    let now = 0
    const waits: number[] = []
    const clock: JobClock = { now: () => now, sleep: async (ms) => void waits.push(ms) }
    const rawg = createJobRawg(options(clock))
    const steam = createJobSteam(options(clock))

    // RAWG: a request per quarter of a second, the first three included.
    await Promise.all([1, 2, 3, 4].map((page) => rawg('games', { page })))
    expect(waits.splice(0)).toEqual([250, 500, 750])

    // Steam's prices, four chunks of them, and Steam's page about four apps: each a request per
    // second and a half, the first three included. On the site three would leave together and
    // the fourth a second and a half behind them (`STEAM_BURST`).
    const prices = () => steam.fetchPrices(Array.from({ length: 350 }, (_, id) => String(id)))
    const pagesAbout = (apps: string[]) =>
      Promise.all(apps.map((appId) => steam.fetchAppLanguages(appId)))
    await prices()
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
    await pagesAbout(['620', '292030', '413150', '730'])
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])

    // And an hour of rest earns them nothing: a burst is an allowance an idle limiter holds, and
    // the job's hold none.
    now += 3_600_000
    await prices()
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
    await pagesAbout(['400', '570', '220', '440'])
    expect(waits.splice(0)).toEqual([1_500, 3_000, 4_500])
  })

  it('write no line about a slow attempt either: how long an upstream took is the site’s question', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    stubNetwork(200, { results: [] })
    // Every look at the clock is three seconds on, so each attempt reads as a slow one.
    const clock = clockAdvancingBy(3_000)

    expect(await createJobRawg(options(clock))('games', { page: 1 })).toEqual({ results: [] })
    expect((await createJobSteam(options(clock)).fetchPrices(['292030'])).get('292030')).toBeNull()

    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})

/**
 * What the job's RAWG transport is counted and limited by (`requestMeter.ts`). RAWG's quota is a
 * number of requests, so the rules here are about what reaches the network: the stand-in for it
 * below is `fetch` itself, under the transport `runCli` builds, with its retry and its cache.
 */
describe('the refresh job’s RAWG transport and its request meter', () => {
  const still: JobClock = { now: () => 0, sleep: async () => {} }

  /** A network that answers each request with the next of `answers`, and the last one for good. */
  function scriptedNetwork(...answers: (number | 'timeout')[]) {
    const network = vi.fn(async () => {
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!
      if (answer === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError')
      return new Response(JSON.stringify({ results: [] }), { status: answer })
    })
    vi.stubGlobal('fetch', network)
    return network
  }

  it('counts a request for every call the network answers', async () => {
    const network = scriptedNetwork(200)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })

    await rawg('games', { page: 76 })
    await rawg('games/portal-2/stores')

    expect(network).toHaveBeenCalledTimes(2)
    expect(meter.issued()).toBe(2)
  })

  it.each([
    ['a 5xx', 502],
    ['a timeout', 'timeout'],
  ] as const)(
    'counts the transport’s retry after %s as a request of its own',
    async (_what, bad) => {
      const network = scriptedNetwork(bad, 200)
      const meter = createRequestMeter()
      const rawg = createJobRawg({ ...options(still), meter })

      expect(await rawg('games/portal-2/stores')).toEqual({ results: [] })

      // One call of the stage, two requests of RAWG's quota.
      expect(network).toHaveBeenCalledTimes(2)
      expect(meter.issued()).toBe(2)
    },
  )

  it('counts both attempts of a call that fails for good, and one for an answer that is not retried', async () => {
    const meter = createRequestMeter()
    scriptedNetwork(503)
    await expect(
      createJobRawg({ ...options(still), meter })('games', { page: 1 }),
    ).rejects.toThrow()
    expect(meter.issued()).toBe(2)

    // A 404 is an answer: the transport does not ask again.
    scriptedNetwork(404)
    await expect(
      createJobRawg({ ...options(still), meter })('games/gone/stores'),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' })
    expect(meter.issued()).toBe(3)
  })

  it('counts nothing for an answer out of the transport’s cache', async () => {
    const network = scriptedNetwork(200)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })

    await rawg('games/portal-2/stores')
    await rawg('games/portal-2/stores')

    expect(network).toHaveBeenCalledTimes(1)
    expect(meter.issued()).toBe(1)
  })

  it('sends exactly as many requests as the limit, and refuses the next before the network', async () => {
    const network = scriptedNetwork(200)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })
    meter.limitTo(3)

    for (const page of [1, 2, 3]) await rawg('games', { page })
    await expect(rawg('games', { page: 4 })).rejects.toMatchObject({ source: 'RAWG' })

    expect(network).toHaveBeenCalledTimes(3)
    expect(meter.issued()).toBe(3)
    expect(meter.refused()).toBeGreaterThan(0)
  })

  it('refuses a retry that would be one request too many', async () => {
    const network = scriptedNetwork(502)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })
    meter.limitTo(1)

    await expect(rawg('games/portal-2/stores')).rejects.toMatchObject({ source: 'RAWG' })

    // The first attempt was the last request there was: the retry it earned was not sent.
    expect(network).toHaveBeenCalledTimes(1)
    expect(meter.issued()).toBe(1)
    expect(meter.refused()).toBe(1)
  })

  it('lets a retry through when it is the last request of the limit', async () => {
    const network = scriptedNetwork(502, 200)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })
    meter.limitTo(2)

    expect(await rawg('games/portal-2/stores')).toEqual({ results: [] })

    expect(network).toHaveBeenCalledTimes(2)
    expect(meter.remaining()).toBe(0)
    expect(meter.refused()).toBe(0)
  })

  describe('and RAWG’s spare key', () => {
    /** A network that refuses the main key with `status` and answers the spare one. */
    function mainRefused(status: number) {
      const network = vi.fn(async (url: string) => {
        const main = new URL(url).searchParams.get('key') === 'test-key'
        return new Response(JSON.stringify({ results: [] }), { status: main ? status : 200 })
      })
      vi.stubGlobal('fetch', network)
      return network
    }
    const keyOf = (network: ReturnType<typeof mainRefused>) =>
      network.mock.calls.map(([url]) => new URL(url).searchParams.get('key'))

    it.each([401, 403])(
      'counts the request sent again with the spare key after a %i, and goes on with it',
      async (status) => {
        const network = mainRefused(status)
        const meter = createRequestMeter()
        const switches: number[] = []
        const rawg = createJobRawg({
          ...options(still),
          meter,
          spareApiKey: 'spare-key',
          onKeySwitch: (switched) => void switches.push(switched),
        })

        expect(await rawg('games', { page: 1 })).toEqual({ results: [] })
        expect(await rawg('games', { page: 2 })).toEqual({ results: [] })

        expect(keyOf(network)).toEqual(['test-key', 'spare-key', 'spare-key'])
        expect(meter.issued()).toBe(3)
        expect(switches).toEqual([status])
      },
    )

    it('refuses the request again with the spare key when the limit is spent', async () => {
      const network = mainRefused(401)
      const meter = createRequestMeter()
      const rawg = createJobRawg({ ...options(still), meter, spareApiKey: 'spare-key' })
      meter.limitTo(1)

      await expect(rawg('games', { page: 1 })).rejects.toMatchObject({ source: 'RAWG' })

      expect(network).toHaveBeenCalledTimes(1)
      expect(meter.issued()).toBe(1)
      expect(meter.refused()).toBeGreaterThan(0)
    })

    it.each([429, 500, 503])('does not switch on a %i', async (status) => {
      const network = mainRefused(status)
      const meter = createRequestMeter()
      const switches: number[] = []
      const rawg = createJobRawg({
        ...options(still),
        meter,
        spareApiKey: 'spare-key',
        onKeySwitch: (switched) => void switches.push(switched),
      })

      await expect(rawg('games', { page: 1 })).rejects.toMatchObject({ status })

      expect(keyOf(network).every((key) => key === 'test-key')).toBe(true)
      expect(switches).toEqual([])
    })

    it('fails as it always did on a 401 with no spare key', async () => {
      const network = mainRefused(401)
      const meter = createRequestMeter()
      const rawg = createJobRawg({ ...options(still), meter })

      await expect(rawg('games', { page: 1 })).rejects.toMatchObject({ kind: 'ERROR', status: 401 })

      expect(network).toHaveBeenCalledTimes(1)
      expect(meter.issued()).toBe(1)
    })
  })

  it('follows no redirect under a limit: one counted request is one request sent', async () => {
    const network = scriptedNetwork(301)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ ...options(still), meter })
    meter.limitTo(5)

    await expect(rawg('games/portal-2/stores')).rejects.toMatchObject({
      kind: 'ERROR',
      status: 301,
    })

    // Asked not to follow, answered with the redirect, and not asked again.
    expect((network.mock.calls as unknown as [string, RequestInit][])[0]![1]).toEqual({
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    })
    expect(network).toHaveBeenCalledTimes(1)
    expect(meter.issued()).toBe(1)
  })

  it('asks as it always did while no limit is set, meter or no meter', async () => {
    const network = scriptedNetwork(200)

    await createJobRawg({ ...options(still), meter: createRequestMeter() })('games', { page: 1 })

    expect((network.mock.calls as unknown as [string, RequestInit][])[0]![1]).toEqual({
      signal: expect.any(AbortSignal),
    })
  })

  it('counts a recorded answer as the request it stands for, and refuses one past the limit', async () => {
    const network = scriptedNetwork(200)
    const meter = createRequestMeter()
    const rawg = createJobRawg({ apiKey: '', fixtures: true, clock: still, meter })
    meter.limitTo(3)

    await rawg('games', { ordering: '-added', page: 76 })
    await rawg('games/portal-2/stores')
    // The studios stage's lists are answered apart from the transport, and counted like the rest.
    await rawg('games', { developers: 'gsc-game-world', page: 1 })
    await expect(rawg('games/stardew-valley/stores')).rejects.toThrow()

    expect(meter.issued()).toBe(3)
    expect(network).not.toHaveBeenCalled()
  })

  it('is RAWG’s alone: nothing Steam is asked is counted on it', async () => {
    scriptedNetwork(200)
    const meter = createRequestMeter()
    createJobRawg({ ...options(still), meter })

    await createJobSteam(options(still)).fetchPrices(['292030'])

    expect(meter.issued()).toBe(0)
  })
})

/**
 * The three transports only the job has: GOG's catalog, the Microsoft Store's display catalog and
 * the National Bank's rate. None of the three documents its endpoint for third parties, so how
 * the job behaves towards them is a rule of its own: it says who it is, it never hurries, and it
 * can be run in full without touching any of them.
 */
describe('the refresh job’s transports to GOG, the Microsoft Store and the National Bank', () => {
  const storeOptions = (clock: JobClock, fixtures = false) => ({ fixtures, clock })
  const still: JobClock = { now: () => 0, sleep: async () => {} }

  it('name the project and its repository on every request', async () => {
    const network = stubNetwork(200, { Products: [] })

    const microsoft = createJobMicrosoft(storeOptions(still))
    await createJobGog(storeOptions(still))(1)
    await microsoft.products(['BTQMHK78ZPF9'])
    await createJobBank(storeOptions(still))('2026-10-12')
    // The two questions a game without a price is asked about are the job's requests like any.
    await microsoft.details(['9MTNPF414F65'])
    await microsoft.search('Resident Evil Village')

    expect(STORE_USER_AGENT).toMatch(/^gg-stay-index-refresh\//)
    expect(STORE_USER_AGENT).toContain('https://github.com/Sennjen/gg-stay')
    const requests = network.mock.calls as unknown as [string, RequestInit][]
    expect(requests.map(([url]) => new URL(url).host)).toEqual([
      'catalog.gog.com',
      'displaycatalog.mp.microsoft.com',
      'bank.gov.ua',
      'displaycatalog.mp.microsoft.com',
      'displaycatalog.mp.microsoft.com',
    ])
    for (const [, init] of requests) {
      expect(init.headers).toMatchObject({ 'User-Agent': STORE_USER_AGENT })
      // Nothing that identifies anybody else: no key, no cookie, no token.
      expect(Object.keys(init.headers as object).sort()).toEqual(['Accept', 'User-Agent'])
    }
  })

  it('send a request a second to each of them, and never two together', async () => {
    stubNetwork(200, { Products: [] })
    let now = 0
    const waits: number[] = []
    const clock: JobClock = { now: () => now, sleep: async (ms) => void waits.push(ms) }
    const gog = createJobGog(storeOptions(clock))
    const microsoft = createJobMicrosoft(storeOptions(clock)).products
    const bank = createJobBank(storeOptions(clock))

    await Promise.all([1, 2, 3].map((page) => gog(page)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
    await Promise.all(['BTQMHK78ZPF9', '9NP1P1WFS0LB', '9PP5G1F0C2B6'].map((id) => microsoft([id])))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
    // Whatever Microsoft is asked leaves through the one limiter: a price read, a product's
    // relations and a search are a second apart from each other too.
    now += 3_600_000
    const catalog = createJobMicrosoft(storeOptions(clock))
    await Promise.all([
      catalog.products(['BTQMHK78ZPF9']),
      catalog.details(['9MTNPF414F65']),
      catalog.search('Prey'),
      catalog.search('Terraria'),
    ])
    expect(waits.splice(0)).toEqual([1_000, 2_000, 3_000])
    await Promise.all(['2026-10-10', '2026-10-11', '2026-10-12'].map((day) => bank(day)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])

    // An hour of rest earns no burst here either.
    now += 3_600_000
    await Promise.all([4, 5, 6].map((page) => gog(page)))
    expect(waits.splice(0)).toEqual([1_000, 2_000])
  })

  it('write no line of their own about a failed or a slow attempt', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const network = stubNetwork(503, null)
    // Every look at the clock is three seconds on, so each attempt reads as a slow one too.
    const clock = clockAdvancingBy(3_000)

    await expect(createJobGog(storeOptions(clock))(1)).rejects.toMatchObject({
      source: 'GOG',
      kind: 'ERROR',
      status: 503,
    })
    await expect(
      createJobMicrosoft(storeOptions(clock)).products(['BTQMHK78ZPF9']),
    ).rejects.toMatchObject({
      source: 'MICROSOFT',
    })
    await expect(createJobBank(storeOptions(clock))('2026-10-12')).rejects.toMatchObject({
      source: 'NBU',
    })

    // One retry each, and the stage that asked is the one to say what it cost.
    expect(network).toHaveBeenCalledTimes(6)
    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('serve the recorded answers in fixture mode, and ask the network nothing', async () => {
    const network = stubNetwork(200, null)
    const recordedAt = Date.parse('2026-10-12T14:04:00.000Z')
    const options = storeOptions(still, true)

    const walk = await walkGogCatalog(createJobGog(options))
    const products = await createJobMicrosoft(options).products(['BTQMHK78ZPF9'])

    expect([...walk.products.keys()]).toEqual([
      'the_witcher_3_redkit',
      'the_witcher_3_wild_hunt_game_of_the_year_edition',
      'the_witcher_3_wild_hunt_songs_of_the_past',
    ])
    expect(
      parseMicrosoftProducts(products, ['BTQMHK78ZPF9'], recordedAt).get('BTQMHK78ZPF9'),
    ).toEqual({
      price: { amount: 25_000, regularAmount: 25_000, discountPercent: 0 },
      title: 'LIMBO',
      kind: 'Game',
      // That recording was cut before the job read either.
      group: null,
      releasedAt: null,
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('serve the recorded relations and searches in fixture mode, and nothing for a name with no recording', async () => {
    const network = stubNetwork(200, null)
    const microsoft = createJobMicrosoft(storeOptions(still, true))

    const relations = parseMicrosoftRelations(await microsoft.details(['9MTNPF414F65']), [
      '9MTNPF414F65',
    ])
    expect(relations.get('9MTNPF414F65')?.parents).toHaveLength(4)
    expect(parseMicrosoftSearch(await microsoft.search('Prey'))[0]).toEqual({
      id: '9PBC1QFBW563',
      title: 'Prey',
    })
    // A dry run searches for whatever its fixtures leave without a price. A name nobody recorded
    // a search for is a name the store sells nothing under, never a failed request.
    expect(await microsoft.search('Stardew Valley')).toEqual({ Results: [], TotalResultCount: 0 })
    expect(parseMicrosoftSearch(await microsoft.search('Stardew Valley'))).toEqual([])
    expect(network).not.toHaveBeenCalled()
  })

  it('pass on a search the store refused: only a missing recording is "nothing found"', async () => {
    stubNetwork(429, null)

    await expect(createJobMicrosoft(storeOptions(still)).search('Prey')).rejects.toMatchObject({
      source: 'MICROSOFT',
      kind: 'RATE_LIMITED',
      status: 429,
    })
  })

  it('serve the recorded rate under whatever day is asked for, so a dry run always has one', async () => {
    const network = stubNetwork(200, null)
    const bank = createJobBank(storeOptions(still, true))

    // The recording is dated 13.10.2026; served as it is, only that one day would ever read it.
    expect(parseUsdRate(await bank('2026-10-12'), '2026-10-12')).toBe(44.9567)
    expect(parseUsdRate(await bank('2027-03-01'), '2027-03-01')).toBe(44.9567)
    expect(await bank('2027-03-01')).toMatchObject([
      { cc: 'USD', r030: 840, exchangedate: '01.03.2027' },
    ])
    expect(network).not.toHaveBeenCalled()
  })

  it('leave RAWG and Steam as they were asked before: no header of the job’s', async () => {
    const network = stubNetwork(200, { results: [] })

    await createJobRawg(options(still))('games', { page: 1 })

    expect((network.mock.calls as unknown as [string, RequestInit][])[0]![1]).toEqual({
      signal: expect.any(AbortSignal),
    })
  })
})

/**
 * The PlayStation Store's transport as the job builds it: the limits are the transport's own and
 * are tested with it (`playstation.test.ts`); what is decided here is what a request to Sony
 * looks like on the wire, and that a dry run sends none.
 */
describe('the refresh job’s transport to the PlayStation Store', () => {
  const storeOptions = (clock: JobClock, fixtures = false) => ({ fixtures, clock })
  /** A clock that moves only when the transport sleeps on it, and remembers each sleep. */
  function sleepingClock(): JobClock & { sleeps: number[] } {
    let now = 0
    const sleeps: number[] = []
    return { now: () => now, sleep: async (ms) => void ((now += ms), sleeps.push(ms)), sleeps }
  }
  /** A network that answers each request with the next of `responses`, then with the last. */
  function network(...responses: Response[]) {
    const fetched = vi.fn(async () =>
      responses.length > 1 ? responses.shift()! : responses[0]!.clone(),
    )
    vi.stubGlobal('fetch', fetched)
    return fetched as unknown as { mock: { calls: [string, RequestInit][] } }
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  const concept = [{ id: 201_930, titleIds: ['CUSA00419_00'] }]
  const noPrice = { data: { conceptRetrieve: { id: '201930', defaultProduct: null } } }

  it('names the project on both requests, sends no cookie, and follows no redirect', async () => {
    const sent = network(json(concept), json(noPrice))
    const store = createJobPlaystation(storeOptions(sleepingClock()))

    expect(await store.concept('CUSA00419_00')).toBe(201_930)
    expect(await store.price(201_930)).toBeNull()

    const [[titleUrl, title], [priceUrl, price]] = sent.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ]
    expect(new URL(titleUrl).host).toBe('m.np.playstation.com')
    expect(new URL(priceUrl).host).toBe('web.np.playstation.com')
    for (const init of [title, price]) {
      expect(init.method).toBeUndefined()
      expect(init.body).toBeUndefined()
      // A redirect is handed back, not followed: a hop nobody counted is a request nobody paced.
      expect(init.redirect).toBe('manual')
      expect(init.credentials).toBeUndefined()
      expect(init.headers).toMatchObject({
        'User-Agent': STORE_USER_AGENT,
        Accept: 'application/json',
      })
    }
    // Nothing that identifies anybody else, and nothing that makes it look like a browser.
    expect(Object.keys(title.headers as object).sort()).toEqual(['Accept', 'User-Agent'])
    expect(Object.keys(price.headers as object).sort()).toEqual([
      'Accept',
      'Content-Type',
      'User-Agent',
      'x-psn-store-locale-override',
    ])
    expect(price.headers).toMatchObject({
      'x-psn-store-locale-override': 'uk-UA',
      'Content-Type': 'application/json',
    })
  })

  it('waits ten seconds between two requests, and sends each once', async () => {
    const sent = network(json(concept, 503), json(concept))
    const clock = sleepingClock()
    const store = createJobPlaystation(storeOptions(clock))

    await expect(store.concept('CUSA00419_00')).rejects.toMatchObject({
      source: 'PLAYSTATION',
      status: 503,
    })
    expect(await store.concept('CUSA00419_00')).toBe(201_930)

    // The failed one was not retried: two questions, two requests, one pause between them.
    expect(sent.mock.calls).toHaveLength(2)
    expect(clock.sleeps).toEqual([10_000])
  })

  it.each([
    ['a 403', () => json({ message: 'Access Denied' }, 403)],
    ['a 429', () => json({}, 429)],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://x/' } })],
    [
      'a page that says it is one',
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    [
      'a page that does not say what it is',
      () => new Response('  <!DOCTYPE html><html><body>Checking your browser</body></html>'),
    ],
    ['a page under an error status', () => new Response('<html>busy</html>', { status: 503 })],
    ['a success with nothing in it', () => new Response('', { status: 200 })],
  ])('takes %s for a refusal, and asks nothing after it', async (_what, answer) => {
    const sent = network(answer())
    const store = createJobPlaystation(storeOptions(sleepingClock()))

    await expect(store.concept('CUSA00419_00')).rejects.toMatchObject({ source: 'PLAYSTATION' })

    expect(store.stopped()?.reason).toBe('refused')
    await expect(store.price(201_930)).rejects.toBeInstanceOf(PlaystationStopped)
    expect(sent.mock.calls).toHaveLength(1)
  })

  it('takes a body that never arrived for a failure, not for an answer that was not data', async () => {
    // A 200 whose body breaks off in the middle: the connection was reset, or the timeout passed.
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('socket hang up'))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const fetched = vi.fn(async () => broken())
    vi.stubGlobal('fetch', fetched)
    const store = createJobPlaystation(storeOptions(sleepingClock()))

    await expect(store.concept('CUSA00419_00')).rejects.toMatchObject({
      source: 'PLAYSTATION',
      kind: 'ERROR',
    })

    // One failure, and the run goes on; it would have stopped at a refusal.
    expect(store.stopped()).toBeNull()
    await store.concept('CUSA00419_00').catch(() => {})
    expect(fetched).toHaveBeenCalledTimes(2)
  })

  it('counts the pause on the clock that only goes forward, whatever the wall clock does', async () => {
    network(json(concept), json(noPrice))
    let wall = Date.parse('2026-10-13T06:15:00.000Z')
    let monotonic = 0
    const sleeps: number[] = []
    const store = createJobPlaystation(
      storeOptions({
        now: () => wall,
        monotonic: () => monotonic,
        sleep: async (ms) => void (sleeps.push(ms), (monotonic += ms), (wall += ms)),
      }),
    )

    await store.concept('CUSA00419_00')
    // The runner's clock is set an hour ahead. By it, the pause would be long over.
    wall += 3_600_000
    await store.price(201_930)

    expect(sleeps).toEqual([10_000])
  })

  it('is one transport a clock: a second caller shares the pause and the ration of the first', async () => {
    const sent = network(json(concept), json(noPrice))
    const clock = sleepingClock()
    const first = createJobPlaystation(storeOptions(clock))
    const second = createJobPlaystation(storeOptions(clock))

    expect(second).toBe(first)
    await first.concept('CUSA00419_00')
    await second.price(201_930)

    // Two callers, one line: the second waited out the first one's pause.
    expect(clock.sleeps).toEqual([10_000])
    expect(second.requests()).toBe(2)
    expect(sent.mock.calls).toHaveLength(2)
    // Another clock is another process's, in a test; and a transport that sends nothing has no
    // pause to share.
    expect(createJobPlaystation(storeOptions(sleepingClock()))).not.toBe(first)
    expect(createJobPlaystation(storeOptions(clock, true))).not.toBe(
      createJobPlaystation(storeOptions(clock, true)),
    )
  })

  it('takes an error that is data for a failure and not a refusal', async () => {
    const sent = network(json({ message: 'Query not whitelisted' }, 400), json(noPrice))
    const store = createJobPlaystation(storeOptions(sleepingClock()))

    await expect(store.price(201_930)).rejects.toMatchObject({ kind: 'ERROR', status: 400 })

    expect(store.stopped()).toBeNull()
    expect(await store.price(201_930)).toBeNull()
    expect(sent.mock.calls).toHaveLength(2)
  })

  it('serves the recorded answers in fixture mode, and asks the network nothing', async () => {
    const sent = network(json(null))
    const clock = sleepingClock()
    const store = createJobPlaystation(storeOptions(clock, true))

    // Grand Theft Auto V's American title, and the product Sony puts first for its concept.
    expect(await store.concept('CUSA00419_00')).toBe(201_930)
    expect(await store.price(201_930)).toMatchObject({
      id: 'EP1004-PPSA01721_00-GTAOSTANDALONE01',
      title: 'Grand Theft Auto Online (PlayStation®5)',
      price: { amount: 89_900, regularAmount: 89_900, discountPercent: 0, saleEndsAt: null },
      url: 'https://store.playstation.com/uk-ua/product/EP1004-PPSA01721_00-GTAOSTANDALONE01',
    })
    expect(await store.concept('CUSA99999_00')).toBeNull()
    expect(sent.mock.calls).toHaveLength(0)
    expect(clock.sleeps).toEqual([])
  })

  it('writes no line of its own, whatever came of a request', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    network(json({}, 500))
    const store = createJobPlaystation(storeOptions(sleepingClock()))

    await store.concept('CUSA00419_00').catch(() => {})

    expect(info).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
