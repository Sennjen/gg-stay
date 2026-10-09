import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readBody } from 'h3'
import { defineComponent, h, onMounted, ref } from 'vue'
import { clearNuxtData } from '#app'
import GamePage from '~/pages/games/[slug].vue'

/**
 * The game page with an answer the server marked `partial`, against a stand-in for the BFF that
 * answers each request as the case scripts it: the one quiet line and what it says when, the two
 * attempts the page makes by itself, and what each kind of answer to them does to the page. The
 * clock is fake; the requests and the rendering run as they do in a browser.
 */

const SLUG = 'the-witcher-3-wild-hunt'
const ROUTE = `/games/${SLUG}`
/** The page's status region: there on every game page, with words in it only when it has any. */
const REGION = '[role="status"]'
/** The line itself, inside the region. */
const NOTE = '[data-test="game-partial-note"]'

/**
 * The page's words, read from the locale files as they are on disk. Imported as modules they
 * would arrive compiled, which is how the app wants them and not something to compare text with.
 */
interface Copy {
  game: { stillLoading: string; notLoaded: string; about: string; whereToBuy: string }
  gallery: { heading: string }
}
const copyOf = (locale: 'uk' | 'en'): Copy =>
  JSON.parse(readFileSync(resolve(process.cwd(), `i18n/locales/${locale}.json`), 'utf-8')) as Copy
const uk = copyOf('uk')
const en = copyOf('en')

const STEAM = {
  store: 'steam',
  url: 'https://store.steampowered.com/app/292030/',
  priceUah: 675,
  regularPriceUah: 1349,
  discountPercent: 50,
  isFree: false,
  updatedAt: null,
}

const GOG = {
  store: 'gog',
  url: 'https://www.gog.com/game/the_witcher_3_wild_hunt',
  priceUah: null,
  regularPriceUah: null,
  discountPercent: null,
  isFree: null,
  updatedAt: null,
}

const screenshot = (number: number) => ({
  url: `https://media.rawg.io/media/screenshots/20100${number}/full${number}.jpg`,
  width: 1920,
  height: 1080,
})

/** The page as the server builds it from the index alone, when RAWG has not answered in time. */
const PARTIAL = {
  id: '3328',
  slug: SLUG,
  name: 'The Witcher 3: Wild Hunt',
  localizedDescription: null,
  released: '2015-05-18',
  rating: 4.65,
  ratingsCount: 6800,
  metacritic: 92,
  playtime: 43,
  ageRating: 'PEGI18',
  gameModes: ['SINGLE'],
  website: null,
  cover: null,
  screenshots: [],
  platformFamilies: ['PC'],
  platforms: [],
  genres: [],
  developers: [],
  publishers: [],
  stores: [STEAM],
  localisation: { text: true, audio: true, source: 'steam' },
  madeInUkraine: false,
  similar: [],
  partial: true,
}

/** The same page once RAWG has answered: the description, the screenshots and the rest of it. */
const WHOLE = {
  ...PARTIAL,
  localizedDescription: {
    text: 'Geralt of Rivia looks for the child of prophecy.',
    language: 'en',
    source: 'RAWG',
  },
  website: 'https://thewitcher.com/en/witcher3',
  screenshots: [1, 2, 3].map(screenshot),
  genres: [{ id: '4', slug: 'action', name: 'Action' }],
  developers: [{ id: '9023', slug: 'cd-projekt-red', name: 'CD PROJEKT RED' }],
  publishers: [{ id: '7411', slug: 'cd-projekt-red', name: 'CD PROJEKT RED' }],
  stores: [STEAM, GOG],
  partial: false,
}

/** What RAWG's answer adds to the page built from the index. */
const WHOLE_PARTS = {
  localizedDescription: WHOLE.localizedDescription,
  website: WHOLE.website,
  screenshots: WHOLE.screenshots,
  genres: WHOLE.genres,
  developers: WHOLE.developers,
  publishers: WHOLE.publishers,
  stores: WHOLE.stores,
  partial: false,
}

type Game = typeof PARTIAL | typeof WHOLE

/**
 * What one request is answered with: a game, an error code inside an HTTP 200, or a game that is
 * held back until the case lets it go.
 */
type Reply = Game | { failsWith: string } | { game: Game; after: Promise<void> }

let replies: Reply[] = []
const asked: { slug: string; locale: string }[] = []

registerEndpoint('/api/graphql', {
  method: 'POST',
  handler: async (event) => {
    const body = (await readBody(event)) as { variables: { slug: string; locale: string } }
    asked.push(body.variables)
    const reply = replies.shift()
    if (!reply) throw new Error('the page asked more often than the case expected')
    if ('failsWith' in reply) {
      return {
        data: { game: null },
        errors: [{ message: 'Upstream', extensions: { code: reply.failsWith } }],
      }
    }
    if ('after' in reply) {
      await reply.after
      return { data: { game: reply.game } }
    }
    return { data: { game: reply } }
  },
})

/**
 * Brings the router to the page's address before the page is mounted there. Nuxt holds every
 * navigation back until the browser has had a chance to repaint, and waits for that on a timer
 * (its `navigation-repaint` plugin). On a fake clock that timer is moved by hand — here, before
 * the page exists, so that none of the page's own time goes on it.
 */
async function goTo(route: string): Promise<void> {
  const router = useRouter()
  if (router.currentRoute.value.fullPath === route) return
  let arrived = false
  const navigation = router.push(route).finally(() => (arrived = true))
  // A change of language loads its messages first, so the timer may be set at any later turn.
  while (!arrived) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise((turn) => setImmediate(turn))
  }
  await navigation
}

const mounted = new Set<{ unmount: () => void }>()

/**
 * The page as it was first rendered, before anything it does once it is mounted had reached the
 * screen. That is the markup a server sends for the same answer and the markup a browser builds to
 * take it over, so what is true of it is true of both.
 */
const firstRender: { html: string; region: Element | null } = { html: '', region: null }

/**
 * The page inside an element that looks at it the moment it is mounted: hooks run before the
 * render they cause, so what this one sees is the first render whatever the page's own hooks did.
 */
const WatchedGamePage = defineComponent({
  setup() {
    const root = ref<HTMLElement | null>(null)
    onMounted(() => {
      firstRender.html = root.value?.innerHTML ?? ''
      firstRender.region = root.value?.querySelector(REGION) ?? null
    })
    return () => h('div', { ref: root }, h(GamePage))
  },
})

async function renderGame(answers: Reply[], route = ROUTE) {
  replies = [...answers]
  await goTo(route)
  const wrapper = await mountSuspended(WatchedGamePage, { route })
  mounted.add(wrapper)
  await flushPromises()
  return wrapper
}

/** The visitor leaves the page. */
function leave(wrapper: { unmount: () => void }): void {
  mounted.delete(wrapper)
  wrapper.unmount()
}

/**
 * Moves the fake clock on and lets what became due finish: the request, its answer and the render
 * that follows. A real turn of the event loop is part of it — `setImmediate` is not faked.
 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    await flushPromises()
  }
}

beforeEach(() => {
  // Only the timeouts are faked, and from before the mount: the wait starts when the page mounts.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  for (const wrapper of [...mounted]) leave(wrapper)
  vi.useRealTimers()
  replies = []
  asked.length = 0
  firstRender.html = ''
  firstRender.region = null
  clearNuxtData()
})

describe('a game page whose answer is partial', () => {
  it('says in one quiet line that some of the page is still loading', async () => {
    const wrapper = await renderGame([PARTIAL])
    const region = wrapper.get(REGION)
    const note = wrapper.get(NOTE)

    expect(note.text()).toBe(uk.game.stillLoading)
    // Announced politely, by the one status region the page has, which holds nothing else.
    expect(wrapper.findAll('[role="status"], [aria-live]')).toHaveLength(1)
    expect(region.element.contains(note.element)).toBe(true)
    expect(region.text()).toBe(uk.game.stillLoading)
    // Near the top: inside the article, before its heading.
    const article = wrapper.get('article').element
    expect(article.firstElementChild).toBe(region.element)
    // And out of the flow, over the cover, so it takes no room and moves nothing.
    expect(region.classes()).toContain('absolute')
  })

  it('says it in English on the English page', async () => {
    const wrapper = await renderGame([PARTIAL], `/en${ROUTE}`)
    expect(wrapper.get(NOTE).text()).toBe('Some of this page is still loading…')
    expect(en.game.stillLoading).toBe('Some of this page is still loading…')
    expect(asked).toEqual([{ slug: SLUG, locale: 'en' }])
  })

  it('is first rendered with its status region empty, and puts the sentence into that region once mounted', async () => {
    const wrapper = await renderGame([PARTIAL])

    // The first render — what a server sends, and what a browser builds over it — is the partial
    // page, with the region and without a word in it: no "still loading" for a crawler to read.
    expect(firstRender.html).toContain('The Witcher 3: Wild Hunt')
    expect(firstRender.html).not.toContain(uk.game.stillLoading)
    expect(firstRender.html).not.toContain('game-partial-note')
    const first = document.createElement('div')
    first.innerHTML = firstRender.html
    const regions = first.querySelectorAll(REGION)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.textContent).toBe('')
    expect(regions[0]!.children).toHaveLength(0)

    // The sentence arrives in the region that was already there, which is what gets it announced.
    expect(wrapper.get(REGION).element).toBe(firstRender.region)
    expect(wrapper.get(REGION).text()).toBe(uk.game.stillLoading)
  })

  it('renders every section it has data for, and none it has not', async () => {
    const wrapper = await renderGame([PARTIAL])
    expect(wrapper.get('h1').text()).toBe('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain(uk.game.whereToBuy)
    expect(wrapper.text()).not.toContain(uk.game.about)
    expect(wrapper.text()).not.toContain(uk.gallery.heading)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('asks again by itself three seconds later, for the same game in the same language', async () => {
    await renderGame([PARTIAL, WHOLE])
    expect(asked).toHaveLength(1)

    await advance(2_999)
    expect(asked).toHaveLength(1)
    await advance(1)
    expect(asked).toEqual([
      { slug: SLUG, locale: 'uk' },
      { slug: SLUG, locale: 'uk' },
    ])
  })

  it('lets the whole answer take the page over in place: the line goes and the rest arrives', async () => {
    const wrapper = await renderGame([PARTIAL, WHOLE])
    const article = wrapper.get('article').element
    const heading = wrapper.get('h1').element
    const stores = wrapper.get('#where-to-buy').element

    const region = wrapper.get(REGION).element

    await advance(3_000)

    // The line goes; the region it was in stays, with nothing in it to say or to see.
    expect(wrapper.find(NOTE).exists()).toBe(false)
    expect(wrapper.get(REGION).element).toBe(region)
    expect(region.textContent).toBe('')
    expect(region.children).toHaveLength(0)
    expect(wrapper.text()).toContain(uk.game.about)
    expect(wrapper.text()).toContain('Geralt of Rivia looks for the child of prophecy.')
    expect(wrapper.findAll('#screenshot-gallery-heading ~ ul li')).toHaveLength(3)
    expect(wrapper.text()).toContain('CD PROJEKT RED')
    expect(wrapper.findAll('#where-to-buy ~ ul li')).toHaveLength(2)
    // In place: what was on the page is still the same elements, not a page built again.
    expect(wrapper.get('article').element).toBe(article)
    expect(wrapper.get('h1').element).toBe(heading)
    expect(wrapper.get('#where-to-buy').element).toBe(stores)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    // And that was the end of it: nothing more is asked, however long the page stays open.
    await advance(60_000)
    expect(asked).toHaveLength(2)
  })

  it('asks once more six seconds after a second partial answer, and then says that the rest did not load', async () => {
    const wrapper = await renderGame([PARTIAL, PARTIAL, PARTIAL])
    const region = wrapper.get(REGION).element
    const note = wrapper.get(NOTE).element

    await advance(3_000)
    expect(asked).toHaveLength(2)
    // One attempt left: the line is the element it was, with the words it had — said once.
    expect(wrapper.get(NOTE).element).toBe(note)
    expect(wrapper.get(NOTE).text()).toBe(uk.game.stillLoading)

    await advance(5_999)
    expect(asked).toHaveLength(2)
    expect(wrapper.get(NOTE).text()).toBe(uk.game.stillLoading)
    await advance(1)
    expect(asked).toHaveLength(3)

    // Nothing is loading any more, and the line stops saying that something is. The same line in
    // the same region, with new words: a second announcement, and the last.
    expect(wrapper.get(NOTE).text()).toBe(uk.game.notLoaded)
    expect(uk.game.notLoaded).toBe(
      'Частина даних не завантажилася. Спробуйте оновити сторінку пізніше.',
    )
    expect(wrapper.get(NOTE).element).toBe(note)
    expect(wrapper.get(REGION).element).toBe(region)
    expect(wrapper.findAll('[role="status"], [aria-live]')).toHaveLength(1)
    // The page under it is as it was.
    expect(wrapper.get('h1').text()).toBe('The Witcher 3: Wild Hunt')
    expect(wrapper.text()).toContain(uk.game.whereToBuy)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    await advance(60_000)
    expect(asked).toHaveLength(3)
    expect(wrapper.get(NOTE).text()).toBe(uk.game.notLoaded)
  })

  it('says so in English on the English page', async () => {
    const wrapper = await renderGame([PARTIAL, PARTIAL, PARTIAL], `/en${ROUTE}`)
    await advance(3_000)
    await advance(6_000)
    expect(wrapper.get(NOTE).text()).toBe("Some of this page didn't load. Try reloading it later.")
    expect(en.game.notLoaded).toBe("Some of this page didn't load. Try reloading it later.")
  })

  it.each([
    ['fail', { failsWith: 'UPSTREAM_TIMEOUT' }],
    // The index still holds a game RAWG has dropped: the page was built from the index, and each
    // attempt is told there is no such game.
    ['are told there is no such game', { failsWith: 'NOT_FOUND' }],
  ])(
    'says that the rest did not load when both attempts %s, and puts no error in place of the page',
    async (_what, failure) => {
      const wrapper = await renderGame([PARTIAL, failure, failure])
      const heading = wrapper.get('h1').element

      await advance(3_000)
      expect(wrapper.get(NOTE).text()).toBe(uk.game.stillLoading)
      await advance(6_000)
      expect(asked).toHaveLength(3)

      expect(wrapper.get(NOTE).text()).toBe(uk.game.notLoaded)
      expect(wrapper.get('h1').element).toBe(heading)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      await advance(60_000)
      expect(asked).toHaveLength(3)
    },
  )

  it('takes the whole answer of the second attempt when the first stayed partial', async () => {
    const wrapper = await renderGame([PARTIAL, PARTIAL, WHOLE])

    await advance(3_000)
    expect(wrapper.find(NOTE).exists()).toBe(true)
    expect(wrapper.text()).not.toContain(uk.game.about)

    await advance(6_000)
    expect(wrapper.find(NOTE).exists()).toBe(false)
    expect(wrapper.text()).toContain(uk.game.about)
    await advance(60_000)
    expect(asked).toHaveLength(3)
  })

  it('stays as it is when an attempt fails: no error in place of the page, and the next attempt still comes', async () => {
    const wrapper = await renderGame([PARTIAL, { failsWith: 'UPSTREAM_TIMEOUT' }, WHOLE])
    const heading = wrapper.get('h1').element

    await advance(3_000)
    expect(asked).toHaveLength(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('h1').element).toBe(heading)
    expect(wrapper.find(NOTE).exists()).toBe(true)

    await advance(6_000)
    expect(asked).toHaveLength(3)
    expect(wrapper.find(NOTE).exists()).toBe(false)
    expect(wrapper.text()).toContain(uk.game.about)
  })

  // That the timer itself is cleared is counted in `useRetryWhilePartial.test.ts`; a mounted page
  // has the framework's own timers beside it. Here it is what a cleared timer means: no request.
  it('asks nothing once the visitor has left the page', async () => {
    const wrapper = await renderGame([PARTIAL, WHOLE])
    await advance(1_000)

    leave(wrapper)
    await advance(60_000)
    expect(asked).toHaveLength(1)
  })

  it('asks nothing more when the visitor leaves between the two attempts', async () => {
    const wrapper = await renderGame([PARTIAL, PARTIAL, WHOLE])
    await advance(3_000)
    expect(asked).toHaveLength(2)

    leave(wrapper)
    await advance(60_000)
    expect(asked).toHaveLength(2)
  })
})

describe('a game page that turns to another game', () => {
  it('asks nothing more for the game it has left, even while the next one is still loading', async () => {
    let arrive = () => {}
    const held = new Promise<void>((resolve) => {
      arrive = resolve
    })
    const PORTAL = { ...WHOLE, id: '4200', slug: 'portal-2', name: 'Portal 2' }
    const wrapper = await renderGame([PARTIAL, { game: PORTAL, after: held }])
    await advance(1_000)

    // The same page, asked for another game: its own request for it goes out at once.
    await goTo('/games/portal-2')
    expect(asked.map((variables) => variables.slug)).toEqual([SLUG, 'portal-2'])

    // The partial answer stays on screen while the new one loads, and its three seconds run out
    // in the meantime. Nothing is asked for it — which would be asked about the new game by now —
    // and so the line that said it was being asked for is gone.
    expect(wrapper.get('h1').text()).toBe('The Witcher 3: Wild Hunt')
    expect(wrapper.find(NOTE).exists()).toBe(false)
    await advance(10_000)
    expect(asked).toHaveLength(2)

    arrive()
    await advance(0)
    expect(wrapper.get('h1').text()).toBe('Portal 2')
    expect(wrapper.find(NOTE).exists()).toBe(false)
    await advance(60_000)
    expect(asked).toHaveLength(2)
  })

  it('starts its count again for the next game’s own partial answer', async () => {
    const PORTAL = { ...PARTIAL, id: '4200', slug: 'portal-2', name: 'Portal 2' }
    const wrapper = await renderGame([PARTIAL, PARTIAL, PORTAL, { ...PORTAL, ...WHOLE_PARTS }])
    // One of the first game's two attempts is spent before the page turns.
    await advance(3_000)
    expect(asked).toHaveLength(2)

    await goTo('/games/portal-2')
    await advance(0)
    expect(wrapper.get('h1').text()).toBe('Portal 2')
    expect(wrapper.find(NOTE).exists()).toBe(true)
    expect(asked.map((variables) => variables.slug)).toEqual([SLUG, SLUG, 'portal-2'])

    // Three seconds after the new game's answer, not six: the attempts are the answer's own.
    await advance(3_000)
    expect(asked.map((variables) => variables.slug)).toEqual([SLUG, SLUG, 'portal-2', 'portal-2'])
    expect(wrapper.find(NOTE).exists()).toBe(false)
    expect(wrapper.text()).toContain(uk.game.about)
  })
})

describe('a game page whose answer is whole', () => {
  it('has no such line, and asks nothing more', async () => {
    const wrapper = await renderGame([WHOLE])

    expect(wrapper.find(NOTE).exists()).toBe(false)
    // The region is there all the same, empty: a page cannot know it will never need it.
    expect(wrapper.get(REGION).text()).toBe('')
    expect(wrapper.get(REGION).element.children).toHaveLength(0)
    expect(wrapper.text()).toContain(uk.game.about)
    await advance(60_000)
    expect(asked).toHaveLength(1)
  })
})

describe('a game page that could not be answered', () => {
  it('shows its error and leaves the asking to the visitor', async () => {
    const wrapper = await renderGame([{ failsWith: 'UPSTREAM_TIMEOUT' }])

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.find(NOTE).exists()).toBe(false)
    await advance(60_000)
    expect(asked).toHaveLength(1)
  })
})
