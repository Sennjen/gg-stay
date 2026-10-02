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
  indexedOnly: true,
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

/** Stale prices: the price filter and the price sort were declined, localisation was applied. */
export const STALE_QUERY = 'дешеві ігри українською'

export const STALE_ANSWER = {
  ...STRUCTURED_ANSWER,
  interpretation: 'Ігри з українським текстом до 300 ₴, спочатку дешевші',
  filter: { priceMaxUah: 300, ukrainianLocalisation: 'TEXT' },
  catalogUrl: '/games?priceMaxUah=300&ukrainianLocalisation=TEXT&sort=PRICE_ASC',
  ignoredFilters: ['priceMaxUah', 'sort'],
  indexStale: true,
} as const

/** A structured answer whose rerank failed: the retrieval order, every reason null. */
export const UNRANKED_QUERY = 'кооператив без пояснень'

export const UNRANKED_ANSWER = {
  ...STRUCTURED_ANSWER,
  items: STRUCTURED_ANSWER.items.map((item) => ({ ...item, reason: null })),
} as const

/** Model-written text that carries markup, which must reach the page as text. */
export const MARKUP_QUERY = 'розмітка у відповіді'

export const MARKUP_ANSWER = {
  ...STRUCTURED_ANSWER,
  interpretation: '<b>жирно</b><script>alert("ask")</script>',
  items: [{ ...STRUCTURED_ANSWER.items[0], reason: '<img src=x onerror=alert(1)>' }],
} as const

/**
 * Only a price filter was declined, beside filters the index never owns: which filters were
 * declined cannot tell stale prices from an index that did not answer, so the answer says.
 */
export const PRICE_ONLY_QUERY = 'кооператив на Switch до 500 грн, ціни застарілі'

export const PRICE_ONLY_ANSWER = {
  ...STRUCTURED_ANSWER,
  ignoredFilters: ['priceMaxUah'],
  indexStale: true,
} as const

/** The same declined price, from an index that did not answer (prices not stale). */
export const PRICE_ONLY_SILENT_QUERY = 'кооператив на Switch до 500 грн, індекс мовчить'

export const PRICE_ONLY_SILENT_ANSWER = {
  ...PRICE_ONLY_ANSWER,
  indexStale: false,
} as const

/** A "like X" answer: ranked cards, but nothing the catalog's URL can express. */
export const LIKE_QUERY = 'щось як The Witcher 3'

export const LIKE_ANSWER = {
  ...STRUCTURED_ANSWER,
  interpretation: 'Ігри, схожі на The Witcher 3: Wild Hunt',
  filter: {},
  catalogUrl: '/games',
} as const

/** Nothing to look for: structured, no filter, no cards. */
export const NOTHING_QUERY = 'привіт'

export const NOTHING_ANSWER = {
  ...STRUCTURED_ANSWER,
  interpretation: null,
  filter: {},
  catalogUrl: '/games',
  items: [],
} as const
