import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'

// Build-time default and runtime override, so the server under test never calls RAWG — and, in
// fixture mode, `/api/ask` answers from its recorded provider rather than a model.
process.env.RAWG_FIXTURES = '1'

/**
 * The ask page as a server renders it, against the real `POST /api/ask` in fixture mode
 * (`tests/fixtures/ask/recorded.json`): a URL with `q` is answered in the HTML itself, so a shared
 * link opens on its results; it is kept out of the index while the page without a question is
 * not; the server render forwards the visitor's address, so the endpoint's rate limit counts the
 * visitor and not the server; and text that came from the URL reaches the page as text.
 */

/** Recorded: structured, three ranked cards with reasons. */
const HORROR = 'атмосферний горор українською'
/** Recorded: structured with the acceptance filter, and no cards in the seeded index. */
const COOP = 'кооператив для двох на Switch до 500 грн'
const COOP_EN = 'co-op for two on Switch under 500 UAH'
/** Not recorded: the endpoint falls back to a plain search. */
const UNKNOWN = 'щось як Hades, але коротше'

const SITE = 'http://localhost:3000'
const INDEXABLE = 'index, follow, max-image-preview:large'
const NOT_INDEXABLE = 'noindex, follow'

const askUrl = (query: string, prefix = '') => `${prefix}/ask?q=${encodeURIComponent(query)}`

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * A fresh visitor address per request unless one is given: the endpoint allows ten questions a
 * minute per address, and this suite asks more than that. The address travels the way Vercel
 * reports it, in `x-vercel-forwarded-for` (the server runs with `VERCEL=1`, the only setting in
 * which the endpoint reads a header at all). `spoofed` adds a client-chosen `x-forwarded-for`.
 */
let visitor = 0
const nextAddress = () => `198.51.100.${++visitor}`

async function page(path: string, address: string = nextAddress(), spoofed?: string) {
  const headers: Record<string, string> = {
    accept: 'text/html',
    'x-vercel-forwarded-for': address,
  }
  if (spoofed) headers['x-forwarded-for'] = spoofed
  const response = await fetch(path, { headers })
  const html = await response.text()
  const head = html.slice(0, html.indexOf('</head>'))
  const meta = (name: string) =>
    decode(new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`).exec(head)?.[1] ?? '')
  return {
    response,
    html,
    // The rendered app alone, without the payload that follows it.
    body: html.slice(
      html.indexOf('<div id="__nuxt">'),
      html.indexOf('<script type="application/json"'),
    ),
    title: decode(/<title>([^<]*)<\/title>/.exec(head)?.[1] ?? ''),
    robots: meta('robots'),
    canonical: /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/.exec(head)?.[1],
  }
}

/** The visible text of an HTML fragment, whitespace collapsed. */
function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const BLOCK = new Set(
  'address article aside blockquote details div dl fieldset figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table ul'.split(
    ' ',
  ),
)

/**
 * Every block element the markup opens while a `<p>` is still open. A browser parsing that HTML
 * closes the `<p>` right there and hoists the rest out of it, so the DOM it hydrates is not the
 * one the server rendered — the hydration bug this project has already had once.
 */
function blocksInsideParagraphs(html: string): string[] {
  const offenders: string[] = []
  let open = 0
  // Comments go first: the templates' own comments talk about `<p>` and `<ul>` in prose.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of markup.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const [, closing, name] = match
    // The offending tag with what precedes it, so a failure says where it is.
    const tag = markup.slice(Math.max(match.index - 120, 0), match.index + match[0].length)
    const element = name!.toLowerCase()
    if (element === 'p') {
      if (closing) open = Math.max(open - 1, 0)
      else if (open) offenders.push(tag)
      else open = 1
      continue
    }
    if (open && !closing && BLOCK.has(element)) offenders.push(tag)
  }
  return offenders
}

describe('the ask page on the server', async () => {
  await setup({
    server: true,
    browser: false,
    // `VERCEL` at run time only: the endpoint keys clients by Vercel's headers when it is set.
    env: { RAWG_FIXTURES: '1', NUXT_RAWG_FIXTURES: '1', VERCEL: '1' },
  })

  it('serves the page without a question as an indexable page with a form', async () => {
    for (const [path, title, canonical] of [
      ['/ask', 'Опишіть гру словами — GG Stay', `${SITE}/ask`],
      ['/en/ask', 'Describe a game in your own words — GG Stay', `${SITE}/en/ask`],
    ] as const) {
      const { response, body, ...head } = await page(path)
      expect(response.status).toBe(200)
      expect(head.title).toBe(title)
      expect(head.robots).toBe(INDEXABLE)
      expect(head.canonical).toBe(canonical)
      expect(body).toMatch(/<textarea[^>]*maxlength="200"/)
      expect(body).not.toContain('data-test="ask-results"')
    }
  })

  it('answers a question from the URL in the HTML itself, out of the index', async () => {
    const { response, body, ...head } = await page(askUrl(HORROR))
    expect(response.status).toBe(200)
    expect(head.robots).toBe(NOT_INDEXABLE)
    // The canonical is the page without the question.
    expect(head.canonical).toBe(`${SITE}/ask`)
    expect(head.title).toBe(`«${HORROR}» — підбір ігор — GG Stay`)

    expect(text(body)).toContain(
      'Як ми зрозуміли запит: Атмосферні горори з українською локалізацією',
    )
    expect(text(body)).toContain('Зрозумілий фільтр: Українська: будь-яка')
    expect(text(body)).toContain('Підібрали 3 гри')
    expect(text(body)).toContain(
      'Чому підходить: Сіті 17 під окупацією: гнітючі вулиці, хедкраби й тиша перед бурею',
    )
    expect((body.match(/data-test="ask-reason"/g) ?? []).length).toBe(3)
    expect(decode(body)).toContain('href="/games?ukrainianLocalisation=ANY"')
    // The field shows the question, and nothing is left in a loading state for hydration to fix.
    expect(decode(/<textarea[^>]*>([^<]*)<\/textarea>/.exec(body)?.[1] ?? '')).toBe(HORROR)
    expect(body).not.toContain('aria-busy')
  })

  it('shows what it understood and the empty state when the catalog has nothing for it', async () => {
    const { body } = await page(askUrl(COOP))
    expect(text(body)).toContain(
      'Як ми зрозуміли запит: Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
    )
    expect(text(body)).toContain('Нічого не підібрали')
    expect(body).not.toContain('data-test="ask-item"')
    expect(decode(body)).toContain('href="/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500"')
  })

  it('says calmly that the AI part did not run for a question it cannot read', async () => {
    const { body } = await page(askUrl(UNKNOWN))
    expect(text(body)).toContain('ШІ-розбір зараз недоступний — показуємо звичайний пошук')
    expect(text(body)).toContain(`Звичайний пошук: «${UNKNOWN}»`)
    expect(body).not.toContain('data-test="ask-interpretation"')
    expect(body).not.toContain('data-test="ask-reason"')
  })

  it('explains a question the endpoint refused as too long', async () => {
    const { response, body } = await page(askUrl('а'.repeat(201)))
    expect(response.status).toBe(200)
    expect(text(body)).toContain('Запит задовгий: щонайбільше 200 символів.')
    expect(body).toContain('role="alert"')
  })

  it('asks in English on the English page, and links the English catalog', async () => {
    const { html, body } = await page(askUrl(COOP_EN, '/en'))
    expect(html).toMatch(/<html[^>]*lang="en-US"/)
    expect(text(body)).toContain('How we read it: Co-op games for two on Nintendo')
    expect(text(body)).toContain('Nothing matched')
    expect(decode(body)).toContain(
      'href="/en/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500"',
    )
  })

  it("forwards Vercel's client address, so the rate limit counts visitors, not server renders", async () => {
    // The endpoint allows a burst of ten per address. Eleven renders from one visitor, each with a
    // different client-chosen `x-forwarded-for`: the last is still refused, because the key is the
    // forwarded `x-vercel-forwarded-for` — and the page says when to try again.
    const busy = '203.0.113.10'
    for (let render = 0; render < 10; render += 1) {
      const { body } = await page(askUrl(UNKNOWN), busy, `192.0.2.${render + 1}`)
      expect(text(body)).toContain('ШІ-розбір')
    }
    expect(text((await page(askUrl(UNKNOWN), busy, '192.0.2.99')).body)).toMatch(
      /Забагато запитів поспіль\. Спробуйте ще раз за \d+ секунд/,
    )
    // Another visitor is unaffected. Without the forwarded header both would be one address.
    expect(text((await page(askUrl(UNKNOWN), '203.0.113.11')).body)).toContain('ШІ-розбір')
  })

  it('puts no block element inside a paragraph, in any state', async () => {
    for (const path of [
      '/ask',
      askUrl(HORROR),
      askUrl(COOP),
      askUrl(UNKNOWN),
      askUrl('а'.repeat(201)),
    ]) {
      expect(blocksInsideParagraphs((await page(path)).body), path).toEqual([])
    }
  })

  it('shows markup typed into the question as text, and runs no script it did not hash', async () => {
    const hostile = '</p><script>alert("ask")</script><img src=x onerror=alert(1)>'
    const { response, html, body } = await page(askUrl(hostile))
    expect(body).not.toContain('<script>alert')
    expect(body).not.toContain('<img src=x')
    expect(text(body)).toContain(`«${hostile}»`)

    const csp = response.headers.get('content-security-policy')!
    const scriptSrc = csp.split('; ').find((directive) => directive.startsWith('script-src'))!
    expect(scriptSrc).not.toContain('unsafe-inline')
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, tag]) => !/type="application\/(?:ld\+)?json"/.test(tag!))
      .map(([, , script]) => script!)
    expect(inline.length).toBeGreaterThan(0)
    for (const script of inline) {
      const hash = createHash('sha256').update(script, 'utf8').digest('base64')
      expect(scriptSrc).toContain(`'sha256-${hash}'`)
    }
  })
})
