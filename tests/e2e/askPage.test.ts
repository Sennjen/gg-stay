import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import {
  FALLBACK_QUERY,
  HOSTILE_QUERY,
  RATE_LIMITED_QUERY,
  STRUCTURED_QUERY,
} from '../fixtures/ask/answers'

// Build-time default and runtime override, so the server under test never calls RAWG.
process.env.RAWG_FIXTURES = '1'

/**
 * The ask page as a server renders it, against the recorded stand-in for `POST /api/ask`
 * (`tests/fixtures/ask/stubHandler.ts`, mounted for this build only): a URL with `q` is answered
 * in the HTML itself, so a shared link opens on its results; it is kept out of the index while the
 * page without a question is not; and the model's words reach the page as text.
 */

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

async function page(path: string) {
  const response = await fetch(path, { headers: { accept: 'text/html' } })
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
    env: { RAWG_FIXTURES: '1', NUXT_RAWG_FIXTURES: '1' },
    nuxtConfig: {
      serverHandlers: [
        {
          route: '/api/ask',
          method: 'post',
          handler: fileURLToPath(new URL('../fixtures/ask/stubHandler.ts', import.meta.url)),
        },
      ],
    },
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
    const { response, body, ...head } = await page(askUrl(STRUCTURED_QUERY))
    expect(response.status).toBe(200)
    expect(head.robots).toBe(NOT_INDEXABLE)
    // The canonical is the page without the question.
    expect(head.canonical).toBe(`${SITE}/ask`)
    expect(head.title).toBe(`«${STRUCTURED_QUERY}» — підбір ігор — GG Stay`)

    expect(text(body)).toContain('Кооперативні ігри для двох на Nintendo Switch до 500 ₴')
    expect(text(body)).toContain('Чому підходить: Хаотична кухня на двох за одним екраном')
    expect(text(body)).toContain('Підібрали 3 гри')
    expect(decode(body)).toContain('href="/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500"')
    // The field shows the question, and nothing is left in a loading state for hydration to fix.
    expect(decode(/<textarea[^>]*>([^<]*)<\/textarea>/.exec(body)?.[1] ?? '')).toBe(
      STRUCTURED_QUERY,
    )
    expect(body).not.toContain('aria-busy')
  })

  it('renders the fallback note and the rate-limit wait on the server too', async () => {
    expect(text((await page(askUrl(FALLBACK_QUERY))).body)).toContain(
      'ІІ-розбір зараз недоступний — показуємо звичайний пошук',
    )
    // The seconds come from the stub's Retry-After header, read on the server.
    const limited = await page(askUrl(RATE_LIMITED_QUERY))
    expect(limited.response.status).toBe(200)
    expect(text(limited.body)).toContain('Спробуйте ще раз за 42 секунди.')
  })

  it('asks in English on the English page', async () => {
    const { html, body } = await page(askUrl(STRUCTURED_QUERY, '/en'))
    expect(html).toMatch(/<html[^>]*lang="en-US"/)
    expect(text(body)).toContain('How we read it:')
    expect(text(body)).toContain('Open in the catalog')
    expect(decode(body)).toContain('href="/en/games?platforms=7')
  })

  it('puts no block element inside a paragraph, in any state', async () => {
    for (const path of [
      '/ask',
      askUrl(STRUCTURED_QUERY),
      askUrl(FALLBACK_QUERY),
      askUrl(RATE_LIMITED_QUERY),
      askUrl('гра про бджолярство на Dreamcast'),
    ]) {
      expect(blocksInsideParagraphs((await page(path)).body), path).toEqual([])
    }
  })

  it('shows markup in the model text as text, and runs no script it did not hash', async () => {
    const { response, html, body } = await page(askUrl(HOSTILE_QUERY))
    expect(body).not.toContain('<script>alert')
    expect(body).not.toContain('<img src=x')
    expect(text(body)).toContain('</p><script>alert("ask")</script>')

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
