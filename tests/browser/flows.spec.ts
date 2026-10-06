import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { expect, expectAccessible, test, waitForHydration } from './fixtures'

/**
 * The smoke flows of the quality gate, against the fixture-mode production build. The data is
 * the recorded RAWG fixtures plus the in-memory index the fixture mode seeds: the plain catalog has
 * four games, a 1 000 ₴ ceiling widens it to the index's seven, and Ukrainian localisation narrows
 * those to three. Every flow also fails on a console error (see `fixtures.ts`).
 */

const WITCHER = '/games/the-witcher-3-wild-hunt'

/** The game page's own request to the BFF: the `Game` operation, sent from the browser. */
function isGameQuery(request: Request): boolean {
  if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/graphql') {
    return false
  }
  const body = request.postDataJSON() as { query?: string } | null
  return /\bquery Game\b/.test(body?.query ?? '')
}

/** The Ukrainian words of the game page, read from the locale file the page itself renders. */
const copy = JSON.parse(readFileSync(resolve(process.cwd(), 'i18n/locales/uk.json'), 'utf-8')) as {
  game: { stillLoading: string; about: string }
  gallery: { heading: string }
}

/**
 * Answers the page's request with what the server sends when RAWG is late: the real answer, cut
 * down on its way to the browser to the page built from the index document. The fixture build
 * answers at once, so no answer of its own is ever partial.
 */
async function answerInPart(route: Route): Promise<void> {
  const response = await route.fetch()
  const body = (await response.json()) as {
    data: { game: { screenshots: unknown[]; stores: { store: string }[] } }
  }
  const game = body.data.game
  await route.fulfill({
    response,
    json: {
      data: {
        game: {
          ...game,
          partial: true,
          localizedDescription: null,
          website: null,
          screenshots: game.screenshots.slice(0, 1),
          platforms: [],
          genres: [],
          developers: [],
          publishers: [],
          stores: game.stores.filter((offer) => offer.store === 'steam'),
        },
      },
    },
  })
}

/**
 * Opens the Witcher's page from the catalog on a clock that moves only when the flow moves it.
 *
 * The page counts its three and its six seconds on its own clock. Left running, that clock goes on
 * through whatever the flow does between the page mounting and the flow looking at it, and a
 * runner that stalls there finds the page's second request already made. So the clock is stopped
 * before the click and the navigation is taken through by hand — Nuxt holds every navigation until
 * the browser has had a frame to repaint in, which is a timer of the page's. That stretch is over
 * when the page's request is out; the page is not mounted before its answer, so none of its own
 * time has gone by then.
 */
async function openWitcherOnAStoppedClock(page: Page, asked: () => number): Promise<void> {
  // Installed, the clock still runs with the real one until it is paused.
  await page.clock.install()
  await page.goto('/games')
  await waitForHydration(page)
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100)

  const answered = page.waitForResponse((response) => isGameQuery(response.request()))
  await page.locator(`a[href="${WITCHER}"]`).first().click()
  await expect
    .poll(
      async () => {
        if (asked() === 0) await page.clock.runFor(50)
        return asked()
      },
      { intervals: [10] },
    )
    .toBe(1)
  await answered
}

/**
 * Runs something that waits on the page's own timers — axe yields to one between any two rules —
 * while the stopped clock is moved under it a millisecond at a time, and by no more than
 * `budgetMs` in all. Out of budget the clock stays where it is and the work, if it still needs a
 * timer, runs into the flow's timeout: the page's own waits are never reached by accident.
 */
async function onTheStoppedClock(
  page: Page,
  budgetMs: number,
  work: () => Promise<void>,
): Promise<void> {
  let done = false
  const finished = work().finally(() => {
    done = true
  })
  // Whatever the work ends with is reported once, below; the loop only needs to know it has ended.
  finished.catch(() => {})
  for (let moved = 0; !done; moved += 1) {
    if (moved < budgetMs) await page.clock.runFor(1)
    await new Promise((turn) => setTimeout(turn, 10))
  }
  await finished
}

/** The line over the cover, and the two things it must keep clear of: checked for each sentence. */
async function expectLineOverTheCover(page: Page, note: Locator): Promise<void> {
  const hero = (await page.locator('article > div:not([role="status"])').first().boundingBox())!
  const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!
  const line = (await note.boundingBox())!
  // It takes no room: it is inside the hero's box, above the title, and within the page's width.
  expect(line.y).toBeGreaterThanOrEqual(hero.y)
  expect(line.y + line.height).toBeLessThan(title.y)
  expect(line.x).toBeGreaterThanOrEqual(0)
  expect(line.x + line.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}

/** The catalog's "Знайдено: N" / "Found: N" line, as a number. */
async function resultTotal(page: Page): Promise<number> {
  const text = await page.locator('main p[aria-live="polite"]').first().innerText()
  return Number(text.replace(/\D/g, ''))
}

test('landing → the "Усі ігри" link of a shelf → the catalog it names', async ({ page }) => {
  await page.goto('/')
  await waitForHydration(page)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ігри, які варто знайти' }),
  ).toBeVisible()
  await expectAccessible(page, 'landing')

  const shelf = page.locator('[data-test="shelf-MADE_IN_UKRAINE"]')
  await shelf.getByRole('link', { name: 'Усі ігри', exact: true }).click()

  await expect(page).toHaveURL(/\/games\?madeInUkraine=1$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Каталог ігор' })).toBeVisible()
  await expect(page.getByText('S.T.A.L.K.E.R.: Shadow of Chernobyl').first()).toBeVisible()
  await expectAccessible(page, 'catalog filtered by a shelf')
})

test('landing → Gege rises with the deal → dismissed to a grip → reopened → «Давай» opens the ask page', async ({
  page,
}) => {
  await page.goto('/')
  await waitForHydration(page)
  // He is no part of the server HTML or of the hydrated page: he comes later, by himself.
  const greeter = page.getByRole('complementary', { name: 'Ґеґе, помічник із підбору ігор' })
  await expect(greeter).toHaveCount(0)

  // Two seconds on screen, up to three more for a slow deal, plus idle and his chunk.
  const bubble = page.locator('[data-test="gege-bubble"]')
  await expect(bubble).toBeVisible({ timeout: 15_000 })
  // Appearing must not move focus: it is still where a fresh page leaves it.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  // The fixture index has one game that qualifies as the deal of the day.
  await expect(bubble.getByRole('link', { name: 'Portal 2' })).toHaveAttribute(
    'href',
    '/games/portal-2',
  )
  await expect(bubble).toContainText('−75%')
  // He fades in; axe reads a half-faded bubble as low contrast.
  await expect(bubble).toHaveCSS('opacity', '1')
  await expectAccessible(page, 'landing with the greeter open')

  // Escape with focus inside dismisses him, and focus follows to the grip he leaves behind.
  await bubble.getByRole('button', { name: 'Не зараз' }).focus()
  await page.keyboard.press('Escape')
  await expect(bubble).toBeHidden()
  const grip = greeter.getByRole('button', { name: 'Ґеґе: AI-підбір' })
  await expect(grip).toBeFocused()
  await expect(grip).toHaveAttribute('aria-expanded', 'false')
  await expectAccessible(page, 'landing with the greeter dismissed')

  // The grip opens the bubble again from the keyboard, and Tab walks on into it.
  await page.keyboard.press('Enter')
  await expect(bubble).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(bubble.getByRole('link', { name: 'Portal 2' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(bubble.getByRole('link', { name: 'Давай' })).toBeFocused()

  await bubble.getByRole('button', { name: 'Не зараз' }).click()
  await expect(bubble).toBeHidden()

  // Dismissed once, he does not rise by himself again in this session: only the grip is back.
  await page.reload()
  await waitForHydration(page)
  await expect(grip).toBeVisible()
  await page.waitForTimeout(3500)
  await expect(bubble).toBeHidden()

  await grip.click()
  await bubble.getByRole('link', { name: 'Давай' }).click()
  await expect(page).toHaveURL(/\/ask$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(greeter).toHaveCount(0)
})

/** Whether two boxes on the page share any pixel. */
function overlap(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (!a || !b) throw new Error('an element to compare has no box')
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test('landing on a phone → Gege rises with one line clear of the hero → a tap opens the bubble → left alone on a return, he stays down', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto('/')
  await waitForHydration(page)

  const greeter = page.getByRole('complementary', { name: 'Ґеґе, помічник із підбору ігор' })
  const line = greeter.getByRole('button', { name: 'Привіт! Підібрати гру?' })
  const bubble = page.locator('[data-test="gege-bubble"]')
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(bubble).toHaveCount(0)
  await expect(line).toHaveCSS('opacity', '1')
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  // Left alone the line sinks after eight seconds, and the checks below must not race it: he
  // stays up while keyboard focus is on the line.
  await line.focus()

  // The line and Gege keep off the hero's headline and its two actions, and the line is a
  // comfortable target.
  const hero = page.locator('main section').first()
  const lineBox = await line.boundingBox()
  const gegeBox = await page.locator('[data-test="gege-toggle"]').boundingBox()
  expect(lineBox!.height).toBeGreaterThanOrEqual(44)
  for (const part of [
    hero.getByRole('heading', { level: 1 }),
    hero.getByRole('link', { name: 'Відкрити каталог' }),
    hero.getByRole('link', { name: 'Нові релізи' }),
  ]) {
    const box = await part.boundingBox()
    expect(overlap(lineBox, box)).toBe(false)
    expect(overlap(gegeBox, box)).toBe(false)
  }
  await expectAccessible(page, 'phone landing with the greeter line')

  await line.click()
  await expect(bubble).toBeVisible()
  await expect(line).toHaveCount(0)
  await expect(bubble.getByRole('link', { name: 'Portal 2' })).toBeVisible()
  await expect(bubble.getByRole('link', { name: 'Давай' })).toBeVisible()
  await expect(bubble.getByRole('button', { name: 'Не зараз' })).toBeVisible()
  await expect(bubble).toHaveCSS('opacity', '1')
  await expectAccessible(page, 'phone landing with the greeter bubble open')

  // A short screen cannot hold the copy: it scrolls in a box the keyboard can reach, under the
  // header, with the buttons still on screen.
  await page.setViewportSize({ width: 320, height: 256 })
  const copy = bubble.locator('[data-test="gege-copy"]')
  await expect(copy).toHaveAttribute('tabindex', '0')
  const header = await page.locator('header').first().boundingBox()
  const bubbleBox = await bubble.boundingBox()
  expect(bubbleBox!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
  await expect(bubble.getByRole('link', { name: 'Давай' })).toBeInViewport()
  await expectAccessible(page, 'short phone landing with the greeter bubble scrolling')

  // He rose once this session without being dismissed; back on the landing he stays down.
  await page.setViewportSize({ width: 375, height: 667 })
  await page.reload()
  await waitForHydration(page)
  await expect(greeter.getByRole('button', { name: 'Ґеґе: AI-підбір' })).toBeVisible()
  await page.waitForTimeout(3500)
  await expect(line).toHaveCount(0)
  await expect(bubble).toHaveCount(0)
})

test('catalog → filter drawer → price and localisation change the count → a game', async ({
  page,
}) => {
  await page.goto('/games')
  await waitForHydration(page)
  await expectAccessible(page, 'catalog')
  const before = await resultTotal(page)

  await page.getByRole('button', { name: 'Фільтри', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Фільтри' })
  await expect(drawer).toBeVisible()
  await expectAccessible(page, 'filter drawer')

  await drawer.getByRole('button', { name: 'Ціна', exact: true }).click()
  await drawer.getByRole('button', { name: /^до 1\s?000/ }).click()
  await expect(page).toHaveURL(/priceMaxUah=1000/)
  // A ceiling switches the catalog to the price index, which holds more games than the plain
  // RAWG fixture page (4 → 7); a drop here would mean the index answered nothing.
  await expect.poll(() => resultTotal(page)).toBeGreaterThan(before)
  const withPrice = await resultTotal(page)

  await drawer.getByRole('button', { name: 'Українська локалізація', exact: true }).click()
  await drawer.getByRole('radio', { name: 'Будь-яка' }).click()
  await expect(page).toHaveURL(/ukrainianLocalisation=ANY/)
  // Localisation narrows the indexed set (7 → 3), never to nothing.
  await expect.poll(() => resultTotal(page)).toBeLessThan(withPrice)
  expect(await resultTotal(page)).toBeGreaterThan(0)
  const filtered = await resultTotal(page)
  await expectAccessible(page, 'filter drawer with price and localisation applied')

  await drawer.getByRole('button', { name: new RegExp(`^Показати ${filtered}\\s`) }).click()
  await expect(drawer).toBeHidden()

  const firstCard = page.locator('[data-test="game-card"]').first()
  const title = (await firstCard.getByRole('heading').innerText()).trim()
  await firstCard.getByRole('link').first().click()
  await expect(page).toHaveURL(/\/games\/[^/?]+$/)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expectAccessible(page, 'game page opened from the catalog')
})

test('game page → screenshot lightbox opens, pages and closes from the keyboard', async ({
  page,
}) => {
  await page.goto(WITCHER)
  await waitForHydration(page)
  await expectAccessible(page, 'game page')

  const gallery = page.getByRole('region', { name: 'Скріншоти' })
  const firstThumbnail = gallery.getByRole('button').first()
  await firstThumbnail.focus()
  await page.keyboard.press('Enter')

  const lightbox = page.getByRole('dialog', { name: /^Перегляд скріншотів:/ })
  await expect(lightbox).toBeVisible()
  await expect(lightbox.getByRole('button', { name: 'Закрити' })).toBeFocused()
  // The dot of the screenshot on show carries aria-current.
  const shown = lightbox.locator('[aria-current="true"]')
  await expect(shown).toHaveAccessibleName(/^Скріншот 1 з \d+$/)
  await expectAccessible(page, 'screenshot lightbox')

  await page.keyboard.press('ArrowRight')
  await expect(shown).toHaveAccessibleName(/^Скріншот 2 з \d+$/)
  await page.keyboard.press('ArrowLeft')
  await expect(shown).toHaveAccessibleName(/^Скріншот 1 з \d+$/)

  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()
  await expect(firstThumbnail).toBeFocused()
})

test('catalog → a game: the answer to the page’s own request says where its time went', async ({
  page,
}) => {
  await page.goto('/games')
  await waitForHydration(page)

  // Opened from the catalog, the page is rendered in the browser, so its request is one the
  // network panel shows — the first render of a page asks on the server instead.
  const answered = page.waitForResponse((response) => isGameQuery(response.request()))
  await page.locator(`a[href="${WITCHER}"]`).first().click()
  const response = await answered
  await expect(
    page.getByRole('heading', { level: 1, name: 'The Witcher 3: Wild Hunt' }),
  ).toBeVisible()

  expect(response.status()).toBe(200)
  // Fixture mode's upstreams are its recordings and its seeded index: RAWG's three answers about
  // the page, Steam's Ukrainian description, and the index's reads for the page and its row of
  // similar games. Names and numbers, and nothing of the request.
  expect(response.headers()['server-timing']).toMatch(
    /^rawg;dur=\d+;desc="RAWG x3", steam;dur=\d+;desc="Steam x1", index;dur=\d+;desc="Index x[1-9]\d*", total;dur=\d+$/,
  )
  // The policy of the endpoint is still beside it.
  expect(response.headers()['content-security-policy']).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  )

  // And the browser reads it as server timing, which is what its network panel draws.
  const metrics = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((entry) => new URL(entry.name).pathname === '/api/graphql')
      .flatMap((entry) => entry.serverTiming.map((metric) => metric.name)),
  )
  expect(metrics).toEqual(expect.arrayContaining(['rawg', 'steam', 'index', 'total']))
})

test('a game opened with a partial answer → one quiet line → the page asks again by itself → the whole page, and nothing above it has moved', async ({
  page,
}) => {
  // The first answer to the page's request is the partial one; every later one passes untouched.
  let asked = 0
  await page.route('**/api/graphql', async (route) => {
    if (!isGameQuery(route.request())) return route.fallback()
    asked += 1
    return asked === 1 ? answerInPart(route) : route.fallback()
  })
  await openWitcherOnAStoppedClock(page, () => asked)

  const title = page.getByRole('heading', { level: 1, name: 'The Witcher 3: Wild Hunt' })
  await expect(title).toBeVisible()
  const note = page.locator('[data-test="game-partial-note"]')
  await expect(note).toHaveText(copy.game.stillLoading)
  await expect(note).toBeVisible()
  await expect(page.getByRole('heading', { name: copy.game.about })).toHaveCount(0)

  await expectLineOverTheCover(page, note)
  const hero = page.locator('article > div:not([role="status"])').first()
  const scoreboard = page.locator('article dl').first()
  const before = {
    hero: await hero.boundingBox(),
    title: await title.boundingBox(),
    scoreboard: await scoreboard.boundingBox(),
    scrollY: await page.evaluate(() => window.scrollY),
  }

  // The audit is of the partial page: two seconds of the page's three is all the clock is given
  // under it, so the second request cannot have been made meanwhile — and was not.
  await onTheStoppedClock(page, 2_000, () =>
    expectAccessible(page, 'game page with a partial answer'),
  )
  expect(asked).toBe(1)
  await expect(note).toHaveText(copy.game.stillLoading)

  // Three seconds on, the page asks again; the whole answer takes the partial one's place.
  await page.clock.fastForward(3_000)
  await expect(note).toHaveCount(0)
  await expect(page.getByRole('heading', { name: copy.game.about })).toBeVisible()
  const gallery = page.getByRole('region', { name: copy.gallery.heading })
  expect(await gallery.getByRole('button').count()).toBeGreaterThan(1)
  expect(asked).toBe(2)

  // What arrived went below; the cover, the title and the scoreboard are where they were.
  expect(await hero.boundingBox()).toEqual(before.hero)
  expect(await title.boundingBox()).toEqual(before.title)
  expect(await scoreboard.boundingBox()).toEqual(before.scoreboard)
  expect(await page.evaluate(() => window.scrollY)).toBe(before.scrollY)

  // A whole page asks nothing more, however long it stays open.
  await page.clock.fastForward(60_000)
  expect(asked).toBe(2)
  await onTheStoppedClock(page, 2_000, () =>
    expectAccessible(page, 'game page completed by its own second request'),
  )
})

test('the locale switch keeps the page, uk → en → uk', async ({ page }) => {
  await page.goto(`${WITCHER}`)
  await waitForHydration(page)
  await expect(page.locator('html')).toHaveAttribute('lang', /^uk/)
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()

  await page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Мова' })
    .getByRole('link', { name: 'English' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/en${WITCHER}$`))
  await expect(page.locator('html')).toHaveAttribute('lang', /^en/)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Screenshots' })).toBeVisible()
  await expectAccessible(page, 'game page in English')

  await page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Language' })
    .getByRole('link', { name: 'Українська' })
    .click()
  await expect(page).toHaveURL(new RegExp(`${WITCHER}$`))
  await expect(page).not.toHaveURL(/\/en\//)
  await expect(page.locator('html')).toHaveAttribute('lang', /^uk/)
  await expect(page.getByRole('heading', { name: 'Скріншоти' })).toBeVisible()

  // The catalog keeps its filters across the switch: the query string travels with the path.
  await page.goto('/games?ukrainianLocalisation=ANY')
  await waitForHydration(page)
  await expectAccessible(page, 'catalog with a filter')
  await page
    .getByRole('banner')
    .getByRole('navigation', { name: 'Мова' })
    .getByRole('link', { name: 'English' })
    .click()
  await expect(page).toHaveURL(/\/en\/games\?ukrainianLocalisation=ANY$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Game catalog' })).toBeVisible()
  await expectAccessible(page, 'catalog in English')
})

test('ask at 375 px → a recorded question → a long one that falls back → Back, not asked again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // Only the questions the browser itself sends; the first page render asks on the server.
  const asked: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ask') asked.push(request.postData() ?? '')
  })
  const pageWidth = () => page.evaluate(() => document.documentElement.scrollWidth)

  await page.goto('/ask')
  await waitForHydration(page)
  // Gege opens the page, and the bubble's title is the page's heading.
  await expect(page.locator('[data-test="ask-intro"] svg[data-mood="idle"]')).toBeVisible()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Опиши гру, як сказав би другові' }),
  ).toBeVisible()
  await expectAccessible(page, 'ask page')

  await page.getByRole('button', { name: 'атмосферний горор українською' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Результати' })).toBeFocused()
  await expect(page.locator('[data-test="ask-interpretation"]')).toContainText('Зрозумів так:')
  await expect(page.locator('[data-test="ask-reason"]').first()).toBeVisible()
  // The number in the count line is the number of rows a visitor can scroll to: every row is in
  // the document and takes up room on the page.
  const rows = page.locator('[data-test="ask-item"]')
  const counted = Number(/\d+/.exec(await page.locator('[data-test="ask-count"]').innerText())![0])
  await expect(rows).toHaveCount(counted)
  for (const row of await rows.all()) {
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible()
  }
  // The form is still there, above the answer, with the question in it.
  await expect(page.getByRole('textbox', { name: 'Яку гру шукаєш?' })).toHaveValue(
    'атмосферний горор українською',
  )
  expect(await pageWidth()).toBeLessThanOrEqual(375)
  await expectAccessible(page, 'ask answer')

  // Unrecorded in fixture mode, so the endpoint falls back and the whole question becomes the
  // search chip — which must wrap inside the 375 px column, not push the page sideways.
  const long =
    'хочу атмосферну гру з гарним сюжетом про подорож у часі для двох гравців на дивані ввечері'
  await page.getByRole('textbox', { name: 'Яку гру шукаєш?' }).fill(long)
  await page.getByRole('button', { name: 'Підібрати', exact: true }).click()
  await expect(page.locator('[data-test="ask-fallback-note"]')).toBeVisible()
  expect(await pageWidth()).toBeLessThanOrEqual(375)
  await expectAccessible(page, 'ask fallback')
  expect(asked).toHaveLength(2)

  // Back renders the answer this tab already has: no new question, no skeleton.
  await page.goBack()
  await expect(page.locator('[data-test="ask-reason"]').first()).toBeVisible()
  await page.goForward()
  await expect(page.locator('[data-test="ask-fallback-note"]')).toBeVisible()
  expect(asked).toHaveLength(2)
})
