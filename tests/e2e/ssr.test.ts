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

  it('renders catalog cards into the HTML', async () => {
    const html = await $fetch<string>('/games')
    expect(html).toContain('The Witcher 3: Wild Hunt')
    expect(html).toContain('Stardew Valley')
    expect(html.match(/<article/g)?.length).toBe(4)
    expect(html).toMatch(/<html[^>]*lang="uk/)
    expect(html).toContain('Каталог ігор')
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
})
