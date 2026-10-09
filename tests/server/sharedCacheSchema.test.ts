import { describe, expect, it } from 'vitest'
import { withoutLinkQueries } from '../../server/rawg/paginationLinks'
import { createRawgFetch, type CacheEntry } from '../../server/rawg/rawgFetch'
import { projectAppDetails } from '../../server/steam/appDetailsProjection'
import { createSteamFetch } from '../../server/steam/steamFetch'
import { SHARED_CACHE_SCHEMA } from '../../server/upstream/layeredCache'
import { createResolverCache } from '../../server/utils/resolverCache'
import { DEV_FIXTURE_GAMES } from '../fixtures/index/devGames'
import { createTestCache, publishTestIndex, runQuery, steamPricesReturning } from './support/yoga'

/**
 * A tripwire, not a specification.
 *
 * The cache every instance shares outlives a deployment: what one build stores, the next build
 * reads. The version in its keys (`SHARED_CACHE_SCHEMA`) is what keeps a build from reading a
 * shape it does not expect — but only if whoever changes a stored shape also changes the version,
 * and the shapes are decided in five different files.
 *
 * So this pins every stored shape TOGETHER WITH the version. When it fails because a shape
 * changed: change `SHARED_CACHE_SCHEMA` in `server/upstream/layeredCache.ts` first, in the same
 * change, and then bring this file up to date. Updating the shape below without the version is
 * the mistake this test exists to stop.
 */

/** The shape of a value: its keys in order, and the kind of thing each holds. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])]
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, shapeOf(record[key])]),
  )
}

/** A cache that keeps what it is handed, so a case can look at an entry as it would be stored. */
function capturing() {
  const entries = new Map<string, CacheEntry>()
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, entry: CacheEntry) => void entries.set(key, entry),
  }
}

const runtime = (body: unknown) => ({
  fixtures: false,
  fetchJson: async () => ({ status: 200, body }),
  readFixture: async () => null,
  now: () => 1_000_000,
  sleep: async () => {},
  log: () => {},
})

/**
 * Steam's answer about an app with everything in it the projection keeps, and things it does not:
 * what comes out of the projection is the whole of what is stored.
 */
const STEAM_ANSWER = {
  '292030': {
    success: true,
    data: {
      type: 'game',
      name: 'The Witcher 3: Wild Hunt',
      detailed_description: '<p>…</p>',
      short_description: 'Короткий опис.',
      about_the_game: '<p>Про гру</p>',
      supported_languages: 'English<strong>*</strong>, Ukrainian',
      is_free: false,
      header_image: 'https://example.com/header.jpg',
      price_overview: {
        currency: 'UAH',
        initial: 49_900,
        final: 24_900,
        discount_percent: 50,
        initial_formatted: '499₴',
        final_formatted: '249₴',
        recurring_sub: 0,
      },
      movies: [{ id: 1, name: 'Trailer', highlight: true, hls_h264: 'https://x/1.m3u8?t=1' }],
      screenshots: [{ id: 0 }],
    },
  },
}

const WITCHER = { slug: 'the-witcher-3-wild-hunt' }
const PRICE_QUERY = /* GraphQL */ `
  query Game($slug: String!) {
    game(slug: $slug) {
      stores {
        store
      }
    }
  }
`

/** What the game page leaves in its cache for the live price Steam gave, or for none. */
async function rememberedPrice(price: Parameters<typeof steamPricesReturning>[0]) {
  const cache = createTestCache()
  // The Witcher 3 with a price eight hours old: old enough for the page to ask Steam.
  const index = await publishTestIndex([
    { ...DEV_FIXTURE_GAMES[0]!, priceUpdatedAt: '2026-09-18T01:00:00.000Z' },
  ])
  await runQuery({ index, steamPrices: steamPricesReturning(price), cache }, PRICE_QUERY, WITCHER)
  return cache.entries.get('steam-price:292030')
}

describe('what the shared cache stores, and the version it is stored under', () => {
  it('change together: a new shape is a new SHARED_CACHE_SCHEMA', async () => {
    // An answer as the transport hands it to its cache.
    const rawgCache = capturing()
    await createRawgFetch({ ...runtime({ id: 4200 }), apiKey: 'test-key', cache: rawgCache })(
      'games/portal-2',
    )
    // Steam's page about an app, as its projection keeps it.
    const steamCache = capturing()
    await createSteamFetch({ ...runtime(STEAM_ANSWER), cache: steamCache })('292030')
    // A RAWG list, as the site keeps one.
    const list = withoutLinkQueries({
      count: 2,
      next: 'https://api.rawg.io/api/games?key=test-key&page=2',
      previous: null,
      results: [],
    })
    // A live price as the resolvers' cache wraps it.
    const priceLevel = capturing()
    const resolverCache = createResolverCache({
      pages: capturing() as never,
      prices: priceLevel as never,
      now: () => 1_000_000,
    })
    await resolverCache.set('steam-price:292030', { price: null, fetchedAt: 'then' }, 3_600)

    expect({
      schema: SHARED_CACHE_SCHEMA,
      entry: shapeOf(rawgCache.entries.get('games/portal-2')),
      steamPage: shapeOf(steamCache.entries.get('292030')?.value),
      steamPageAgain: shapeOf(projectAppDetails(STEAM_ANSWER)),
      rawgList: { shape: shapeOf(list), next: (list as { next: string }).next },
      priceEntry: shapeOf(priceLevel.entries.get('steam-price:292030')),
      price: shapeOf(
        await rememberedPrice(async () => ({
          priceUah: 249,
          regularPriceUah: 499,
          discountPercent: 50,
          isFree: false,
        })),
      ),
      noPrice: shapeOf(await rememberedPrice(async () => null)),
    }).toEqual({
      schema: 'v2',
      entry: { expiresAt: 'number', storedAt: 'number', value: { id: 'number' } },
      steamPage: STEAM_PAGE,
      steamPageAgain: STEAM_PAGE,
      rawgList: {
        shape: { count: 'number', next: 'string', previous: 'null', results: [] },
        next: 'https://api.rawg.io/api/games',
      },
      priceEntry: {
        expiresAt: 'number',
        storedAt: 'number',
        value: { fetchedAt: 'string', price: 'null' },
      },
      price: {
        fetchedAt: 'string',
        price: {
          discountPercent: 'number',
          isFree: 'boolean',
          priceUah: 'number',
          regularPriceUah: 'number',
        },
      },
      noPrice: { fetchedAt: 'string', price: 'null' },
    })
  })
})

/** Steam's page about an app, as the projection keeps it. */
const STEAM_PAGE = {
  '292030': {
    data: {
      about_the_game: 'string',
      is_free: 'boolean',
      movies: [{ highlight: 'boolean', hls_h264: 'string' }],
      price_overview: {
        currency: 'string',
        discount_percent: 'number',
        final: 'number',
        final_formatted: 'string',
        initial: 'number',
        initial_formatted: 'string',
      },
      short_description: 'string',
      supported_languages: 'string',
    },
    success: 'boolean',
  },
}
