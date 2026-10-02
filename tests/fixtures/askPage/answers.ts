/**
 * Recorded `POST /api/ask` answers for the page's own tests, in the response shape the endpoint
 * promises: `{ mode, interpretation, filter, catalogUrl, items: [{ card, reason }], tookMs }`.
 *
 * The cards carry no cover: the stub must not send a browser to an image CDN, and a card without
 * a cover is a state the card already renders.
 */

function card(id: number, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: String(id),
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    released: '2020-06-01',
    metacritic: 84,
    cover: null,
    screenshots: [],
    platformFamilies: ['PC', 'NINTENDO'],
    price: null,
    localisation: null,
    madeInUkraine: false,
    ...overrides,
  }
}

export const STRUCTURED_QUERY = 'кооператив для двох на Switch до 500 грн'

export const STRUCTURED_ANSWER = {
  mode: 'structured',
  interpretation: 'Кооперативні ігри для двох на Nintendo Switch до 500 ₴',
  filter: { gameModes: ['LOCAL_COOP'], platforms: [7], priceMaxUah: 500 },
  catalogUrl: '/games?platforms=7&gameModes=LOCAL_COOP&priceMaxUah=500',
  items: [
    {
      card: card(1, 'Overcooked! 2', {
        price: {
          bestUah: 199,
          regularUah: 499,
          discountPercent: 60,
          isFree: false,
          updatedAt: '2026-10-01T06:00:00.000Z',
        },
        localisation: { text: true, audio: false, source: 'STEAM' },
      }),
      reason: 'Хаотична кухня на двох за одним екраном',
    },
    {
      card: card(2, 'It Takes Two', { metacritic: 88 }),
      reason: 'Створена лише для двох гравців',
    },
    {
      card: card(3, 'Stardew Valley', { metacritic: 89 }),
      reason: 'Спокійна ферма, яку можна вести вдвох',
    },
  ],
  tookMs: 2140,
} as const

export const FALLBACK_QUERY = 'щось як Hades, але коротше'

export const FALLBACK_ANSWER = {
  mode: 'fallback',
  interpretation: null,
  filter: { search: FALLBACK_QUERY },
  catalogUrl: `/games?search=${encodeURIComponent(FALLBACK_QUERY)}`,
  items: [
    { card: card(4, 'Hades', { metacritic: 93 }), reason: null },
    { card: card(5, 'Hades II', { metacritic: null }), reason: null },
  ],
  tookMs: 310,
} as const

export const EMPTY_QUERY = 'гра про бджолярство на Dreamcast'

export const EMPTY_ANSWER = {
  mode: 'structured',
  interpretation: 'Ігри про бджолярство',
  filter: { search: 'бджолярство' },
  catalogUrl: '/games?search=%D0%B1%D0%B4%D0%B6%D0%BE%D0%BB%D1%8F%D1%80%D1%81%D1%82%D0%B2%D0%BE',
  items: [],
  tookMs: 1800,
} as const

/** A query the stub answers with `429` and this many seconds in `Retry-After`. */
export const RATE_LIMITED_QUERY = 'забагато запитів'
export const RETRY_AFTER_SECONDS = 42

/** A query the stub answers with a `500`. */
export const BROKEN_QUERY = 'зламаний запит'

/** A query whose answer carries markup in its model-written text, which must reach the page as text. */
export const HOSTILE_QUERY = 'розмітка у відповіді'

export const HOSTILE_ANSWER = {
  ...STRUCTURED_ANSWER,
  interpretation: '</p><script>alert("ask")</script>',
  items: [{ ...STRUCTURED_ANSWER.items[0], reason: '<img src=x onerror=alert(1)>' }],
} as const
