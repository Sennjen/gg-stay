import type { AgeRatingValue, GameModeValue, PlaytimeValue } from '../../shared/catalog'

/**
 * The card document the index stores per game, and the run metadata published beside it. Reader
 * and writer share these shapes, so both adapters and the refresh job agree on what a game in the
 * index looks like without importing each other.
 */

export interface IndexedLocalisation {
  /** The game's interface or subtitles are available in Ukrainian. */
  text: boolean
  /** The game is voiced in Ukrainian. */
  audio: boolean
  /** Where the flags came from, e.g. `steam`. */
  source: string
  /**
   * ISO timestamp of the read the flags came from. The refresh job re-reads a game's languages
   * only when this is missing or older than a week — the list needs one unfiltered Steam request
   * per game and changes very rarely — and carries the flags forward from the published version
   * otherwise. Optional: a document written before the job existed simply looks stale.
   */
  updatedAt?: string
}

/** The longest store title an offer carries, in characters. Real ones are a few dozen. */
export const MAX_OFFER_TITLE_LENGTH = 200

/**
 * The stores, other than Steam, whose price the refresh job reads: RAWG's own slugs for them.
 *
 * What the job reads and what a page shows are two lists. This one is the job's and the
 * document's; the site keeps its own (`PAGE_OFFER_STORES`, `server/index/offerRules.ts`), so a
 * store can be published before any page knows what to do with its offers.
 */
export const OFFER_STORES = ['gog', 'xbox-store', 'playstation-store'] as const
export type OfferStore = (typeof OFFER_STORES)[number]

/**
 * What one store other than Steam charges a buyer in Ukraine for the game, as the refresh job read
 * it from the store itself (`scripts/index/offers.ts`).
 *
 * The amounts are in minor units — cents, kopecks — and in the currency the store charges
 * Ukraine in: GOG in US dollars, the Microsoft Store and the PlayStation Store in hryvnia. A
 * dollar amount is never converted here and never stored as hryvnia: what a visitor is shown
 * beside it is an estimate made when the page is, from `IndexMeta.exchangeRate`.
 *
 * `regularAmount` is the price without the discount and is never below `amount`; the two are
 * equal, and `discountPercent` is 0, when the game is not on sale. A free game is an offer of 0.
 *
 * `url` is the store's own address for the product — GOG's `storeLink`, Microsoft's product page
 * for Ukraine, the PlayStation Store's page for Ukraine — and has been through `safeExternalUrl`,
 * like every other outbound link.
 *
 * `title` is what the store itself calls the product. RAWG's link sometimes names another edition
 * than the game it is filed under — a complete season, a "Game of the Year Edition" — and the
 * price is that edition's; the title is how a page can say so. Plain text, trimmed, at most
 * `MAX_OFFER_TITLE_LENGTH` characters; left out when the store gave none. For the PlayStation
 * Store it is more than an edition: the price is that of the product Sony puts first for the
 * game's concept, which is sometimes another product altogether (`scripts/index/playstation.ts`).
 *
 * `updatedAt` is when the store was last read and gave this price. A read that failed leaves the
 * offer and its date as they were, so an old date is exactly an old price: the site shows no
 * price it cannot call fresh.
 *
 * `saleEndsAt` is when the store said the discount ends. The PlayStation Store is read once a
 * day, so without it an offer would go on quoting a sale for up to two days after the sale was
 * over; with it, whoever shows the offer knows the moment from which `regularAmount` is the
 * price. Only on an offer that is below its regular price, and only when the store named the
 * moment; any store may carry it, and today only the PlayStation Store does.
 */
export interface IndexedOffer {
  store: OfferStore
  title?: string
  amount: number
  regularAmount: number
  currency: 'USD' | 'UAH'
  discountPercent: number
  url: string
  /** ISO timestamp of the read the price came from. */
  updatedAt: string
  /** ISO timestamp; after it the offer's price is its regular price. */
  saleEndsAt?: string
}

export interface IndexedGame {
  id: number
  slug: string
  name: string
  cover: string | null
  /**
   * One screenshot for the card's hover preview, or `null` when RAWG's list response carried
   * none. It comes from `short_screenshots` on the same page the candidate was read from, so it
   * costs no request of its own, and it deliberately never repeats the cover: RAWG's list puts
   * the cover in that array under the id `-1`, and a preview identical to the image already on
   * the card would make the hover look broken.
   */
  preview: string | null
  /** ISO date (`YYYY-MM-DD`); `null` when the release date is unknown. */
  released: string | null
  /** RAWG's "added" count — the popularity score and the tie-break of every sort. */
  popularity: number
  platforms: number[]
  genres: string[]
  /**
   * RAWG's English tags for the game, without the ones that describe the store (achievements,
   * controller support, cloud saves) or repeat `gameModes`, at most twelve. The refresh job ranks
   * similar games on them; no query filters on them. Optional: documents published before the
   * job mapped tags have none.
   */
  tags?: string[]
  /**
   * The mood and sub-genre tags (`shared/moodTags.ts`) RAWG gives the game, all of them — unlike
   * `tags`, which keeps only the rarest few for the similarity ranking and so drops the broad ones
   * ("horror", "atmospheric") a visitor actually asks for. `/api/ask` filters on these through the
   * `f:tag:*` facets. Optional: documents published before the job mapped them have none, and the
   * facet then falls back to the mood tags among `tags`.
   */
  moodTags?: string[]
  stores: string[]
  gameModes: GameModeValue[]
  ageRating: AgeRatingValue | null
  rating: number | null
  ratingsCount: number
  metacritic: number | null
  /** Average playtime in hours. */
  playtime: number | null
  /** Current price in whole hryvnia; `null` when no price is known. */
  priceUah: number | null
  regularPriceUah: number | null
  discountPercent: number
  free: boolean
  localisation: IndexedLocalisation | null
  madeInUkraine: boolean
  /**
   * The RAWG developer slugs of the studio list the refresh job found this game under, when it is
   * flagged. It lets a run that cannot read a studio tonight keep that studio's games as they were
   * published. Optional: documents published before it existed, and unflagged games, have none.
   */
  studioSlugs?: string[]
  /**
   * When the refresh job last found this game under one of `studioSlugs` (ISO timestamp). A game
   * kept only because its slug answered nothing is dropped a week after this.
   */
  studioSeenAt?: string
  /** ISO timestamp of the last successful price read. */
  priceUpdatedAt: string | null
  /**
   * The game's Steam app id, so the game page can ask Steam for a live price, and name the Steam
   * store page, without waiting for RAWG's store links.
   *
   * One rule, whichever kind of run published the document: the field is there whenever the
   * permanent RAWG-id-to-app-id mapping (`appid:{rawgId}`) holds an app id for the game, and only
   * then. Every run copies it from that mapping — full, prices-only and languages alike — and a
   * full run reads the mapping for the games RAWG does not list on Steam that night as well
   * (`appIdsForDocuments`), so a game does not lose the field at night and regain it with the
   * morning's prices. Never the mapping's empty string: a game the job knows to have no Steam
   * page, like one it has not resolved yet, simply has no `steamAppId`.
   *
   * It says which Steam app the game is, not that RAWG lists the game on Steam today — `stores`
   * says that — and it does not decide what a run prices: a full run still prices the games RAWG
   * lists on Steam that night.
   *
   * Optional: documents published before the job copied it have none, and the page then takes
   * the id from RAWG's store links, as it always has.
   */
  steamAppId?: string
  /**
   * The ids of the games most like this one, best first, all of them in the same version: the
   * refresh job's full run ranks them over the whole index (`scripts/index/similarity.ts`) and the
   * other runs carry them forward. The game page reads them with one `getMany`. Optional:
   * documents published before the job computed them have none, and the page then falls back to
   * games of the same genre.
   */
  similar?: number[]
  /**
   * What GOG, the Microsoft Store and the PlayStation Store charge for the game in Ukraine: at
   * most one offer a store, and only for a store the permanent mapping of store references
   * (`storeref:{rawgId}`) names a product of. Steam's price is not among them; it stays in
   * `priceUah` and its neighbours.
   *
   * Left out, not written empty, for a game no store has a price for. Optional as well because
   * documents published before the job read these stores have none.
   */
  offers?: IndexedOffer[]
}

/**
 * What Steam said about one app's languages, kept outside the version prefix under
 * `lang:{appId}` so it survives publications. It is the refresh job's work list: an app with no
 * record, or a record older than a week, is due; everything else is applied from here without a
 * request. Storing the answer rather than a position in a list is what makes the language stage
 * resumable — a run that dies has still saved every app it read.
 */
export interface IndexedLanguages {
  text: boolean
  audio: boolean
  /** Steam's `is_free`, which is the only thing that tells a free game from an unsold one. */
  isFree: boolean
  /** ISO timestamp of the read. */
  updatedAt: string
}

/**
 * Which product a game is in the stores whose prices the job reads, kept outside the version
 * prefix under `storeref:{rawgId}` beside the Steam app ids, and for as long: RAWG is asked for a
 * game's store links once for each store it lists the game on.
 *
 * Each field is what RAWG's own link to that store carried, and nothing else — nothing is guessed
 * from a title — and each has three states, because "asked" is remembered store by store:
 *
 * - a value: the link named a product;
 * - `null`: RAWG lists the game on the store and gave no link the job can read. That is an answer,
 *   and the game is not asked about that store again;
 * - absent: the game has not been asked about the store — RAWG did not list it there when its
 *   links were last read, or they never were. A game that gains the store later is asked then.
 *
 * The PlayStation Store's field holds more than RAWG's link gave, because RAWG's link is not
 * enough there: it names a title, and Sony prices a concept. What Sony answered about the title
 * is kept beside it, and is Sony's and the job's own — a record rewritten from RAWG's links keeps
 * it for as long as the links still name the same title (`storeRefsFromLinks`).
 */
export interface IndexedStoreRefs {
  /** The slug of the game's GOG page: the path segment after `/game/` in RAWG's link. */
  gog?: string | null
  /** The game's Microsoft Store product, from RAWG's link to it. */
  microsoft?: {
    /** The twelve-character product id, in upper case, as the display catalog spells it. */
    id: string
    /** The name the link carried before the id. Microsoft's product page is addressed by both. */
    name: string
  } | null
  /** The game's PlayStation 4 or PlayStation 5 title, from RAWG's link to the PlayStation Store. */
  playstation?: {
    /** The title id in the middle of the product id RAWG's link carries: `CUSA00419_00`. */
    titleId: string
    /**
     * Sony's concept for the title, which is what its store prices and is the same in every
     * region: a number when the title has one in the Ukrainian store; `null` when Sony answered
     * that it has none, and the title is not asked about again; absent while Sony has not been
     * asked yet (`scripts/index/playstationOffers.ts`).
     */
    conceptId?: number | null
    /**
     * When Sony last answered about the concept with no price anyone can pay (ISO timestamp). A
     * game with such an answer has no offer to carry the date of its read, and would otherwise
     * look like one never read: asked about first, by every run. With it, it is asked about once
     * a day like any other.
     */
    unpricedAt?: string
  } | null
}

/**
 * The National Bank of Ukraine's official rate of one currency, as the refresh job read it. It
 * turns a price in that currency into an estimate in hryvnia, and nothing else: no filter, no
 * sort and no stored price is ever made with it.
 */
export interface IndexedExchangeRate {
  currency: 'USD'
  /** Hryvnia for one unit of the currency. */
  uah: number
  /** The day the bank's rate is for (`YYYY-MM-DD`): what a visitor is told the estimate rests on. */
  date: string
  /**
   * ISO timestamp of the read. A run that cannot read the bank keeps the rate it found published
   * for seven days counted from here, and publishes none after that.
   */
  readAt: string
}

export interface IndexRunStats {
  gamesIndexed: number
  pricesFetched: number
  languagesFetched: number
  failures: number
  durationMs: number
  /** Games published with a price. The blue/green check refuses a run that drops this to zero. */
  pricedCount: number
  /** Games published with Ukrainian text, and with Ukrainian audio. */
  textCount: number
  audioCount: number
  /** Games published with the made-in-Ukraine flag. */
  madeInUkraineCount: number
  /** Games published with a non-empty similar-games list, and the median length over all games. */
  similarCount: number
  similarMedianLength: number
  /**
   * Games that came from RAWG's popularity list, as opposed to the studio games a full run adds to
   * it. The blue/green game-count check is measured on this, so studio games cannot hide a
   * collapsed candidate list.
   */
  candidateCount: number
  /** Games published with a GOG offer, with a Microsoft Store one, and a PlayStation Store one. */
  gogOfferCount: number
  microsoftOfferCount: number
  playstationOfferCount: number
}

export interface IndexMeta {
  version: number
  /** ISO timestamp of the publication. Every publication moves it, whatever the run refreshed. */
  updatedAt: string
  /**
   * When the prices in this version were last confirmed — not when they were last written.
   *
   * It moves only on a publication whose price stage heard a definitive answer for nearly every
   * app it asked about; a run that Steam soft-failed keeps the prices it had and keeps this
   * timestamp with them. Price staleness is therefore read from here and never from `updatedAt`,
   * which moves on every publication including the ones that refreshed only languages.
   */
  pricesUpdatedAt: string | null
  gameCount: number
  stats?: Partial<IndexRunStats>
  /**
   * The rate dollar prices are estimated in hryvnia with, or nothing when the bank could not be
   * read for a week: an estimate is then not made at all. Optional: metadata published before the
   * job read the bank has none.
   */
  exchangeRate?: IndexedExchangeRate
  /**
   * When each store's prices were last read in full (ISO timestamps). The refresh job reads a
   * store again once this is more than eleven hours old, whatever kind of run it is; a read that
   * failed does not move it, so the next run tries again. Optional: a store that has never been
   * read has no entry, and metadata published before the job read these stores has no field.
   *
   * The PlayStation Store never has an entry: it is not read in full by any run, but a game at a
   * time, and each offer's own `updatedAt` is the date of its read.
   */
  offersReadAt?: Partial<Record<OfferStore, string>>
}

/**
 * The values a query trims on, one sorted set each. Every score is a safe integer far below 2^53,
 * because a Redis score is a double and a wider score would round on the way in: prices and
 * discounts are whole numbers already, ratings are stored in hundredths and release dates in days
 * since the epoch rather than milliseconds.
 */
export const INDEX_RANGE_FIELDS = ['price', 'discount', 'metacritic', 'rating', 'released'] as const
export type IndexRangeField = (typeof INDEX_RANGE_FIELDS)[number]

/** Whole days since the epoch, the finest granularity an ISO date carries. */
export function daysSinceEpoch(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86_400_000)
}

/** The day after `isoDate`, as days since the epoch. */
export function dayAfter(isoDate: string): number {
  return daysSinceEpoch(isoDate) + 1
}

/** The first day of a year, as days since the epoch. Years are padded, so year 20 is not 1920. */
export function firstDayOfYear(year: number): number {
  return daysSinceEpoch(`${String(year).padStart(4, '0')}-01-01`)
}

/** The last day of a year (31 December), as days since the epoch. */
export function lastDayOfYear(year: number): number {
  return daysSinceEpoch(`${String(year).padStart(4, '0')}-12-31`)
}

/**
 * The playtime bucket a game belongs to, matching the catalog's own buckets
 * (`server/rawg/lookups.ts`). Games with an unknown playtime belong to none.
 */
export function playtimeBucketOf(hours: number | null | undefined): PlaytimeValue | null {
  if (!hours || hours <= 0) return null
  if (hours < 10) return 'SHORT'
  if (hours <= 40) return 'MEDIUM'
  return 'LONG'
}

/**
 * The value a game contributes to one range set, or `null` when it does not belong to it: a game
 * without a price is absent from the price and discount ranges, and a game without a release date
 * from the release range, so neither can be matched by a filter over a value it does not have.
 * Games without a rating or a Metacritic score stay in those ranges at zero — the catalog shows
 * them, and a minimum above zero excludes them anyway.
 */
export function rangeValueOf(game: IndexedGame, field: IndexRangeField): number | null {
  switch (field) {
    case 'price':
      return game.priceUah
    case 'discount':
      return game.priceUah === null ? null : game.discountPercent
    case 'metacritic':
      return game.metacritic ?? 0
    case 'rating':
      return Math.round((game.rating ?? 0) * 100)
    case 'released':
      return game.released ? daysSinceEpoch(game.released) : null
  }
}

/**
 * The name as the search matches it. Folded once by the writer, into the index's names key, and
 * once per query by the planner, so both sides fold the same way.
 */
export function foldName(name: string): string {
  return name.trim().toLocaleLowerCase('uk')
}

/**
 * The longest slug the index files a game under, and the longest it looks up, in UTF-16 code
 * units — the length a string reports. RAWG's slugs are a few dozen characters, so this is far
 * past any of them; it exists because the slug a game page asks about comes from a visitor, in a
 * request variable nothing else bounds, and megabytes of it would otherwise be sent to the store
 * as one hash field.
 */
export const MAX_SLUG_LENGTH = 200

/**
 * Whether a slug can lead to a game of the index at all: not empty, no longer than
 * `MAX_SLUG_LENGTH`, and well-formed text — a lone surrogate is one JSON escape away for whoever
 * writes a request by hand, and it is not text UTF-8 can carry. Checked once by the writer, when
 * it files the slugs of a version (`buildIndexPlan`), and once per lookup by the Upstash adapter
 * before anything is sent, so both sides draw the line in the same place: what would not be
 * looked up is not filed, and asking about it costs the store nothing.
 *
 * Nothing here judges what a slug is made of beyond that. The match is exact, so a slug in the
 * wrong case or with a stray character simply finds nothing.
 */
export function isIndexableSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && slug.isWellFormed()
}
