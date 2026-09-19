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
    // RAWG has no clip for the featured game in these fixtures (see
    // tests/fixtures/rawg/game-3328-movies.json): the landing resolver falls back to the game's
    // Steam trailer, and the hero caption's quieter second line names the source.
    expect(html).toContain('Трейлер: Steam')
    // The hero must run underneath the sticky transparent header rather than start below it:
    // pulled up by the header's fixed height (a shared CSS token, not a JS measurement) plus the
    // layout's own top padding.
    expect(html).toContain('-mt-[calc(var(--header-h)+1.5rem)]')
    expect(html).toContain('h-[var(--header-h)]')
  })

  it('renders the featured game title inside the "now on screen" caption link', async () => {
    const html = await $fetch<string>('/')
    const caption = html.match(/Зараз на екрані:[\s\S]*?<\/p>/)?.[0]
    expect(caption).toBeTruthy()
    expect(caption).toMatch(/<a[^>]*>\s*The Witcher 3: Wild Hunt\s*<\/a>/)
  })

  it('renders the landing sections below the hero: count, rows and closing call to action', async () => {
    const html = await $fetch<string>('/')
    // totalGames is 4 in the fixture set, rounded down to the nearest 1 000 below 100 000; the
    // count sits in its own <span class="font-numeric"> (Vue leaves an anchor comment right
    // after an i18n-t slot), so match around that instead of a single contiguous string.
    expect(html).toMatch(/class="font-numeric">0<\/span>.*?\+ ігор у каталозі/)
    expect(html).toContain('Чому GG Stay')
    expect(html).toContain('Нові релізи')
    expect(html).toContain('Найкращі за оцінкою гравців')
    // Row cards reuse GameCard and are present in the server HTML (unlike the ring).
    expect(html).toContain('Portal 2')
    expect(html).toContain('Stardew Valley')
    expect(html).toContain('Готові знайти свою наступну гру?')
    // The closing call to action reuses the hero's own button label and target.
    expect(html.match(/Відкрити каталог/g)?.length).toBeGreaterThanOrEqual(2)
    // The ring only ever mounts client-side (wrapped in <ClientOnly>): the server sends just the
    // reserved-height placeholder, never the ring's own list markup. (`ring-list`/`ring-stage`
    // as bare strings would also match CoverRing's scoped CSS, which Vite still inlines into the
    // page since `index.vue` imports the component module for its `RING_HEIGHT_CLASS` constant —
    // so check for the cover links' own `data-ring-index` attribute instead, which only exists on
    // actually-rendered DOM nodes.)
    expect(html).not.toContain('data-ring-index')
  })

  it('renders the same landing sections in English under /en', async () => {
    const html = await $fetch<string>('/en')
    expect(html).toContain('games in the catalog')
    expect(html).toContain('Why GG Stay')
    expect(html).toContain('New releases')
    expect(html).toContain('Top rated by players')
    expect(html).toContain('Ready to find your next game?')
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
