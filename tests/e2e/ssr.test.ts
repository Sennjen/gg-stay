import { createHash } from 'node:crypto'
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
    // layout's own top padding. Asserted on the CSS token rather than the full utility string:
    // the token is the contract, the Tailwind class around it is not.
    expect(html).toContain('var(--header-h)')
  })

  it('preloads the hero poster at high fetch priority', async () => {
    // A preload link without `fetchpriority` makes Chrome fetch the LCP image at Low priority,
    // whatever the <img> itself says: the link is what starts the request.
    const html = await $fetch<string>('/')
    const preload = html.match(/<link[^>]*rel="preload"[^>]*as="image"[^>]*>/)?.[0] ?? ''
    expect(preload).toContain('imagesrcset=')
    expect(preload).toContain('fetchpriority="high"')
  })

  it('renders the featured game title inside the "now on screen" caption link', async () => {
    const html = await $fetch<string>('/')
    const caption = html.match(/Зараз на екрані:[\s\S]*?<\/p>/)?.[0]
    expect(caption).toBeTruthy()
    expect(caption).toMatch(/<a[^>]*>\s*The Witcher 3: Wild Hunt\s*<\/a>/)
  })

  it('renders the landing sections below the hero: count, rows and closing call to action', async () => {
    const html = await $fetch<string>('/')
    // totalGames is 4 in the fixture set, which rounds down to nothing — there is no friendly
    // figure for a count under 1 000, so the headline is hidden rather than reading "0+ ігор".
    // (Against production, where the total is ~900 000, this is the "900 000+" headline.)
    expect(html).not.toContain('ігор у каталозі')
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
    // Same as above: the fixture total is too small for a rounded headline, so it is absent.
    expect(html).not.toContain('games in the catalog')
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
    // One <article> per card; the fixture set's exact size is not what this test is about.
    expect(html.match(/<article/g)?.length).toBeGreaterThan(1)
    expect(html).toMatch(/<html[^>]*lang="uk/)
    expect(html).toContain('Каталог ігор')
  })

  it('renders the price line and the localisation badge on the cards the index knows', async () => {
    // Fixture mode seeds the in-memory index from tests/fixtures/index/published.json, which
    // holds exactly the games the RAWG fixtures show — so the RAWG path attaches a real price to
    // three of the four cards and leaves the fourth (unreleased-sample) without one.
    const html = await $fetch<string>('/games')
    expect(html).toContain('data-test="price"')
    expect(html).toContain('data-test="localisation"')
    expect(html).toContain('₴')
    // The Witcher 3 is on sale in the fixture: the chip, the new price and the old one.
    expect(html).toContain('675')
    expect(html).toContain('1\u00a0349\u00a0\u20b4')
    expect(html).toContain('Безкоштовно')
    // One card per priced game, and no price line at all on the game the index never saw.
    expect(html.match(/data-test="price"/g)?.length).toBe(3)
  })

  // The catalog URL does not carry the index filters yet — `app/utils/filterUrl.ts` gains them
  // with the drawer sections and the chips in PR 7 — so the index path is exercised here through
  // the BFF the page talks to, against the running server, rather than through a `/games?…` URL.
  it('serves a price-filtered page from the index alone, through the running BFF', async () => {
    const body = await $fetch<{ data: { games: Record<string, unknown> } }>('/api/graphql', {
      method: 'POST',
      body: {
        query: `query($filter: GameFilter, $sort: GameSort) {
          games(filter: $filter, sort: $sort) {
            total indexedOnly indexStale ignoredFilters
            items { slug price { bestUah isFree } }
          }
        }`,
        variables: { filter: { priceMaxUah: 600 }, sort: 'PRICE_ASC' },
      },
    })
    const page = body.data.games as {
      total: number
      indexedOnly: boolean
      indexStale: boolean
      items: { slug: string; price: { bestUah: number; isFree: boolean } }[]
    }
    expect(page).toMatchObject({ total: 2, indexedOnly: true, indexStale: false })
    // Under 600 ₴, cheapest first: the free Stardew Valley, then Portal 2. The Witcher 3 (675 ₴)
    // and the sample game the index never saw are both out.
    expect(page.items.map((item) => item.slug)).toEqual(['stardew-valley', 'portal-2'])
    expect(page.items[0]!.price).toEqual({ bestUah: 0, isFree: true })
  })

  it('serves a localisation-filtered page from the index alone, through the running BFF', async () => {
    const body = await $fetch<{ data: { games: { items: { slug: string }[] } } }>('/api/graphql', {
      method: 'POST',
      body: {
        query: `query($filter: GameFilter) {
          games(filter: $filter) { indexedOnly items { slug localisation { text audio } } }
        }`,
        variables: { filter: { ukrainianLocalisation: 'AUDIO' } },
      },
    })
    expect(body.data.games.items.map((item) => item.slug)).toEqual(['the-witcher-3-wild-hunt'])
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

  it('shows the Steam price and the Ukrainian localisation on the game page', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toContain('Ціна в Steam')
    expect(html).toContain('₴')
    expect(html).toContain('Українська')
    expect(html).toContain('Текст і озвучка')
    // Server-computed from the index timestamp against the request's own clock read, so the
    // caption is the same string in the server HTML and after hydration. The number sits in its
    // own `font-numeric` span, so the sentence is not one contiguous string in the markup.
    expect(html).toContain('оновлено')
  })

  it('applies the Ukrainian plural rule server-side for the ratings count', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    // Fixture rating: 6800, uk-UA grouped with a no-break space (U+00A0) between the digits;
    // 6800 % 10 === 0,
    // so the correct Ukrainian plural form is "many" ("оцінок"), not "оцінка"/"оцінки" — this
    // only proves the custom pluralRules.uk rule (i18n/i18n.config.ts) runs on the server too.
    expect(html).toContain('6 800 оцінок')
  })

  it('renders the screenshot gallery thumbnails into the server HTML', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toContain('screenshots/201001/full1.jpg')
    expect(html).toContain('screenshots/201002/full2.jpg')
    expect(html).toContain('screenshots/201003/full3.jpg')
  })

  it('renders the Ukrainian Steam description with lang="uk" and the Steam caption', async () => {
    const html = await $fetch<string>('/games/the-witcher-3-wild-hunt')
    expect(html).toContain('Ви — Ґеральт із Рівії, відьмак-мисливець на чудовиськ.')
    expect(html).toMatch(/<div[^>]*lang="uk"[^>]*>/)
    expect(html).toContain('Опис: Steam')
    // The English RAWG text must not leak into the Ukrainian page.
    expect(html).not.toContain('The third game in a series')
  })

  it('renders the English RAWG description with lang="en" and no Steam caption', async () => {
    const html = await $fetch<string>('/en/games/the-witcher-3-wild-hunt')
    expect(html).toContain('The third game in a series, it holds nothing back from the player.')
    expect(html).toMatch(/<div[^>]*lang="en"[^>]*>/)
    expect(html).not.toContain('Опис: Steam')
    expect(html).not.toContain('Description: Steam')
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

  it('gives the GraphQL endpoint its own minimal policy, since it never reaches the plugin', async () => {
    // yoga answers with its own Response, which `sendWebResponse` hands straight to the client
    // without passing through the `beforeResponse` hook the CSP plugin back-fills from — so this
    // route sets its own. A JSON body hosts no document, hence 'none' rather than an allow-list.
    const response = await fetch('/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ genres { id } }' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    // The static headers still come from routeRules, as on every other route.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('sends the security headers on every page, with an exact-hash script-src', async () => {
    for (const path of ['/', '/en', '/games', '/games/the-witcher-3-wild-hunt']) {
      const response = await fetch(path, { headers: { accept: 'text/html' } })
      const csp = response.headers.get('content-security-policy')!

      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("base-uri 'self'")
      expect(csp).toContain("style-src 'self' 'unsafe-inline'")
      expect(csp).toContain("font-src 'self'")
      // api.rawg.io is where media.rawg.io redirects images it does not hold; a redirect target
      // must satisfy the policy itself, so both hosts are named.
      expect(csp).toContain("img-src 'self' data: https://media.rawg.io https://api.rawg.io")
      expect(csp).toContain('https://video.akamai.steamstatic.com')
      expect(csp).toContain("worker-src 'self' blob:")
      // hls.js attaches its MediaSource as a blob: URL on the <video> element, which media-src
      // governs — not worker-src. Without it the trailer silently never plays off Safari.
      expect(csp).toContain('media-src')
      expect(csp.split('; ').find((d) => d.startsWith('media-src'))).toContain('blob:')

      // Nuxt inlines two scripts per page; the Nitro plugin hashes exactly those, so `script-src`
      // never falls back to 'unsafe-inline' (which would defeat the point) and never allows eval.
      const scriptSrc = csp.split('; ').find((directive) => directive.startsWith('script-src'))!
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(scriptSrc).not.toContain('unsafe-eval')
      expect(scriptSrc.match(/'sha256-[^']+'/g) ?? []).toHaveLength(2)

      // Every executable inline script in the body must be covered by a hash in the header — the
      // property the whole arrangement exists for, checked against the markup actually served.
      const html = await fetch(path, { headers: { accept: 'text/html' } }).then((r) => r.text())
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter(([, tag]) => !tag!.includes('application/json'))
        .map(([, , body]) => body!)
      expect(inline).toHaveLength(2)
      for (const body of inline) {
        const hash = createHash('sha256').update(body, 'utf8').digest('base64')
        expect(scriptSrc).toContain(`'sha256-${hash}'`)
      }

      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('permissions-policy')).toContain('camera=()')
    }
  })

  it(
    'never nests a <ul> inside a <p> on a page with game cards: a browser auto-closes an open ' +
      '<p> the moment it meets a block element like <ul> (even nested a level or two deeper), ' +
      'silently hoisting the rest out as following siblings — the server HTML would still look ' +
      'right, but the browser-parsed DOM would already differ from it before hydration ever runs, ' +
      'so hydration would warn of a mismatch that has nothing to do with data or timing. GameCard ' +
      'used to wrap its "year · platforms" row in a <p>, and PlatformIcons in `responsive` mode ' +
      'renders three <ul>s inside it — this asserts that row is not a <p> on every page that shows ' +
      'game cards.',
    async () => {
      for (const path of ['/', '/games', '/games/the-witcher-3-wild-hunt']) {
        const html = await $fetch<string>(path)
        // A coarse "no <ul>/<ol>/<table>/<div> opens between an unclosed <p> and its </p>" check
        // would need a real parser; the specific regression here is narrower and easy to assert
        // directly: the exact row that used to be a <p> wrapping a responsive PlatformIcons must
        // not be one.
        expect(html).not.toMatch(
          /<p[^>]*class="flex flex-nowrap items-center gap-1 overflow-hidden text-sm text-fg-2"[^>]*>/,
        )
      }
    },
  )
})
