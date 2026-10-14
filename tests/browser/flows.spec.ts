import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { namesAnotherProduct } from '../../app/utils/storeOffers'
import { STORE_OPTIONS } from '../../shared/catalog'
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
  game: {
    stillLoading: string
    notLoaded: string
    about: string
    whereToBuy: string
    cheapest: string
    estimateNote: string
  }
  price: { approximately: string; was: string }
  card: { cheaperAt: string }
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
interface Deal {
  name: string
  slug: string
  discountPercent: number
}

/**
 * Today's deal, as the server picks it. Two games of the fixture index qualify (Portal 2 and The
 * Witcher 3) and the pick turns with the UTC date, so a flow that named one of them passed on
 * even days and failed on odd ones. The flows ask instead, and hold the bubble to the answer.
 */
async function dealOfTheDay(page: Page): Promise<Deal> {
  const response = await page.request.post('/api/graphql', {
    data: { query: '{ dealOfTheDay { name slug price { discountPercent } } }' },
  })
  const body = (await response.json()) as {
    data?: {
      dealOfTheDay: { name: string; slug: string; price: { discountPercent: number } } | null
    }
  }
  const deal = body.data?.dealOfTheDay ?? null
  if (!deal) throw new Error('The fixture index offers a deal every day, and the server named none')
  return { name: deal.name, slug: deal.slug, discountPercent: deal.price.discountPercent }
}

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
  // Whichever of the fixture's two qualifying games the server offers today.
  const deal = await dealOfTheDay(page)
  await expect(bubble.getByRole('link', { name: deal.name })).toHaveAttribute(
    'href',
    `/games/${deal.slug}`,
  )
  await expect(bubble).toContainText(`−${deal.discountPercent}%`)
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
  await expect(bubble.getByRole('link', { name: deal.name })).toBeFocused()
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
  await expect(bubble.getByRole('link', { name: (await dealOfTheDay(page)).name })).toBeVisible()
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

/** One store of a game, as the server answers it: what the page's block is held to. */
interface StoreRow {
  store: string
  url: string
  title: string | null
  priceUah: number | null
  isFree: boolean | null
  discountPercent: number | null
  foreignPrice: { amount: number; currency: string } | null
  foreignRegularPrice: { amount: number; currency: string } | null
  approxUah: number | null
  cheapest: boolean
}

/**
 * What the server says of a game's stores, asked the way the page asks. The flows read every
 * price, title, address and date they expect from this answer rather than naming them: the seed
 * is free to change what a store charges and what it calls the product, and the day of the rate
 * moves with the clock the build was started on.
 */
async function storesOf(
  page: Page,
  slug: string,
): Promise<{ name: string; stores: StoreRow[]; rateDate: string | null }> {
  const response = await page.request.post('/api/graphql', {
    data: {
      query: `query ($slug: String!) {
        game(slug: $slug) {
          name
          stores {
            store url title priceUah isFree discountPercent approxUah cheapest
            foreignPrice { amount currency }
            foreignRegularPrice { amount currency }
          }
          exchangeRate { date }
        }
      }`,
      variables: { slug },
    },
  })
  const body = (await response.json()) as {
    data?: {
      game: { name: string; stores: StoreRow[]; exchangeRate: { date: string } | null } | null
    }
  }
  const game = body.data?.game
  if (!game) throw new Error(`The server answered nothing about ${slug}`)
  return { name: game.name, stores: game.stores, rateDate: game.exchangeRate?.date ?? null }
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A hryvnia amount as the Ukrainian page writes it, whatever kind of space it groups with. */
const hryvnia = (value: number) => `${String(value).replace(/\B(?=(\d{3})+$)/g, '\\s')}\\s₴`

test('game page → «Де купити» → what GOG charges in dollars, about how much that is, which store is cheapest — and the same at 375 px', async ({
  page,
}) => {
  const answer = await storesOf(page, 'the-witcher-3-wild-hunt')
  const steam = answer.stores.find((row) => row.store === 'steam')!
  const gog = answer.stores.find((row) => row.store === 'gog')!
  // What the flow is about, and what the seed is for: a dollar price with a rate to estimate by.
  expect(gog.foreignPrice?.currency).toBe('USD')
  expect(gog.approxUah).not.toBeNull()
  expect(steam.priceUah).not.toBeNull()
  expect(answer.rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  await page.goto(WITCHER)
  await waitForHydration(page)
  const block = page.getByRole('region', { name: copy.game.whereToBuy })

  // A row is one link, to the store's own page for the product. On screen the estimate sits
  // right beside the price it is an estimate of.
  const gogRow = block.locator('[data-test="store-row-gog"]').getByRole('link')
  await expect(gogRow).toHaveAttribute('href', gog.url)
  const dollars = `$${gog.foreignPrice!.amount.toFixed(2)}`
  await expect(gogRow.locator('[data-test="store-price-shown"]')).toContainText(dollars)
  await expect(gogRow.locator('[data-test="store-estimate"]')).toHaveText(
    new RegExp(`^≈\\s${hryvnia(gog.approxUah!)}$`),
  )
  // Its name is the price as one sentence, in an order of its own: what it costs, what it cost
  // when the server names a higher regular price, then about how much that is — each with a
  // word a screen reader can say, and never the sign.
  const chip = gog.discountPercent ? `−${gog.discountPercent}%\\s` : ''
  const was = gog.foreignRegularPrice
    ? `,\\s${copy.price.was}\\s${escaped(`$${gog.foreignRegularPrice.amount.toFixed(2)}`)}`
    : ''
  const about = `,\\s${copy.price.approximately}\\s${hryvnia(gog.approxUah!)}`
  await expect(gogRow).toHaveAccessibleName(
    new RegExp(`^GOG\\s.*${chip}${escaped(dollars)}${was}${about}\\s`),
  )
  await expect(gogRow).not.toHaveAccessibleName(/[≈·]/)

  // What the store calls the product is under its name exactly when it is not the game's own.
  const title = gogRow.locator('[data-test="store-title"]')
  if (namesAnotherProduct(gog.title, answer.name)) await expect(title).toHaveText(gog.title!)
  else await expect(title).toHaveCount(0)

  const steamRow = block.locator('[data-test="store-row-steam"]').getByRole('link')
  await expect(steamRow).toHaveAttribute('href', steam.url)
  await expect(steamRow.locator('[data-test="store-price"]')).toContainText(
    new RegExp(hryvnia(steam.priceUah!)),
  )

  // One mark at most, on the row the server marked.
  const marked = answer.stores.filter((row) => row.cheapest)
  expect(marked.length).toBeLessThanOrEqual(1)
  await expect(block.locator('[data-test="cheapest"]')).toHaveCount(marked.length)
  for (const row of marked) {
    await expect(
      block.locator(`[data-test="store-row-${row.store}"] [data-test="cheapest"]`),
    ).toHaveText(copy.game.cheapest)
  }

  // The note is the locale file's sentence, about the day the server's rate is for.
  const [before, after] = copy.game.estimateNote.split('{date}') as [string, string]
  const note = block.locator('[data-test="estimate-note"]')
  await expect(note).toHaveText(new RegExp(`^${escaped(before)}.+${escaped(after)}$`))
  const day = (await note.innerText()).slice(before.length, -after.length)
  const [year, , dayOfMonth] = answer.rateDate!.split('-') as [string, string, string]
  expect(day).toContain(year)
  expect(day).toMatch(new RegExp(`^${Number(dayOfMonth)}\\s`))
  await expectAccessible(page, 'game page with the other stores’ prices')

  // On a phone the row stacks: nothing is cut off and nothing makes the page scroll sideways.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(gogRow).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0)
  for (const part of [gogRow, gogRow.locator('[data-test="store-price"]'), note]) {
    const box = (await part.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
  }
  // A finger's worth of row, at the least.
  expect((await gogRow.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expectAccessible(page, 'game page with the other stores’ prices at 375 px')
})

test('game page → «Де купити» → what the PlayStation Store charges, under the product’s name, never marked — and a long name at 375 px', async ({
  page,
}) => {
  // Metro Exodus: on sale, and the lowest price on the page by far.
  const metro = await storesOf(page, 'metro-exodus')
  const playstation = metro.stores.find((row) => row.store === 'playstation-store')!
  expect(playstation.priceUah).not.toBeNull()
  expect(playstation.discountPercent).toBeGreaterThan(0)
  const others = metro.stores.filter((row) => row !== playstation && row.priceUah !== null)
  expect(others.every((row) => row.priceUah! > playstation.priceUah!)).toBe(true)
  expect(playstation.cheapest).toBe(false)

  await page.goto('/games/metro-exodus')
  await waitForHydration(page)
  const block = page.getByRole('region', { name: copy.game.whereToBuy })
  const row = block.locator('[data-test="store-row-playstation-store"]').getByRole('link')
  await expect(row).toHaveAttribute('href', playstation.url)
  await expect(row.locator('[data-test="store-price-shown"]')).toContainText(
    new RegExp(hryvnia(playstation.priceUah!)),
  )
  await expect(row.locator('[data-test="store-price-shown"]')).toContainText(
    `−${playstation.discountPercent}%`,
  )
  // The product's name, though it is the game's own.
  await expect(row.locator('[data-test="store-title"]')).toHaveText(playstation.title!)
  // Not marked, and the mark that is on the page is where the server put it.
  await expect(row.locator('[data-test="cheapest"]')).toHaveCount(0)
  await expect(block.locator('[data-test="cheapest"]')).toHaveCount(
    metro.stores.filter((store) => store.cheapest).length,
  )
  await expectAccessible(page, 'game page with a PlayStation Store price')

  // Stardew Valley: a product title of two hundred characters, on a phone.
  const stardew = await storesOf(page, 'stardew-valley')
  const long = stardew.stores.find((store) => store.store === 'playstation-store')!
  expect(long.title).toHaveLength(200)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/games/stardew-valley')
  await waitForHydration(page)
  const longRow = page
    .getByRole('region', { name: copy.game.whereToBuy })
    .locator('[data-test="store-row-playstation-store"]')
    .getByRole('link')
  await expect(longRow.locator('[data-test="store-title"]')).toHaveText(long.title!)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0)
  for (const part of [longRow, longRow.locator('[data-test="store-title"]')]) {
    const box = (await part.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
  }
  await expectAccessible(page, 'game page with a long PlayStation Store title at 375 px')
})

test('game page → «Де купити» → a store that charges in hryvnia has its price, and no note about an estimate', async ({
  page,
}) => {
  const answer = await storesOf(page, 'stardew-valley')
  const microsoft = answer.stores.find((row) => row.store === 'xbox-store')!
  expect(microsoft.priceUah).not.toBeNull()
  // Nothing on this page is estimated, so the answer names no rate.
  expect(answer.rateDate).toBeNull()

  await page.goto('/games/stardew-valley')
  await waitForHydration(page)
  const block = page.getByRole('region', { name: copy.game.whereToBuy })

  const row = block.locator('[data-test="store-row-xbox-store"]').getByRole('link')
  await expect(row).toHaveAttribute('href', microsoft.url)
  await expect(row.locator('[data-test="store-price-shown"]')).toHaveText(
    new RegExp(`^${hryvnia(microsoft.priceUah!)}$`),
  )
  await expect(block.locator('[data-test="store-estimate"]')).toHaveCount(0)
  await expect(block.locator('[data-test="estimate-note"]')).toHaveCount(0)
  await expect(block.locator('[data-test="cheapest"]')).toHaveCount(
    answer.stores.filter((store) => store.cheapest).length,
  )
  await expectAccessible(page, 'game page with a hryvnia price from another store')
})

test('a game opened at 375 px → a store’s title of two hundred characters wraps inside its row', async ({
  page,
}) => {
  // The longest title an offer may carry, with runs no line can hold and no space to break at.
  // No fixture has one: the page's own request is answered with the server's real answer, and
  // only GOG's title in it is changed on the way to the browser.
  const LONG =
    `${'Supercalifragilisticexpialidocious_'.repeat(2)} Edition `.repeat(3).slice(0, 199) + '!'
  expect([...LONG]).toHaveLength(200)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.route('**/api/graphql', async (route: Route) => {
    if (!isGameQuery(route.request())) return route.continue()
    const response = await route.fetch()
    const body = (await response.json()) as {
      data: { game: { stores: { store: string; title: string | null }[] } }
    }
    const game = body.data.game
    const stores = game.stores.map((row) => (row.store === 'gog' ? { ...row, title: LONG } : row))
    await route.fulfill({ response, json: { data: { game: { ...game, stores } } } })
  })

  await page.goto('/games')
  await waitForHydration(page)
  await page.locator(`a[href="${WITCHER}"]`).first().click()
  const block = page.getByRole('region', { name: copy.game.whereToBuy })
  const row = block.locator('[data-test="store-row-gog"]').getByRole('link')
  const title = row.locator('[data-test="store-title"]')
  await expect(title).toHaveText(LONG)

  // Nothing makes the page scroll sideways, and nothing of the row is outside the screen.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0)
  const rowBox = (await row.boundingBox())!
  const titleBox = (await title.boundingBox())!
  const priceBox = (await row.locator('[data-test="store-price-shown"]').boundingBox())!
  for (const box of [rowBox, titleBox, priceBox]) {
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
  }
  // The title is inside its row and takes several lines of it; the price comes under it, whole.
  expect(titleBox.x).toBeGreaterThanOrEqual(rowBox.x)
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width)
  const lineHeight = await title.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).lineHeight),
  )
  expect(titleBox.height).toBeGreaterThanOrEqual(lineHeight * 3)
  expect(priceBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height)
  expect(priceBox.y + priceBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height)
  // No text of it is clipped: the element is as tall and as wide as what it holds.
  expect(
    await title.evaluate(
      (node) =>
        node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
    ),
  ).toBe(true)
  await expectAccessible(page, 'game page with a two-hundred-character store title at 375 px')
})

test('catalog → a card says another store is cheaper → its game page has that store’s price — and the line fits a phone', async ({
  page,
}) => {
  // What each card should say is asked of the server the way the catalog asks, so the seed is
  // free to change which games another store undercuts Steam for. It has to hold one.
  const response = await page.request.post('/api/graphql', {
    data: { query: '{ games { items { slug cheaperAt } } }' },
  })
  const { items } = (
    (await response.json()) as {
      data: { games: { items: { slug: string; cheaperAt: string | null }[] } }
    }
  ).data.games
  const named = items.filter((item) => item.cheaperAt !== null)
  expect(named.length).toBeGreaterThan(0)
  const game = named[0]!
  const storeName = STORE_OPTIONS.find((store) => store.slug === game.cheaperAt)!.name
  const sentence = copy.card.cheaperAt.replace('{store}', storeName)

  await page.goto('/games')
  await waitForHydration(page)
  const cards = page.locator('[data-test="game-card"]')
  await expect(cards).toHaveCount(items.length)
  // One line on every card the answer names a store for, and on no other.
  await expect(cards.locator('[data-test="cheaper-at"]')).toHaveCount(named.length)

  const card = cards.filter({ has: page.locator(`a[href="/games/${game.slug}"]`) })
  const line = card.locator('[data-test="cheaper-at"]')
  await expect(line).toHaveText(sentence)
  // Under the price it is about, and part of what the card's one link is called.
  const priceBox = (await card.locator('[data-test="price"]').boundingBox())!
  expect((await line.boundingBox())!.y).toBeGreaterThanOrEqual(priceBox.y + priceBox.height)
  await expect(card.getByRole('link')).toHaveAccessibleName(new RegExp(`${escaped(sentence)}$`))
  await expectAccessible(page, 'catalog with a card that names a cheaper store')

  // On a phone the grid is two narrow columns: the line stays inside its card, on the page.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(line).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0)
  const cardBox = (await card.boundingBox())!
  const lineBox = (await line.boundingBox())!
  expect(lineBox.x).toBeGreaterThanOrEqual(cardBox.x)
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
  expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height)
  await expectAccessible(page, 'catalog with a card that names a cheaper store at 375 px')

  // The page the card opens is where the two prices are: the store it named has a row with one.
  await card.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/games/${game.slug}$`))
  const row = page
    .getByRole('region', { name: copy.game.whereToBuy })
    .locator(`[data-test="store-row-${game.cheaperAt}"]`)
  await expect(row.locator('[data-test="store-price"]')).toBeVisible()
  await expect(row.getByRole('link')).toHaveAccessibleName(new RegExp(`^${escaped(storeName)}`))
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
  // similar games. Names and numbers, and nothing of the request. Steam is asked once more — for
  // the price — when the server under the flows has been up long enough for the price the index
  // was seeded with to have aged past the six hours it is trusted for: a server kept for reuse,
  // never the one a run starts for itself.
  expect(response.headers()['server-timing']).toMatch(
    /^rawg;dur=\d+;desc="RAWG x3", steam;dur=\d+;desc="Steam x[12]", index;dur=\d+;desc="Index x[1-9]\d*", total;dur=\d+$/,
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
  // The page's one status region, with the line in it.
  const region = page.locator('article').getByRole('status')
  const note = region.locator('p')
  await expect(region).toHaveText(copy.game.stillLoading)
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
  await expect(region).toHaveText(copy.game.stillLoading)

  // Three seconds on, the page asks again; the whole answer takes the partial one's place.
  await page.clock.fastForward(3_000)
  await expect(note).toHaveCount(0)
  await expect(region).toBeEmpty()
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

test('a game whose answer stays partial → the page asks twice → the line says the rest did not load, and nothing more is asked', async ({
  page,
}) => {
  let asked = 0
  await page.route('**/api/graphql', async (route) => {
    if (!isGameQuery(route.request())) return route.fallback()
    asked += 1
    return answerInPart(route)
  })
  await openWitcherOnAStoppedClock(page, () => asked)

  const region = page.locator('article').getByRole('status')
  const note = region.locator('p')
  await expect(region).toHaveText(copy.game.stillLoading)

  // Three seconds on, the first attempt: partial again, so the page and its line stay as they are.
  await page.clock.fastForward(3_000)
  await expect.poll(() => asked).toBe(2)
  await expect(region).toHaveText(copy.game.stillLoading)

  // The second wait is counted from the arrival of that answer, which the flow cannot see land;
  // the clock is moved on until the page has asked — six seconds of it, as the unit suite pins.
  await expect
    .poll(
      async () => {
        if (asked === 2) await page.clock.runFor(500)
        return asked
      },
      { intervals: [10] },
    )
    .toBe(3)

  // Both attempts spent: nothing is loading any more, and the line says so in the same place.
  await expect(region).toHaveText(copy.game.notLoaded)
  await expect(page.getByRole('status').filter({ hasText: copy.game.notLoaded })).toHaveCount(1)
  await expectLineOverTheCover(page, note)
  await expect(
    page.getByRole('heading', { level: 1, name: 'The Witcher 3: Wild Hunt' }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await onTheStoppedClock(page, 2_000, () =>
    expectAccessible(page, 'game page whose answer stayed partial'),
  )

  // And that is the end of it, however long the page stays open.
  await page.clock.fastForward(60_000)
  await expect(region).toHaveText(copy.game.notLoaded)
  expect(asked).toBe(3)
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
