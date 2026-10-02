import { describe, expect, it } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

// Build-time defaults and runtime overrides: the server under test never calls RAWG, answers
// `/api/ask` from its recorded provider, and publishes the seeded index with old prices.
process.env.RAWG_FIXTURES = '1'
process.env.INDEX_FIXTURE_STALE = '1'

/**
 * The ask page when the index's prices have gone stale, against the real endpoint: the answer
 * declines the price filter it understood, and the page says so in the catalog's words — the
 * struck-through chip with its reason, and the catalog's stale banner. The answer alone cannot
 * tell stale prices from a silent index here (no other index filter was asked for); the page's
 * freshness read from the catalog can.
 */

const COOP = 'кооператив для двох на Switch до 500 грн'

function text(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('the ask page on stale prices', async () => {
  await setup({
    server: true,
    browser: false,
    env: {
      RAWG_FIXTURES: '1',
      NUXT_RAWG_FIXTURES: '1',
      INDEX_FIXTURE_STALE: '1',
      NUXT_INDEX_FIXTURE_STALE: '1',
    },
  })

  it('reports the index freshness alone for a page past the end', async () => {
    const response = await $fetch<{ data: { games: { indexStale: boolean } } }>('/api/graphql', {
      method: 'POST',
      body: { query: '{ games(page: 0, pageSize: 1) { indexStale } }' },
    })
    expect(response.data.games.indexStale).toBe(true)
  })

  it('strikes the declined price through with the stale reason, under the stale banner', async () => {
    const html = await $fetch<string>(`/ask?q=${encodeURIComponent(COOP)}`)
    const ignored = /data-test="ignored-chip"[\s\S]*?<\/li>/.exec(html)?.[0] ?? ''
    expect(ignored).toContain('<s')
    expect(text(ignored)).toContain('до 500 ₴ не застосовано: ціни тимчасово не оновлюються')
    expect(text(html)).toContain('Ціни тимчасово не оновлюються')
    expect(html).toContain('data-test="stale-banner"')
    // The understood filters the catalog did apply stay plain chips.
    expect(text(html)).toContain('Локальний кооператив')
  })
})
