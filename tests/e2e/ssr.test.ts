import { describe, expect, it } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'

// Build-time default and runtime override, so the server under test never calls RAWG.
process.env.RAWG_FIXTURES = '1'

describe('server-side rendering', async () => {
  await setup({
    server: true,
    browser: false,
    env: { RAWG_FIXTURES: '1', NUXT_RAWG_FIXTURES: '1' },
  })

  it('renders the landing hero into the HTML, with no video tag on the server', async () => {
    const html = await $fetch<string>('/')
    expect(html).toMatch(/<h1[^>]*>Ігри, які варто знайти<\/h1>/)
    expect(html).toContain('href="/games"')
    expect(html).toContain('The Witcher 3: Wild Hunt')
    expect(html).not.toContain('<video')
    // The hero must run underneath the sticky transparent header rather than start below it:
    // pulled up by the header's fixed height (a shared CSS token, not a JS measurement) plus the
    // layout's own top padding.
    expect(html).toContain('-mt-[calc(var(--header-h)+1.5rem)]')
    expect(html).toContain('h-[var(--header-h)]')
  })

  it('renders the English landing headline under /en', async () => {
    const html = await $fetch<string>('/en')
    expect(html).toContain('Games worth finding')
  })

  it('renders catalog cards into the HTML', async () => {
    const html = await $fetch<string>('/games')
    expect(html).toContain('The Witcher 3: Wild Hunt')
    expect(html).toContain('Stardew Valley')
    expect(html.match(/<article/g)?.length).toBe(4)
    expect(html).toMatch(/<html[^>]*lang="uk/)
    expect(html).toContain('Каталог ігор')
  })

  it('renders the filters button and numbered pagination', async () => {
    const html = await $fetch<string>('/games')
    expect(html).toContain('Фільтри')
    expect(html).toMatch(/aria-current="page"/)
  })

  it('applies URL filters on the server', async () => {
    const html = await $fetch<string>('/games?playtime=LONG')
    expect(html).toContain('The Witcher 3: Wild Hunt')
    expect(html).not.toContain('Stardew Valley')
  })

  it('shows the empty state with a clear action for a zero-result query', async () => {
    // None of the fixture games carry a "teen" ESRB rating (PEGI12 maps to it),
    // so this post-filter yields zero results while still exercising server filtering.
    const html = await $fetch<string>('/games?ageRating=PEGI12')
    expect(html).toContain('Нічого не знайдено')
    expect(html).toContain('За цими фільтрами ігор немає. Приберіть один або скиньте всі.')
    expect(html).toContain('Скинути фільтри')
  })

  it('renders the English catalog under /en with hreflang alternates', async () => {
    const html = await $fetch<string>('/en/games')
    expect(html).toContain('Game catalog')
    expect(html).toMatch(/<html[^>]*lang="en/)
    expect(html).toMatch(/hreflang="uk/)
    expect(html).toMatch(/hreflang="en/)
    // The catalog card shows the release year only (sliced from the ISO date, not a
    // localised full date) — the full "May 18, 2015" form still appears on the detail page.
    expect(html).toContain('2015')
  })

  it('renders the detail page with a localised date and store links', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toContain('<h1')
    expect(html).toContain('The Witcher 3: Wild Hunt')
    expect(html).toContain('18 травня 2015')
    expect(html).toContain('https://store.steampowered.com/app/292030/')
  })

  it('renders the hero title and scoreboard row on the detail page', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toMatch(/<h1[^>]*>\s*The Witcher 3: Wild Hunt\s*<\/h1>/)
    // The scoreboard row shows the same localised release date as the rest of the page.
    expect(html).toContain('18 травня 2015')
    expect(html).toContain('92')
  })

  it('renders the screenshot gallery thumbnails into the server HTML', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toContain('screenshots/201001/full1.jpg')
    expect(html).toContain('screenshots/201002/full2.jpg')
    expect(html).toContain('screenshots/201003/full3.jpg')
  })

  it('responds 404 for an unknown slug, with a noindex HTML page when the client accepts HTML', async () => {
    const response = await fetch('/games/does-not-exist', { headers: { accept: 'text/html' } })
    expect(response.status).toBe(404)
    const html = await response.text()
    expect(html).toContain('noindex')
    expect(html).toContain('Сторінку не знайдено')
  })

  it('serves GraphQL errors with a code and HTTP 200', async () => {
    const body = await $fetch<{ errors: { extensions: { code: string } }[] }>('/api/graphql', {
      method: 'POST',
      body: { query: '{ game(slug: "does-not-exist") { slug } }' },
    })
    expect(body.errors[0]!.extensions.code).toBe('NOT_FOUND')
  })

  it('never reaches the real RAWG API: fixture-only data is present', async () => {
    const html = await $fetch<string>('/games')
    expect(html).toContain('Unreleased Sample')
  })

  it('does not render the header search suggestions listbox for a pre-filled catalog search term', async () => {
    const html = await $fetch<string>('/games?search=witcher')
    expect(html).not.toContain('role="listbox"')
  })
})
