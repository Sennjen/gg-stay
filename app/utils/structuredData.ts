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
  rating?: number | null
  ratingsCount?: number | null
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
 * An average of fewer ratings than this says little, and a search result that shows four stars
 * from two votes would be promising more than the page knows.
 */
const MIN_RATINGS = 5

/**
 * How old a price may be and still be offered to a search engine. The page itself shows any price
 * it has, with its age beside it; a search result shows the price alone, possibly for days, so it
 * gets only a price the nightly job or the page's own live refresh read within the last day.
 */
export const PRICE_FRESH_MS = 24 * 60 * 60 * 1000

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
  return {
    '@type': 'Offer',
    price: String(steam.priceUah),
    priceCurrency: 'UAH',
    availability: 'https://schema.org/InStock',
    url: steam.url,
  }
}

export function gameJsonLd(
  game: GameForJsonLd,
  options: { url: string; description: string; inLanguage: string; now: string },
): JsonLd {
  const data: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: game.name,
    url: options.url,
  }
  const image = coverShareImage(game.cover?.url)
  if (image) data.image = image.url
  data.description = options.description
  if (game.released) data.datePublished = game.released
  if (game.genres.length) data.genre = names(game.genres)
  if (game.platforms.length) data.gamePlatform = names(game.platforms)
  if (game.publishers.length) data.publisher = organizations(game.publishers)
  if (game.developers.length) data.author = organizations(game.developers)
  if (game.rating && game.ratingsCount && game.ratingsCount >= MIN_RATINGS) {
    // RAWG's own scale: an average of votes out of five.
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: game.rating,
      ratingCount: game.ratingsCount,
      bestRating: 5,
      worstRating: 0,
    }
  }
  const offer = steamOffer(game, options.now)
  if (offer) data.offers = offer
  data.inLanguage = options.inLanguage
  return data
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
