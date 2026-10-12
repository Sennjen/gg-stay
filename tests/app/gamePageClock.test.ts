import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { clearNuxtData, clearNuxtState } from '#app'
import GamePage from '~/pages/games/[slug].vue'
import { PARTIAL_RETRY_DELAYS_MS } from '~/composables/useRetryWhilePartial'

/**
 * The clock a game page's prices are aged against: the moment the answer on the page arrived.
 *
 * The page keeps that moment in a state that outlives it, because the server's value has to reach
 * the browser unchanged. These cases hold it to the three moments it may be read at, against a
 * stand-in for the BFF and a clock each case sets — nothing here waits for a real one.
 */

const SLUG = 'the-witcher-3-wild-hunt'
const ROUTE = `/games/${SLUG}`

/** Steam's price for the game, read at half past ten. */
const PRICE_READ_AT = '2026-10-12T10:30:00.000Z'

const GAME = {
  id: '3328',
  slug: SLUG,
  name: 'The Witcher 3: Wild Hunt',
  localizedDescription: null,
  released: '2015-05-18',
  rating: null,
  ratingsCount: null,
  metacritic: null,
  playtime: null,
  ageRating: null,
  gameModes: [],
  website: null,
  cover: null,
  screenshots: [],
  platformFamilies: ['PC'],
  platforms: [],
  genres: [],
  developers: [],
  publishers: [],
  stores: [
    {
      store: 'steam',
      url: 'https://store.steampowered.com/app/292030/',
      title: null,
      priceUah: 675,
      regularPriceUah: 1349,
      discountPercent: 50,
      isFree: false,
      updatedAt: PRICE_READ_AT,
      foreignPrice: null,
      foreignRegularPrice: null,
      approxUah: null,
      cheapest: false,
    },
  ],
  exchangeRate: null,
  localisation: null,
  madeInUkraine: false,
  similar: [],
  partial: false,
}

let answers: (typeof GAME)[] = []

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: () => {
    const game = answers.length > 1 ? answers.shift()! : answers[0]!
    return { data: { game } }
  },
})

/** The state the page keeps its clock in, as the rest of the session sees it. */
const clock = () => useState<string | undefined>('game-page-now')

const mounted = new Set<{ unmount: () => void }>()

/**
 * Brings the router to the page's address before the page is mounted there. Nuxt holds every
 * navigation back until the browser has had a chance to repaint, and waits for that on a timer;
 * on a fake clock that timer is moved by hand (as in `gamePagePartial.test.ts`).
 */
async function goTo(route: string): Promise<void> {
  const router = useRouter()
  if (router.currentRoute.value.fullPath === route) return
  let arrived = false
  const navigation = router.push(route).finally(() => (arrived = true))
  while (!arrived) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((turn) => setImmediate(turn))
  }
  await navigation
}

async function openGame(served: (typeof GAME)[] = [GAME]) {
  answers = [...served]
  await goTo(ROUTE)
  const wrapper = await mountSuspended(GamePage, { route: ROUTE })
  mounted.add(wrapper)
  await flushPromises()
  return wrapper
}

/** Both places a price says how old it is: the scoreboard, and the store's row. */
const agesOf = (wrapper: {
  text: () => string
  get: (selector: string) => { text: () => string }
}) => ({
  scoreboard: wrapper.get('dl').text(),
  row: wrapper.get('[data-test="store-row-steam"]').text(),
})

beforeEach(() => {
  // The page reads the clock through `Date`; its retry waits on a timeout.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount()
  mounted.clear()
  useNuxtApp().isHydrating = false
  vi.useRealTimers()
  clearNuxtData()
  clearNuxtState('game-page-now')
})

describe('the clock a game page’s prices are aged against', () => {
  it('is the moment this page’s answer arrived, not the session’s first game page', async () => {
    // The tab opened a game at ten. At half past one it opens this one, whose price was read at
    // half past ten: three hours ago, and not "just now", which is what ten o'clock would make it.
    clock().value = '2026-10-12T10:00:00.000Z'
    vi.setSystemTime('2026-10-12T13:30:00.000Z')

    const wrapper = await openGame()

    // Half past one, give or take the moment the router took to get here on this clock.
    const sinceHalfPastOne = Date.parse(clock().value!) - Date.parse('2026-10-12T13:30:00.000Z')
    expect(sinceHalfPastOne).toBeGreaterThanOrEqual(0)
    expect(sinceHalfPastOne).toBeLessThan(1_000)
    const ages = agesOf(wrapper)
    expect(ages.row).toContain('оновлено 3 години тому')
    expect(ages.scoreboard).toContain('оновлено 3 години тому')
    expect(ages.row).not.toContain('оновлено щойно')
  })

  it('is the server’s own while the browser takes the server’s markup over', async () => {
    // The server rendered at 13:30:00 and sent that in the payload. The browser gets to the page
    // two seconds later — and a clock read then would be another value than the markup was made
    // with, which is what a hydration mismatch is made of.
    clock().value = '2026-10-12T13:30:00.000Z'
    vi.setSystemTime('2026-10-12T13:30:02.000Z')
    useNuxtApp().isHydrating = true

    const wrapper = await openGame()

    expect(clock().value).toBe('2026-10-12T13:30:00.000Z')
    expect(agesOf(wrapper).row).toContain('оновлено 3 години тому')
  })

  it('moves when a later answer takes the page over in place', async () => {
    // A partial answer at half past one; the page asks again by itself. The whole answer comes
    // at five to five — the tab was asleep — and the same price is by then six hours old.
    vi.setSystemTime('2026-10-12T13:30:00.000Z')
    const wrapper = await openGame([{ ...GAME, partial: true }, GAME])
    expect(agesOf(wrapper).row).toContain('оновлено 3 години тому')

    vi.setSystemTime('2026-10-12T16:55:00.000Z')
    await vi.advanceTimersByTimeAsync(PARTIAL_RETRY_DELAYS_MS[0]!)
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      await flushPromises()
    }

    expect(Date.parse(clock().value!)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-12T16:55:00.000Z'),
    )
    const ages = agesOf(wrapper)
    expect(ages.row).toContain('оновлено 6 годин тому')
    expect(ages.scoreboard).toContain('оновлено 6 годин тому')
  })
})
