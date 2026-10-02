import { describe, expect, it } from 'vitest'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { API_CONTENT_SECURITY_POLICY } from '../../server/security/headers'

// Build-time default and runtime override, so the server under test never calls RAWG — and, in
// fixture mode, answers `/api/ask` from the recorded provider rather than the Anthropic API.
process.env.RAWG_FIXTURES = '1'

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/ask in fixture mode', async () => {
  await setup({
    server: true,
    browser: false,
    env: { RAWG_FIXTURES: '1', NUXT_RAWG_FIXTURES: '1' },
  })

  it('answers the acceptance query with the understood filter and a Ukrainian interpretation', async () => {
    const response = await post({ q: 'кооператив для двох на Switch до 500 грн', locale: 'uk' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer).toMatchObject({
      mode: 'structured',
      interpretation: 'Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
      filter: { gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500 },
      catalogUrl: '/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500',
    })
    expect(Array.isArray(answer.items)).toBe(true)
    expect(typeof answer.tookMs).toBe('number')
  })

  it('answers ranked cards with reasons from the seeded index', async () => {
    const response = await post({ q: 'атмосферний горор українською', locale: 'uk' })
    const answer = (await response.json()) as {
      mode: string
      items: { card: { id: string; name: string }; reason: string | null }[]
    }
    expect(answer.mode).toBe('structured')
    expect(answer.items.map((item) => item.card.id)).toEqual(['13537', '41494', '3328'])
    expect(answer.items[0]!.reason).toBe('Гнітюча атмосфера Сіті 17, українські субтитри')
  })

  it('falls back to a plain search for a query nobody recorded', async () => {
    const response = await post({ q: 'щось як Hades, але коротше', locale: 'en' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      mode: 'fallback',
      interpretation: null,
      filter: { search: 'щось як Hades, але коротше' },
    })
  })

  it('refuses an invalid body with a 400', async () => {
    expect((await post({ q: '', locale: 'uk' })).status).toBe(400)
    expect((await post('{not json')).status).toBe(400)
    expect(
      (await post({ q: 'co-op', locale: 'uk' }, { 'content-type': 'text/plain' })).status,
    ).toBe(400)
  })
})
