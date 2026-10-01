import type { Page } from '@playwright/test'
import { expect, expectAccessible, test, waitForHydration } from './fixtures'

/**
 * The four smoke flows of the quality gate, against the fixture-mode production build. The data is
 * the recorded RAWG fixtures plus the in-memory index the fixture mode seeds: the plain catalog has
 * four games, a 1 000 ₴ ceiling widens it to the index's seven, and Ukrainian localisation narrows
 * those to three. Every flow also fails on a console error (see `fixtures.ts`).
 */

const WITCHER = '/games/the-witcher-3-wild-hunt'

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
