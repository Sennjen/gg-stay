import { describe, expect, it } from 'vitest'
import {
  createPlaystationStore,
  parsePlaystationConcept,
  parsePlaystationPrice,
  PLAYSTATION_BUDGET_MS,
  PLAYSTATION_FAILURES_IN_A_ROW,
  PLAYSTATION_PAUSE_MS,
  PLAYSTATION_REQUESTS_PER_RUN,
  playstationProductUrl,
  playstationPurchasePrice,
  PlaystationStopped,
  type PlaystationResponse,
  type PlaystationStore,
} from '../../../scripts/index/playstation'
import {
  JOB_PLAYSTATION_SALE_ENDS,
  JOB_PLAYSTATION_SALE_ENDS_AT,
  sonyConcept,
  sonyCta,
  sonyFreeDownload,
  sonyNoConcept,
  sonyNotInTheStore,
  sonyPlusCatalogue,
  sonyPrice,
  sonyProduct,
  sonyPurchase,
  sonyTrial,
} from '../../fixtures/index/jobPlaystation'
import conceptsCyberpunk from '../../fixtures/playstation/concepts-CUSA16596_00.json' with { type: 'json' }
import conceptsGodOfWar from '../../fixtures/playstation/concepts-CUSA07408_00.json' with { type: 'json' }
import conceptsGtaSanAndreas from '../../fixtures/playstation/concepts-CUSA03506_00.json' with { type: 'json' }
import conceptsGtaV from '../../fixtures/playstation/concepts-CUSA00419_00.json' with { type: 'json' }
import conceptsGtaVPs5 from '../../fixtures/playstation/concepts-PPSA01721_00.json' with { type: 'json' }
import conceptsPortal2 from '../../fixtures/playstation/concepts-NPUB31077_00.json' with { type: 'json' }
import conceptsStardew from '../../fixtures/playstation/concepts-CUSA06840_00.json' with { type: 'json' }
import conceptsTerraria from '../../fixtures/playstation/concepts-CUSA00740_00.json' with { type: 'json' }
import conceptsUnknown from '../../fixtures/playstation/concepts-CUSA99999_00.json' with { type: 'json' }
import conceptsWitcher from '../../fixtures/playstation/concepts-CUSA00527_00.json' with { type: 'json' }
import priceCyberpunk from '../../fixtures/playstation/price-234567.json' with { type: 'json' }
import priceGodOfWar from '../../fixtures/playstation/price-227770.json' with { type: 'json' }
import priceGtaSanAndreas from '../../fixtures/playstation/price-201957.json' with { type: 'json' }
import priceGtaV from '../../fixtures/playstation/price-201930.json' with { type: 'json' }
import priceLifeIsStrange from '../../fixtures/playstation/price-202416.json' with { type: 'json' }
import priceNotRegistered from '../../fixtures/playstation/price-not-registered.json' with { type: 'json' }
import priceRedDead from '../../fixtures/playstation/price-209441.json' with { type: 'json' }
import priceStardew from '../../fixtures/playstation/price-227229.json' with { type: 'json' }
import priceTerraria from '../../fixtures/playstation/price-205080.json' with { type: 'json' }
import priceUnknown from '../../fixtures/playstation/price-999999999.json' with { type: 'json' }
import priceWarframe from '../../fixtures/playstation/price-205342.json' with { type: 'json' }
import priceWitcher from '../../fixtures/playstation/price-204794.json' with { type: 'json' }
import { createFakeClock, createFakeSony, type FakeClock, type FakeSony } from './harness'

/**
 * The PlayStation Store's transport and its two parsers. The recorded answers
 * (`tests/fixtures/playstation`) are Sony's own, of 2026-10-13, cut to the fields that are read;
 * the hand-written ones are for the shapes no recording has.
 *
 * The transport's rules are the conditions the store is read on, so each of them has a test that
 * fails when the rule is taken out: the pause, the cap, the budget, no retry, the stop on a
 * refusal, the stop on three failures in a row.
 */

const START = '2026-10-13T06:15:00.000Z'
const TITLE = 'CUSA10600_00'
const OTHER_TITLE = 'PPSA10800_00'
const CONCEPT = 10_106

interface Sony extends FakeSony {
  clock: FakeClock
  store: PlaystationStore
  /** How long after the first request each one left, in milliseconds. */
  leftAt: () => number[]
}

function sony(): Sony {
  const clock = createFakeClock(START)
  const fake = createFakeSony(clock)
  return {
    ...fake,
    clock,
    store: fake.playstation,
    leftAt: () => fake.sonyRequests.map((request) => request.at - fake.sonyRequests[0]!.at),
  }
}

/** Asks about the same concept `times` times over, taking whatever comes of each. */
async function askTimes(store: PlaystationStore, times: number): Promise<unknown[]> {
  const outcomes: unknown[] = []
  for (let asked = 0; asked < times; asked += 1) {
    outcomes.push(await store.price(CONCEPT).catch((error: unknown) => error))
  }
  return outcomes
}

describe('the PlayStation transport: what it asks', () => {
  it('asks the catalog which concept a title belongs to, for Ukraine', async () => {
    const { store, sonyRequests } = sony()

    expect(await store.concept(TITLE)).toBe(CONCEPT)

    expect(sonyRequests).toHaveLength(1)
    expect(sonyRequests[0]).toMatchObject({
      kind: 'concept',
      id: TITLE,
      url: `https://m.np.playstation.com/api/catalog/v2/titles/${TITLE}/concepts?country=UA&language=uk&age=99`,
      // Nothing of the transport's own: who is asking is added by whoever sends the request.
      headers: {},
    })
  })

  it('asks the storefront for a concept’s price, by its registered operation, as the Ukrainian store', async () => {
    const { store, sonyRequests } = sony()

    const product = await store.price(CONCEPT)

    expect(product).toMatchObject({ title: 'Amber Trail', price: { amount: 39_950 } })
    const url = new URL(sonyRequests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://web.np.playstation.com/api/graphql/v1/op')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      operationName: 'conceptRetrieveForCtasWithPrice',
      variables: '{"conceptId":"10106"}',
      extensions:
        '{"persistedQuery":{"version":1,"sha256Hash":"eab9d873f90d4ad98fd55f07b6a0a606e6b3925f2d03b70477234b79c1df30b5"}}',
    })
    // The locale is what makes the answer Ukraine's; without the second the server answers 400,
    // "blocked as a potential Cross-Site Request Forgery".
    expect(sonyRequests[0]!.headers).toEqual({
      'x-psn-store-locale-override': 'uk-UA',
      'Content-Type': 'application/json',
    })
  })

  it('puts nothing into an address that is not a title or a concept, and sends nothing', async () => {
    const { store, sonyRequests } = sony()

    for (const title of ['NPUB31077_00', 'CUSA00419_00/../x', 'cusa00419_00', '']) {
      await expect(store.concept(title)).rejects.toThrow('not a PlayStation title id')
    }
    for (const concept of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      await expect(store.price(concept)).rejects.toThrow('not a PlayStation concept id')
    }
    expect(sonyRequests).toHaveLength(0)
    expect(store.requests()).toBe(0)
  })
})

describe('the PlayStation transport: ten seconds between two requests', () => {
  it('lets the first request leave at once, and every later one ten seconds after the last', async () => {
    const { store, leftAt } = sony()

    await store.concept(TITLE)
    await store.price(CONCEPT)
    await store.concept(OTHER_TITLE)
    await store.price(10_108)

    // Of either kind: the two hosts share one pause.
    expect(PLAYSTATION_PAUSE_MS).toBe(10_000)
    expect(leftAt()).toEqual([0, 10_000, 20_000, 30_000])
  })

  it('counts the pause from the moment the last request ended, not from when it left', async () => {
    const { store, leftAt, sonyState } = sony()
    sonyState.latencyMs = 1_700

    await askTimes(store, 3)

    expect(leftAt()).toEqual([0, 11_700, 23_400])
  })

  it('keeps the pause for a caller that waited longer by itself, and adds nothing to it', async () => {
    const { store, leftAt, clock } = sony()

    await store.price(CONCEPT)
    clock.advance(4_000)
    await store.price(CONCEPT)
    clock.advance(25_000)
    await store.price(CONCEPT)

    // Six more seconds were owed the first time; none the second.
    expect(leftAt()).toEqual([0, 10_000, 35_000])
  })

  it('keeps the pause whatever came of the request before', async () => {
    const { store, leftAt, sonyAnswersWith, sonyState } = sony()
    sonyState.latencyMs = 300
    sonyAnswersWith({ status: 500 })
    sonyAnswersWith(new Error('socket hang up'))

    const outcomes = await askTimes(store, 4)

    expect(outcomes.map((outcome) => outcome instanceof Error)).toEqual([true, true, false, false])
    expect(leftAt()).toEqual([0, 10_300, 20_600, 30_900])
  })

  it('sends two questions put in the same breath one after the other, in the order they were put', async () => {
    const { store, sonyRequests, leftAt } = sony()

    await Promise.all([
      store.price(CONCEPT),
      store.concept(TITLE),
      store.price(10_108),
      store.concept(OTHER_TITLE),
    ])

    expect(sonyRequests.map((request) => `${request.kind} ${request.id}`)).toEqual([
      `price ${CONCEPT}`,
      `concept ${TITLE}`,
      'price 10108',
      `concept ${OTHER_TITLE}`,
    ])
    expect(leftAt()).toEqual([0, 10_000, 20_000, 30_000])
  })
})

describe('the PlayStation transport: the pause is kept by the clock, not by the timer', () => {
  /** A transport on a clock of the case's own, with a sleep that does what the case says. */
  function onClock(sleep: (ms: number, clock: { now: number }) => void) {
    const clock = { now: 5_000 }
    const sleeps: number[] = []
    const sentAt: number[] = []
    const store = createPlaystationStore({
      fixtures: false,
      fetch: async () => {
        sentAt.push(clock.now)
        return { status: 200, body: sonyConcept(CONCEPT, [TITLE]), html: false }
      },
      readFixture: async () => null,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        sleep(ms, clock)
      },
    })
    return { store, sleeps, sentAt }
  }

  it('sleeps again when a timer fires early, and sends nothing until the ten seconds are up', async () => {
    // Every sleep comes back three milliseconds short of what was asked, until one is asked for
    // less than that.
    const { store, sleeps, sentAt } = onClock(
      (ms, clock) => void (clock.now += ms > 3 ? ms - 3 : ms),
    )

    await store.concept(TITLE)
    await store.concept(TITLE)

    expect(sleeps).toEqual([10_000, 3])
    expect(sentAt).toEqual([5_000, 15_000])
  })

  it('sends nothing on a clock that stands still, and gives up at the third pause', async () => {
    const { store, sentAt } = onClock(() => {})

    await store.concept(TITLE)
    const outcomes = [
      await store.concept(TITLE).catch((error: unknown) => error),
      await store.concept(TITLE).catch((error: unknown) => error),
      await store.concept(TITLE).catch((error: unknown) => error),
      await store.concept(TITLE).catch((error: unknown) => error),
    ] as Error[]

    // The one request that needed no pause, and none after it: never early, and never for ever.
    expect(sentAt).toEqual([5_000])
    expect(outcomes[0]!.message).toBe('the clock stood still through a pause')
    expect(outcomes[3]).toBeInstanceOf(PlaystationStopped)
    expect(store.stopped()?.reason).toBe('failures')
  })
})

describe('the PlayStation transport: a run’s ration', () => {
  it('makes 225 requests in a run and not one more', async () => {
    const { store, sonyRequests } = sony()

    const outcomes = await askTimes(store, PLAYSTATION_REQUESTS_PER_RUN + 3)

    expect(PLAYSTATION_REQUESTS_PER_RUN).toBe(225)
    expect(sonyRequests).toHaveLength(225)
    expect(store.requests()).toBe(225)
    expect(outcomes.slice(0, 225).every((outcome) => !(outcome instanceof Error))).toBe(true)
    // What is asked after that is not asked of Sony at all.
    for (const outcome of outcomes.slice(225)) expect(outcome).toBeInstanceOf(PlaystationStopped)
    expect(store.stopped()).toEqual({
      reason: 'requests',
      detail: 'the run has made its 225 requests',
    })
  })

  it('counts both kinds of request, and the failed ones, in the same 225', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    // Every third request fails, so no three in a row do.
    sonyAnswersWith(
      { status: 500 },
      { times: Infinity, match: (request) => request.at % 30_000 === 0 },
    )

    for (let asked = 0; asked < 150; asked += 1) {
      await store.concept(TITLE).catch(() => {})
      await store.price(CONCEPT).catch(() => {})
    }

    expect(sonyRequests).toHaveLength(225)
    expect(sonyRequests.filter((request) => request.kind === 'concept')).toHaveLength(113)
  })

  it('asks for forty minutes from its first request and no longer', async () => {
    const { store, sonyRequests, leftAt, sonyState } = sony()
    // A slow day: five seconds an answer, so a request leaves every fifteen.
    sonyState.latencyMs = 5_000

    const outcomes = await askTimes(store, PLAYSTATION_REQUESTS_PER_RUN)

    expect(PLAYSTATION_BUDGET_MS).toBe(40 * 60_000)
    // The 160th leaves fifteen seconds short of the forty minutes; the next would leave on them.
    expect(sonyRequests).toHaveLength(160)
    expect(leftAt().at(-1)).toBe(PLAYSTATION_BUDGET_MS - 15_000)
    expect(outcomes[160]).toBeInstanceOf(PlaystationStopped)
    expect(store.stopped()).toEqual({
      reason: 'time',
      detail: 'the run has used its forty minutes',
    })
  })

  it('counts the forty minutes from the first request, however long the transport waited for it', async () => {
    const { store, sonyRequests, clock } = sony()
    // Built with the rest of the job's dependencies, an hour before its stage begins.
    clock.advance(60 * 60_000)

    await askTimes(store, 3)

    expect(sonyRequests).toHaveLength(3)
    expect(store.stopped()).toBeNull()
  })

  it('has not stopped while the next request would still leave inside the ration', async () => {
    const { store } = sony()
    expect(store.stopped()).toBeNull()

    await askTimes(store, PLAYSTATION_REQUESTS_PER_RUN - 1)

    expect(store.stopped()).toBeNull()
  })
})

describe('the PlayStation transport: no retry', () => {
  it.each([
    ['a 500', { status: 500 } as Partial<PlaystationResponse> | Error],
    ['a 503 with a body', { status: 503, body: { message: 'unavailable' } }],
    ['a 404', { status: 404, body: {} }],
    ['a request that never came back', new Error('fetch failed')],
    ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
  ])('asks once about a game whose request met %s', async (_what, outcome) => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    sonyAnswersWith(outcome)

    await expect(store.price(CONCEPT)).rejects.toMatchObject({ source: 'PLAYSTATION' })

    expect(sonyRequests).toHaveLength(1)
    // And the run goes on: one failure ends nothing.
    expect(store.stopped()).toBeNull()
    await expect(store.price(CONCEPT)).resolves.toMatchObject({ title: 'Amber Trail' })
  })

  it('names a failure by its kind and its status, and never by anything Sony wrote', async () => {
    const { store, sonyAnswersWith } = sony()
    sonyAnswersWith({ status: 500, body: { message: 'x\n::error::injected' } })
    sonyAnswersWith(Object.assign(new Error('x\n::error::injected'), { name: 'TimeoutError' }))
    sonyAnswersWith(new Error('x\n::error::injected'))

    const [status, timeout, network] = (await askTimes(store, 3)) as Error[]

    expect(status!.message).toBe('PLAYSTATION upstream failure: ERROR (500)')
    expect(timeout!.message).toBe('PLAYSTATION upstream failure: TIMEOUT')
    expect(network!.message).toBe('PLAYSTATION upstream failure: ERROR')
  })
})

describe('the PlayStation transport: the first refusal ends the run’s asking', () => {
  it.each([
    ['a 403', { status: 403, body: { message: 'Access Denied' } }, 'HTTP 403'],
    ['a 429', { status: 429, body: {} }, 'HTTP 429'],
    ['a challenge page', { status: 200, html: true }, 'a page instead of data'],
    ['a page under an error status', { status: 503, html: true }, 'a page instead of data'],
    ['a success that is not JSON', { status: 200, body: undefined }, 'an answer that is not data'],
    ['a redirect', { status: 302 }, 'a redirect (HTTP 302)'],
  ] as [string, Partial<PlaystationResponse>, string][])(
    'stops at %s',
    async (_what, response, detail) => {
      const { store, sonyRequests, sonyAnswersWith } = sony()
      await store.price(CONCEPT)
      sonyAnswersWith(response)

      await expect(store.price(CONCEPT)).rejects.toMatchObject({ source: 'PLAYSTATION' })

      expect(store.stopped()).toEqual({ reason: 'refused', detail })
      // Nothing more is asked, of either endpoint, however often it is tried.
      await expect(store.price(CONCEPT)).rejects.toBeInstanceOf(PlaystationStopped)
      await expect(store.concept(TITLE)).rejects.toBeInstanceOf(PlaystationStopped)
      await expect(store.price(10_108)).rejects.toBeInstanceOf(PlaystationStopped)
      expect(sonyRequests).toHaveLength(2)
    },
  )

  it('stops at a refusal that is the very first answer of the run', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    sonyAnswersWith({ status: 403 })

    await expect(store.concept(TITLE)).rejects.toMatchObject({ kind: 'ERROR', status: 403 })
    await expect(store.concept(TITLE)).rejects.toBeInstanceOf(PlaystationStopped)

    expect(sonyRequests).toHaveLength(1)
  })

  it('says in the error what stopped it, in its own words', async () => {
    const { store, sonyAnswersWith } = sony()
    sonyAnswersWith({ status: 429 })
    await store.price(CONCEPT).catch(() => {})

    const error = await store.price(CONCEPT).catch((caught: unknown) => caught)

    expect((error as PlaystationStopped).stop).toEqual({ reason: 'refused', detail: 'HTTP 429' })
    expect((error as Error).message).toBe('Sony is not asked anything more in this run: HTTP 429')
  })
})

describe('the PlayStation transport: three failures in a row end the run’s asking', () => {
  it('stops at the third, and asks nothing after it', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    sonyAnswersWith({ status: 500 }, { times: Infinity })

    const outcomes = await askTimes(store, 6)

    expect(PLAYSTATION_FAILURES_IN_A_ROW).toBe(3)
    expect(sonyRequests).toHaveLength(3)
    expect(outcomes.slice(3).every((outcome) => outcome instanceof PlaystationStopped)).toBe(true)
    expect(store.stopped()).toEqual({ reason: 'failures', detail: '3 requests in a row failed' })
  })

  it('counts failures of any kind together: a status, a timeout, an answer it cannot read', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    sonyAnswersWith({ status: 502 })
    sonyAnswersWith(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    sonyAnswersWith({ status: 200, body: { data: {} } })

    await askTimes(store, 5)

    expect(sonyRequests).toHaveLength(3)
    expect(store.stopped()?.reason).toBe('failures')
  })

  it('starts the count again at an answer it could read, whatever the answer said', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    const failTwice = () => sonyAnswersWith({ status: 500 }, { times: 2 })

    failTwice()
    await askTimes(store, 2)
    // A price.
    await store.price(CONCEPT)
    failTwice()
    await askTimes(store, 2)
    // "No such concept" is an answer too, and so is "no such title".
    expect(await store.price(999)).toBeNull()
    failTwice()
    await askTimes(store, 2)
    expect(await store.concept('CUSA99999_00')).toBeNull()

    expect(sonyRequests).toHaveLength(9)
    expect(store.stopped()).toBeNull()
  })

  it('stops a run whose every price is refused because Sony no longer knows the operation', async () => {
    const { store, sonyRequests, sonyAnswersWith } = sony()
    // What the storefront answers to a hash it has not registered, as recorded: a 400.
    sonyAnswersWith({ status: 400, body: priceNotRegistered }, { times: Infinity })

    const outcomes = (await askTimes(store, 10)) as Error[]

    expect(sonyRequests).toHaveLength(3)
    expect(outcomes[0]!.message).toBe('PLAYSTATION upstream failure: ERROR (400)')
    expect(store.stopped()?.reason).toBe('failures')
  })
})

describe('the PlayStation transport in fixture mode', () => {
  function recorded(fixtures: Record<string, unknown>) {
    const sleeps: number[] = []
    const sent: string[] = []
    const store = createPlaystationStore({
      fixtures: true,
      fetch: async (url) => {
        sent.push(url)
        return { status: 200, body: {}, html: false }
      },
      readFixture: async (name) => fixtures[name] ?? null,
      now: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
    })
    return { store, sleeps, sent }
  }

  it('reads the recorded answers, sends nothing and waits for nothing', async () => {
    const { store, sleeps, sent } = recorded({
      'concepts-CUSA00419_00': conceptsGtaV,
      'price-201930': priceGtaV,
    })

    expect(await store.concept('CUSA00419_00')).toBe(201_930)
    expect(await store.price(201_930)).toMatchObject({
      id: 'EP1004-PPSA01721_00-GTAOSTANDALONE01',
      price: { amount: 89_900 },
    })
    expect(sent).toEqual([])
    expect(sleeps).toEqual([])
    expect(store.requests()).toBe(2)
  })

  it('takes a game with no recording for a request that failed, three of them for the end', async () => {
    const { store, sent } = recorded({})

    await expect(store.concept('CUSA00419_00')).rejects.toMatchObject({
      source: 'PLAYSTATION',
      kind: 'NOT_FOUND',
    })
    await store.price(1).catch(() => {})
    await store.price(2).catch(() => {})

    await expect(store.price(3)).rejects.toBeInstanceOf(PlaystationStopped)
    expect(store.stopped()?.reason).toBe('failures')
    expect(sent).toEqual([])
  })
})

describe('parsePlaystationConcept', () => {
  it.each([
    [
      'Grand Theft Auto V, by its American PlayStation 4 title',
      conceptsGtaV,
      'CUSA00419_00',
      201_930,
    ],
    ['the same concept, by a PlayStation 5 title', conceptsGtaVPs5, 'PPSA01721_00', 201_930],
    ['Terraria', conceptsTerraria, 'CUSA00740_00', 205_080],
    ['The Witcher 3', conceptsWitcher, 'CUSA00527_00', 204_794],
    ['God of War', conceptsGodOfWar, 'CUSA07408_00', 227_770],
    ['Cyberpunk 2077', conceptsCyberpunk, 'CUSA16596_00', 234_567],
    // A concept with nothing on sale, and one with a product and no default one, are concepts.
    ['Grand Theft Auto: San Andreas', conceptsGtaSanAndreas, 'CUSA03506_00', 201_957],
    ['Stardew Valley', conceptsStardew, 'CUSA06840_00', 227_229],
  ])('reads the concept of %s from the recorded answer', (_what, body, titleId, conceptId) => {
    expect(parsePlaystationConcept(body, titleId)).toBe(conceptId)
  })

  it('reads "no concept" for a PlayStation 3 title, and for a title Sony never had', () => {
    expect(parsePlaystationConcept(conceptsPortal2, 'NPUB31077_00')).toBeNull()
    expect(parsePlaystationConcept(conceptsUnknown, 'CUSA99999_00')).toBeNull()
  })

  it('takes a concept only from an entry that names the title asked about', () => {
    // The right shape, about another game: not an answer to this question.
    expect(() => parsePlaystationConcept(conceptsTerraria, 'CUSA00419_00')).toThrow(
      'without a word about the title',
    )
    expect(() => parsePlaystationConcept(sonyNoConcept('CUSA00001_00'), TITLE)).toThrow(
      'without a word about the title',
    )
    expect(() => parsePlaystationConcept([], TITLE)).toThrow('without a word about the title')
    // Beside an entry about another title, the one about this title decides.
    expect(
      parsePlaystationConcept(
        [...sonyConcept(7, ['CUSA00001_00']), ...sonyConcept(8, [TITLE, 'CUSA10601_00'])],
        TITLE,
      ),
    ).toBe(8)
  })

  it('reads no concept, rather than a guess, when the title belongs to several', () => {
    const several = [...sonyConcept(7, [TITLE]), ...sonyConcept(8, [TITLE])]
    expect(parsePlaystationConcept(several, TITLE)).toBeNull()
  })

  it.each([
    ['not a list', { id: 7, titleIds: [TITLE] }],
    ['nothing', null],
    ['a page', '<!DOCTYPE html>'],
    ['an error of another kind', sonyNoConcept(TITLE, 3_165_000)],
    ['an error that is not a number', [{ titleIds: [TITLE], errorCode: 'NOT_FOUND' }]],
    ['"no such title" beside a concept id', [{ id: 7, titleIds: [TITLE], errorCode: 3_166_081 }]],
    ['an entry with neither a concept nor an error', [{ titleIds: [TITLE] }]],
    ['a concept id in a string', [{ id: '7', titleIds: [TITLE] }]],
    ['a concept id that is no id', [{ id: -7, titleIds: [TITLE] }]],
  ])('throws for %s, so that nothing is remembered about the title', (_what, body) => {
    expect(() => parsePlaystationConcept(body, TITLE)).toThrow(/^Sony answered/)
  })
})

/** The default product of a recorded price answer. */
const productOf = (body: typeof priceTerraria) => body.data.conceptRetrieve.defaultProduct

describe('parsePlaystationPrice, on the recorded answers', () => {
  it('reads a paid game on sale: what is charged, the regular price, and when the sale ends', () => {
    expect(parsePlaystationPrice(priceTerraria, 205_080)).toEqual({
      id: 'EP4040-CUSA00737_00-TERRARIA00000001',
      title: 'Terraria – PlayStation®4 Edition',
      price: {
        // 309,50 against 619,00: the trial and the subscriber's zero beside it are not prices.
        amount: 30_950,
        regularAmount: 61_900,
        discountPercent: 50,
        saleEndsAt: JOB_PLAYSTATION_SALE_ENDS_AT,
      },
      url: 'https://store.playstation.com/uk-ua/product/EP4040-CUSA00737_00-TERRARIA00000001',
    })
    // The trial comes first in the answer, at zero; the lowest entry is not the price.
    expect(productOf(priceTerraria).webctas.map((entry) => entry.type)).toEqual([
      'DOWNLOAD_TRIAL',
      'ADD_TO_CART',
      'UPSELL_PS_PLUS_GAME_CATALOG',
    ])
  })

  it('reads a paid game that is not on sale, with no end of a sale', () => {
    expect(parsePlaystationPrice(priceGodOfWar, 227_770)).toEqual({
      id: 'EP9000-CUSA07412_00-0000000GODOFWARN',
      title: 'God of War™',
      price: { amount: 64_900, regularAmount: 64_900, discountPercent: 0, saleEndsAt: null },
      url: 'https://store.playstation.com/uk-ua/product/EP9000-CUSA07412_00-0000000GODOFWARN',
    })
    expect(parsePlaystationPrice(priceCyberpunk, 234_567)).toMatchObject({
      title: 'Cyberpunk 2077',
      price: { amount: 149_900, regularAmount: 149_900, discountPercent: 0 },
    })
  })

  it('reads a free game as a price of nothing', () => {
    expect(parsePlaystationPrice(priceWarframe, 205_342)).toEqual({
      id: 'EP2097-PPSA01980_00-7357509687265755',
      title: 'Warframe®',
      price: { amount: 0, regularAmount: 0, discountPercent: 0, saleEndsAt: null },
      url: 'https://store.playstation.com/uk-ua/product/EP2097-PPSA01980_00-7357509687265755',
    })
  })

  it('reads the default product under its own name, which is not always the game', () => {
    // Asked about Grand Theft Auto V, Sony puts the standalone Grand Theft Auto Online first.
    expect(parsePlaystationPrice(priceGtaV, 201_930)).toMatchObject({
      id: 'EP1004-PPSA01721_00-GTAOSTANDALONE01',
      title: 'Grand Theft Auto Online (PlayStation®5)',
      price: { amount: 89_900, regularAmount: 89_900 },
    })
    // Asked about Life is Strange, the free first episode.
    expect(parsePlaystationPrice(priceLifeIsStrange, 202_416)).toMatchObject({
      title: 'Life Is Strange Episode 1',
      price: { amount: 0, regularAmount: 0 },
    })
    // And The Witcher 3 under the name the Ukrainian store gives its complete edition.
    expect(parsePlaystationPrice(priceWitcher, 204_794)).toMatchObject({
      id: 'EP4497-PPSA04021_00-0000000000GOTY11',
      title: productOf(priceWitcher as typeof priceTerraria).name,
      price: { amount: 164_900, regularAmount: 164_900 },
    })
  })

  it('reads no price where the sale is for the buyers of an experiment', () => {
    // Red Dead Redemption 2 on 2026-10-13: 649,75 against 2 599,00, for `USER_IN_EXPERIMENT`.
    const purchase = productOf(priceRedDead as typeof priceTerraria).webctas[1]!
    expect(purchase.type).toBe('ADD_TO_CART')
    expect(purchase.price.qualifications.map((entry) => entry.type)).toEqual([
      'USER_IN_EXPERIMENT',
      'USER_IN_EXPERIMENT',
    ])

    expect(parsePlaystationPrice(priceRedDead, 209_441)).toBeNull()
  })

  it('reads no price for a concept with no default product', () => {
    // Nothing of it on sale at all.
    expect(parsePlaystationPrice(priceGtaSanAndreas, 201_957)).toBeNull()
    // A product on sale, and Sony puts none first: no other product is chosen in its place.
    expect(priceStardew.data.conceptRetrieve.products).toHaveLength(1)
    expect(parsePlaystationPrice(priceStardew, 227_229)).toBeNull()
  })

  it('reads no price for a concept the Ukrainian store does not have', () => {
    expect(priceUnknown.errors[0]!.extensions.errorCode).toBe(3_166_081)
    expect(parsePlaystationPrice(priceUnknown, 999_999_999)).toBeNull()
  })

  it('throws for the answer of a storefront that no longer knows the operation', () => {
    // It comes under a 400, and the transport fails it there; read as a body, it is no answer.
    expect(() => parsePlaystationPrice(priceNotRegistered, 227_770)).toThrow(
      'without the concept asked for',
    )
  })
})

const PRODUCT = 'EP0001-CUSA10601_00-AMBERTRAIL000001'
/** A price answer about `CONCEPT` whose default product has these ways of getting it. */
const answerWith = (webctas: unknown[], name: unknown = 'Amber Trail', id: unknown = PRODUCT) =>
  sonyPrice(CONCEPT, sonyProduct(CONCEPT, id as string, name as string, webctas))
const priceOf = (webctas: unknown[]) => parsePlaystationPrice(answerWith(webctas), CONCEPT)?.price

describe('parsePlaystationPrice, on every shape that is not a price anyone can pay', () => {
  it('reads the purchase where it stands alone', () => {
    expect(priceOf([sonyPurchase(79_900)])).toEqual({
      amount: 79_900,
      regularAmount: 79_900,
      discountPercent: 0,
      saleEndsAt: null,
    })
  })

  it.each([
    ['a trial', [sonyTrial()]],
    ['a PlayStation Plus catalogue entry', [sonyPlusCatalogue(79_900)]],
    ['a trial beside a catalogue entry', [sonyTrial(), sonyPlusCatalogue(79_900)]],
    [
      'a PlayStation Plus trial upsell',
      [
        sonyCta('UPSELL_PS_PLUS_TRIAL', 0, 0, {
          upSellService: 'PS_PLUS',
          price: {
            applicability: 'UPSELL',
            isExclusive: true,
            isTiedToSubscription: true,
            serviceBranding: ['PS_PLUS'],
          },
        }),
      ],
    ],
    [
      'an upsell of another subscription',
      [
        sonyCta('UPSELL_GTA_PLUS_FREE', 89_900, 0, {
          upSellService: 'GTA_PLUS',
          price: {
            applicability: 'UPSELL',
            isTiedToSubscription: true,
            serviceBranding: ['GTA_PLUS'],
          },
        }),
      ],
    ],
    ['a product that cannot be bought', [{ type: 'UNAVAILABLE', meta: {}, price: null }]],
    ['a pre-order, a type no recording has', [sonyCta('PREORDER', 79_900, 79_900)]],
    ['no way of getting the product at all', []],
  ])('reads no price from %s', (_what, webctas) => {
    expect(parsePlaystationPrice(answerWith(webctas), CONCEPT)).toBeNull()
  })

  it.each([
    ['tied to a subscription', { isTiedToSubscription: true }],
    ['branded with PlayStation Plus', { serviceBranding: ['PS_PLUS'] }],
    ['branded with PlayStation Plus beside nothing', { serviceBranding: ['NONE', 'PS_PLUS'] }],
    ['with no branding stated', { serviceBranding: [] }],
    ['exclusive', { isExclusive: true }],
    ['an upsell', { applicability: 'UPSELL' }],
    ['not said to be applicable', { applicability: undefined }],
    ['said to be free', { isFree: true }],
    ['not said to be tied to nothing', { isTiedToSubscription: undefined }],
  ])('reads no price from a purchase that is %s: a subscriber’s price', (_what, price) => {
    expect(priceOf([sonyPurchase(79_900, 39_950, { price })])).toBeUndefined()
  })

  it('reads no price from a purchase a service upsells, whatever its price says', () => {
    expect(priceOf([sonyPurchase(79_900, 39_950, { upSellService: 'PS_PLUS' })])).toBeUndefined()
  })

  it('reads no price from a purchase with a qualification, of any kind', () => {
    for (const type of ['USER_IN_EXPERIMENT', 'ENTITLEMENT_IN_CART', 'OWNS_PRODUCT']) {
      const qualified = sonyPurchase(79_900, 39_950, { qualifications: [{ type, value: 'x' }] })
      expect(priceOf([qualified]), type).toBeUndefined()
    }
    // Nor from one whose qualifications cannot be read as "none".
    expect(
      priceOf([sonyPurchase(79_900, 39_950, { price: { qualifications: null } })]),
    ).toBeUndefined()
  })

  it('reads no price in another currency', () => {
    expect(priceOf([sonyPurchase(1_999, 1_999, { currency: 'USD' })])).toBeUndefined()
    expect(priceOf([sonyPurchase(1_999, 1_999, { currency: 'uah' })])).toBeUndefined()
  })

  it('reads no price from amounts that are not whole kopecks', () => {
    for (const [base, discounted] of [
      [79_900, 399.5],
      ['79900', 39_950],
      [79_900, -1],
      [null, 39_950],
      [79_900, Number.NaN],
    ] as [unknown, unknown][]) {
      const entry = sonyPurchase(1, 1, {
        price: { basePriceValue: base, discountedValue: discounted, isFree: false },
      })
      expect(priceOf([entry]), `${String(base)} / ${String(discounted)}`).toBeUndefined()
    }
  })

  it('reads no price from a purchase that charges nothing, or a free game that charges', () => {
    expect(priceOf([sonyPurchase(79_900, 0, { price: { isFree: false } })])).toBeUndefined()
    expect(priceOf([sonyPurchase(0, 0, { price: { isFree: false } })])).toBeUndefined()
    expect(priceOf([sonyCta('DOWNLOAD', 79_900, 0)])).toBeUndefined()
    expect(priceOf([sonyCta('DOWNLOAD', 0, 0, { price: { isFree: false } })])).toBeUndefined()
    // The free game itself.
    expect(priceOf([sonyFreeDownload()])).toEqual({
      amount: 0,
      regularAmount: 0,
      discountPercent: 0,
      saleEndsAt: null,
    })
    expect(
      priceOf([sonyCta('DOWNLOAD', 0, 0, { price: { isTiedToSubscription: true } })]),
    ).toBeUndefined()
  })

  it('never puts the regular price below the price, and counts the discount from the two', () => {
    expect(priceOf([sonyPurchase(39_950, 79_900)])).toMatchObject({
      amount: 79_900,
      regularAmount: 79_900,
      discountPercent: 0,
    })
    expect(priceOf([sonyPurchase(259_900, 64_975)])).toMatchObject({ discountPercent: 75 })
    // Never 100 % beside a price, never 0 % beside a higher regular price.
    expect(priceOf([sonyPurchase(1_000_000, 1)])).toMatchObject({ discountPercent: 99 })
    expect(priceOf([sonyPurchase(100_000, 99_999)])).toMatchObject({ discountPercent: 1 })
  })

  it('takes the end of a sale only from epoch milliseconds, and only for a sale', () => {
    const endOf = (endTime: unknown, discounted = 39_950) =>
      priceOf([sonyPurchase(79_900, discounted, { price: { endTime } })])?.saleEndsAt

    expect(endOf(JOB_PLAYSTATION_SALE_ENDS)).toBe(JOB_PLAYSTATION_SALE_ENDS_AT)
    // An instant, whatever zone the job runs in: there is none in the value to read wrongly.
    expect(endOf('1792623540000')).toBe('2026-10-21T22:59:00.000Z')
    for (const unreadable of [
      null,
      undefined,
      '',
      '2026-10-21T22:59:00',
      '2026-10-21T22:59:00Z',
      '21.10.2026 10:59 PM UTC',
      '1792623540',
      1_792_623_540_000,
      '99999999999999',
      '-1792623540000',
    ]) {
      expect(endOf(unreadable), String(unreadable)).toBeNull()
    }
    // A price that is the regular price has no sale to end, whatever the entry says.
    expect(endOf(JOB_PLAYSTATION_SALE_ENDS, 79_900)).toBeNull()
  })

  it('wants several purchases to agree to the kopeck, and takes the earlier end of two', () => {
    const until = (endTime: string) => sonyPurchase(79_900, 39_950, { endTime })
    expect(priceOf([until('1792623540000'), until('1792000000000')])).toEqual({
      amount: 39_950,
      regularAmount: 79_900,
      discountPercent: 50,
      saleEndsAt: '2026-10-14T17:46:40.000Z',
    })
    expect(priceOf([sonyPurchase(79_900, 39_950), until('1792623540000')])?.saleEndsAt).toBe(
      JOB_PLAYSTATION_SALE_ENDS_AT,
    )
    expect(priceOf([sonyPurchase(79_900, 39_950), sonyPurchase(79_900, 39_949)])).toBeUndefined()
    expect(priceOf([sonyPurchase(79_900), sonyPurchase(89_900, 79_900)])).toBeUndefined()
    expect(playstationPurchasePrice('webctas')).toBeNull()
  })

  it('reads no price for a product whose id is not one it can make an address of', () => {
    for (const id of ['EP0001-CUSA10601_00-AMBERTRAIL', 'x/../y', '', 7, null]) {
      expect(
        parsePlaystationPrice(answerWith([sonyPurchase(79_900)], 'Amber Trail', id), CONCEPT),
      ).toBeNull()
    }
    expect(playstationProductUrl(PRODUCT)).toBe(
      `https://store.playstation.com/uk-ua/product/${PRODUCT}`,
    )
  })

  it('passes the product’s name through the title rule, and publishes a price without one', () => {
    const titled = (name: unknown) =>
      parsePlaystationPrice(answerWith([sonyPurchase(79_900)], name), CONCEPT)

    expect(titled('  Amber\n Trail​ ')?.title).toBe('Amber Trail')
    expect(titled('<img src=x onerror=alert(1)>')?.title).toBe('<img src=x onerror=alert(1)>')
    expect(titled('x'.repeat(300))?.title).toHaveLength(200)
    for (const none of ['', '   ', '™®', 42, null]) {
      expect(titled(none), String(none)).toMatchObject({ title: null, price: { amount: 79_900 } })
    }
  })
})

describe('parsePlaystationPrice, on an answer that is no answer', () => {
  const concept = (fields: Record<string, unknown>) => ({
    data: { conceptRetrieve: { id: String(CONCEPT), ...fields } },
  })

  it.each([
    ['nothing', null],
    ['a list', []],
    ['a page', '<!DOCTYPE html>'],
    ['an object with no data', {}],
    ['data with no concept in it', { data: {} }],
    ['a concept of nothing, with no error to say why', { data: { conceptRetrieve: null } }],
    ['another concept than the one asked for', sonyPrice(10_108, null)],
    [
      'a concept id that is a number',
      { data: { conceptRetrieve: { id: CONCEPT, defaultProduct: null } } },
    ],
    ['a concept with no word about its default product', concept({ products: [] })],
    ['a default product that is not an object', concept({ defaultProduct: 'EP0001' })],
    ['a default product with no ways of getting it', concept({ defaultProduct: { id: PRODUCT } })],
    [
      'a default product whose ways of getting it are not a list',
      concept({ defaultProduct: { id: PRODUCT, webctas: {} } }),
    ],
    [
      'a default product of another concept',
      sonyPrice(CONCEPT, sonyProduct(10_108, PRODUCT, 'Amber Trail', [sonyPurchase(79_900)])),
    ],
  ])('throws for %s, so that the offer the game had stays', (_what, body) => {
    expect(() => parsePlaystationPrice(body, CONCEPT)).toThrow(/^Sony answered/)
  })

  it('throws for errors, unless every one of them is "not in the store" over no concept', () => {
    const errors = (...codes: unknown[]) => ({
      errors: codes.map((errorCode) => ({ message: 'x', extensions: { errorCode } })),
      data: { conceptRetrieve: null },
    })

    expect(parsePlaystationPrice(errors(3_166_081), CONCEPT)).toBeNull()
    expect(parsePlaystationPrice(errors(3_166_081, 3_166_081), CONCEPT)).toBeNull()
    expect(() => parsePlaystationPrice(errors(3_165_000), CONCEPT)).toThrow(
      'Sony answered about a price with error 3165000',
    )
    for (const body of [
      errors(3_166_081, 3_165_000),
      errors('3166081'),
      errors(),
      { errors: 'PersistedQueryNotFound', data: null },
      { errors: [{ message: 'PersistedQueryNotFound' }] },
      // "Not in the store" beside a concept that is there is not that answer.
      { ...sonyNotInTheStore(CONCEPT), data: sonyPrice(CONCEPT, null).data },
      { ...sonyNotInTheStore(CONCEPT), data: null },
    ]) {
      expect(() => parsePlaystationPrice(body, CONCEPT)).toThrow(
        /^Sony answered about a price with error/,
      )
    }
  })

  it('never repeats Sony’s own words in what it throws', () => {
    const body = {
      errors: [{ message: 'x\n::error::injected', extensions: { errorCode: 'y\n::warning::z' } }],
    }
    const thrown = (() => {
      try {
        parsePlaystationPrice(body, CONCEPT)
      } catch (error) {
        return (error as Error).message
      }
    })()

    expect(thrown).toBe('Sony answered about a price with errors')
  })
})
