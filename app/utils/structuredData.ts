import { rawgImageUrl } from '~/utils/rawgImage'
import { SITE_NAME } from '~/utils/seo'

/**
 * JSON-LD for the landing and the game page, built from the same GraphQL data the page renders —
 * so the structured data can never describe something the page does not show. Pure: the clock is
 * the page's own `now` (read once, carried in the payload), never `Date.now()`.
 */

type JsonLd = Record<string, unknown>

/** The CDN variant used wherever a cover is shared: big enough for a large preview card. */
const SHARE_WIDTH = 1280
/**
 * RAWG's covers (`background_image`) are 16:9 screenshots-sized art, 1920×1080 at the source, so
 * the 1280 variant is 1280×720. The size is a hint for a preview card's layout, stated only for an
 * image this app asked the CDN to resize.
 */
const SHARE_HEIGHT = 720

export interface ShareImage {
  url: string
  width?: number
  height?: number
}

/** The cover as a share image: the 1280 variant with its size, or the original without one. */
export function coverShareImage(cover: string | null | undefined): ShareImage | null {
  if (!cover) return null
  const url = rawgImageUrl(cover, SHARE_WIDTH)
  if (url === cover) return { url }
  return { url, width: SHARE_WIDTH, height: SHARE_HEIGHT }
}

/** The fields of a game page the structured data reads. `GameQuery['game']` satisfies it. */
export interface GameForJsonLd {
  name: string
  released?: string | null
  cover?: { url: string } | null
  platforms: readonly { name: string }[]
  genres: readonly { name: string }[]
  developers: readonly { name: string }[]
  publishers: readonly { name: string }[]
  stores: readonly {
    store: string
    url: string
    priceUah?: number | null
    isFree?: boolean | null
    updatedAt?: string | null
  }[]
}

/**
 * How old a price may be and still be offered to a search engine. The page itself shows any price
 * it has, with its age beside it; a search result shows the price alone, possibly for days, so it
 * gets only a recent one. A day and a half rather than a day: the index is refreshed nightly, and
 * a run that is an hour late must not take every offer away until the next one.
 */
export const PRICE_FRESH_MS = 36 * 60 * 60 * 1000

function organizations(list: readonly { name: string }[]): JsonLd[] {
  return list.map((entry) => ({ '@type': 'Organization', name: entry.name }))
}

function names(list: readonly { name: string }[]): string[] {
  return list.map((entry) => entry.name)
}

function steamOffer(game: GameForJsonLd, now: string): JsonLd | null {
  const steam = game.stores.find((offer) => offer.store === 'steam')
  if (!steam || steam.priceUah == null || !steam.updatedAt) return null
  const age = Date.parse(now) - Date.parse(steam.updatedAt)
  if (!Number.isFinite(age) || age > PRICE_FRESH_MS) return null
  // A Steam price on a game that is not out yet is a pre-order. ISO dates compare as strings.
  const upcoming = Boolean(game.released && game.released > now.slice(0, 10))
  return {
    '@type': 'Offer',
    price: String(steam.priceUah),
    priceCurrency: 'UAH',
    availability: upcoming ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock',
    url: steam.url,
  }
}

/**
 * The game page as a graph of two nodes: the `WebPage`, which is in the page's language, and the
 * `VideoGame` it is about. The language belongs to the page only — the game's own languages are
 * not what the page's locale says, and declaring every game Ukrainian on `/games/…` would be false
 * about the one thing this site is for.
 *
 * There is no `aggregateRating`: the only ratings the page has are RAWG's, and Google's
 * review-snippet rules forbid marking up ratings aggregated from another site.
 */
export function gameJsonLd(
  game: GameForJsonLd,
  options: { url: string; title: string; description: string; inLanguage: string; now: string },
): JsonLd {
  const gameId = `${options.url}#game`
  const video: JsonLd = {
    '@type': 'VideoGame',
    '@id': gameId,
    name: game.name,
    url: options.url,
  }
  const image = coverShareImage(game.cover?.url)
  if (image) video.image = image.url
  video.description = options.description
  if (game.released) video.datePublished = game.released
  if (game.genres.length) video.genre = names(game.genres)
  if (game.platforms.length) video.gamePlatform = names(game.platforms)
  if (game.publishers.length) video.publisher = organizations(game.publishers)
  if (game.developers.length) video.author = organizations(game.developers)
  const offer = steamOffer(game, options.now)
  if (offer) video.offers = offer

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${options.url}#webpage`,
        url: options.url,
        name: options.title,
        description: options.description,
        inLanguage: options.inLanguage,
        mainEntity: { '@id': gameId },
      },
      video,
    ],
  }
}

/** The site, and the catalog search a result can offer a search box for. */
export function websiteJsonLd(options: {
  homeUrl: string
  catalogUrl: string
  description: string
  inLanguage: string
}): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: options.homeUrl,
    description: options.description,
    inLanguage: options.inLanguage,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${options.catalogUrl}?search={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  }
}

/**
 * JSON for the inside of a `<script type="application/ld+json">`. The values are third-party text
 * (game names and descriptions come from RAWG and Steam), and the HTML parser ends a script element
 * at the first `</script` whatever the type — so `<` and `>` are written as JSON escapes, which
 * parse back to the same string. `&` and the two line separators JavaScript once treated as line
 * ends are escaped for the same reason any inline JSON escapes them.
 */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
