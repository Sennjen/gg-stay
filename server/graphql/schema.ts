export const typeDefs = /* GraphQL */ `
  type Query {
    games(
      filter: GameFilter
      sort: GameSort = POPULARITY_DESC
      page: Int = 1
      pageSize: Int = 20
    ): GamePage!
    game(slug: String!): Game
    genres: [Taxonomy!]!
    platforms: [Taxonomy!]!
    developers(search: String!): [Taxonomy!]!
    landing: Landing!
    """
    One well-reviewed game at half price or better, the same for every visitor all UTC day.
    Answered from the index only; null when the index is unavailable, its prices are stale or
    nothing qualifies.
    """
    dealOfTheDay: GameCard
  }

  input GameFilter {
    search: String
    genres: [String!]
    platforms: [Int!]
    yearFrom: Int
    yearTo: Int
    upcoming: Boolean
    metacriticMin: Int
    ratingMin: Float
    playtime: Playtime
    gameModes: [GameMode!]
    ageRating: [AgeRating!]
    stores: [String!]
    developers: [String!]
    publishers: [String!]
    tags: [String!]
    "Index-backed field: accepted and ignored until the nightly index exists."
    priceMaxUah: Int
    "Index-backed field: accepted and ignored until the nightly index exists."
    free: Boolean
    "Index-backed field: accepted and ignored until the nightly index exists."
    onSaleMinPercent: Int
    "Index-backed field: accepted and ignored until the nightly index exists."
    ukrainianLocalisation: Localisation
    "Index-backed field: games from studios founded and based in Ukraine."
    madeInUkraine: Boolean
  }

  enum GameSort {
    POPULARITY_DESC
    RATING_DESC
    METACRITIC_DESC
    RELEASED_DESC
    RELEASED_ASC
    NAME_ASC
    PRICE_ASC
    PRICE_DESC
    DISCOUNT_DESC
  }
  enum Playtime {
    SHORT
    MEDIUM
    LONG
  }
  enum GameMode {
    SINGLE
    LOCAL_COOP
    ONLINE_COOP
    MULTIPLAYER
  }
  enum AgeRating {
    PEGI3
    PEGI7
    PEGI12
    PEGI16
    PEGI18
  }
  "Steam reports supported languages and full audio only, so localisation has two levels."
  enum Localisation {
    ANY
    TEXT
    AUDIO
  }
  enum PlatformFamily {
    PC
    PLAYSTATION
    XBOX
    NINTENDO
    MOBILE
    OTHER
  }

  type GamePage {
    items: [GameCard!]!
    total: Int!
    page: Int!
    pageSize: Int!
    hasNext: Boolean!
    indexedOnly: Boolean!
    "The index has not been refreshed for too long, so prices are withheld."
    indexStale: Boolean!
    "ISO timestamp of the last index publication, when there is one."
    indexUpdatedAt: String
    """
    Names of the filter fields this answer could not apply, so the interface can say so: a
    RAWG-only filter (developers, publishers, tags) combined with an index filter, or an index
    filter — or "sort" — dropped because the index is stale or unavailable. Empty otherwise.
    """
    ignoredFilters: [String!]!
  }

  type GameCard {
    id: ID!
    slug: String!
    name: String!
    released: String
    rating: Float
    metacritic: Int
    playtime: Int
    cover: Image
    screenshots: [Image!]!
    platformFamilies: [PlatformFamily!]!
    platforms: [Taxonomy!]!
    genres: [Taxonomy!]!
    price: PriceSummary
    """
    The slug of a store other than Steam whose price for the game is clearly lower: the store of
    the game's cheapest offer, when that is not Steam's and is at least 10 % below Steam's price.
    Null otherwise — and whenever "price" is null, Steam's price is zero, either of the two
    prices was read more than 36 hours ago or is dated more than five minutes ahead of the clock,
    or the comparison names no store at all: a tie, or an estimate too close to a hryvnia price.
    """
    cheaperAt: String
    localisation: LocalisationInfo
    madeInUkraine: Boolean!
  }

  type Game {
    id: ID!
    slug: String!
    name: String!
    description: String
    localizedDescription(locale: String!): LocalizedText
    released: String
    rating: Float
    ratingsCount: Int
    metacritic: Int
    playtime: Int
    ageRating: AgeRating
    gameModes: [GameMode!]!
    cover: Image
    screenshots: [Image!]!
    platforms: [Taxonomy!]!
    genres: [Taxonomy!]!
    tags: [Taxonomy!]!
    developers: [Taxonomy!]!
    publishers: [Taxonomy!]!
    website: String
    stores: [StoreOffer!]!
    localisation: LocalisationInfo
    madeInUkraine: Boolean!
    """
    Up to eight games from the index that share a genre with this one, most popular first,
    preferring games on a platform family this one is on. Empty when fewer than four qualify, or
    when the index is unavailable; while its prices are stale the cards carry no price.
    """
    similar: [GameCard!]!
    platformFamilies: [PlatformFamily!]!
    """
    The rate approximate prices were made with: null when no row of "stores" carries an
    "approxUah" — no store charges this game in another currency, or there is no rate.
    """
    exchangeRate: ExchangeRate
    """
    True when this answer left out something the same query will have a few seconds later: RAWG's
    own answer about the game was late or failed and the page was built from the index instead,
    the page went out before the store links or the screenshots had arrived, or without one of
    them that RAWG had refused for rate, or — for a Steam game the index does not hold, which has
    no index price to show meanwhile — before Steam's price had. A partial answer must never be
    stored by a shared cache.
    """
    partial: Boolean!
  }

  enum DescriptionSource {
    RAWG
    STEAM
  }
  type LocalizedText {
    text: String!
    language: String!
    source: DescriptionSource!
  }

  enum ClipSource {
    RAWG
    STEAM
    "The publisher's own trailer, served by the site for a game pinned to the landing."
    PUBLISHER
  }
  type FeaturedGame {
    game: GameCard!
    clipUrl: String
    clipSource: ClipSource
    "Whose trailer it is. Set only when clipSource is PUBLISHER."
    clipCredit: String
  }
  "The landing's shelves, in display order. The catalog URL each one links to is shared/shelves.ts."
  enum ShelfId {
    MADE_IN_UKRAINE
    UKRAINIAN
    ON_SALE
    BEST_THIS_YEAR
    UPCOMING
  }
  type Shelf {
    id: ShelfId!
    games: [GameCard!]!
  }
  type Landing {
    featured: FeaturedGame
    carousel: [GameCard!]!
    """
    The shelves that have at least four games, in display order. The three index shelves are left
    out while the index is unavailable, and the sale shelf while its prices are stale.
    """
    shelves: [Shelf!]!
    totalGames: Int!
    "The calendar year the shelves were built for, so a shelf's catalog link never reads a clock."
    year: Int!
  }

  type PriceSummary {
    bestUah: Int!
    "The pre-discount price, so the interface can render it struck through. Null when not on sale."
    regularUah: Int
    bestStore: String!
    discountPercent: Int!
    isFree: Boolean!
    updatedAt: String!
  }
  "A sum of money in the currency a store charges in."
  type Money {
    "In the currency's main unit, the minor one as its fraction: 8.99 is eight dollars ninety-nine."
    amount: Float!
    "The ISO 4217 code, such as USD."
    currency: String!
  }
  "The National Bank of Ukraine's official rate of one currency for one day."
  type ExchangeRate {
    currency: String!
    "Hryvnia for one unit of the currency."
    uah: Float!
    "The day the rate is for, as YYYY-MM-DD."
    date: String!
  }
  """
  One store a game is sold in: a link, and what the store charges a buyer in Ukraine when that is
  known and fresh. A store that charges in hryvnia fills "priceUah" and "regularPriceUah"; one
  that charges in another currency fills "foreignPrice" and "foreignRegularPrice" instead, and
  "approxUah" when there is a rate. A row without a price has nulls in all of them. For a store
  other than Steam the regular price is there only when it is above the price, and
  "discountPercent" is 1 to 99 beside it and 0 otherwise.
  """
  type StoreOffer {
    store: String!
    url: String!
    """
    What the store itself calls the product the price is for, as plain text. A store's link is
    sometimes to another edition than the game's name says. Null on a row without a price, and
    when the store gave none.
    """
    title: String
    priceUah: Int
    regularPriceUah: Int
    discountPercent: Int
    isFree: Boolean
    updatedAt: String
    "A price in another currency, from a store that does not sell in hryvnia."
    foreignPrice: Money
    "The foreign price before the discount. Null unless it is above the price."
    foreignRegularPrice: Money
    """
    foreignPrice at the National Bank's rate, rounded to a hryvnia: an estimate, never the charge.
    Null without a rate, and for a free game, where there is nothing to estimate.
    """
    approxUah: Int
    """
    True for the one offer that is cheapest: the lowest hryvnia amount among the game's rows with a
    fresh price, where an approximate amount counts only when it is at least 5 % below the lowest
    exact one. A price is fresh when "updatedAt" is no more than 36 hours old and not more than
    five minutes ahead of the clock; a row with an older price is not weighed. False on every row
    when fewer than two have a fresh price, when the lowest is shared or free, or while a row
    shows a fresh price that cannot be weighed (a foreign price with no "approxUah").
    """
    cheapest: Boolean!
  }
  type LocalisationInfo {
    "The interface or the subtitles are available in Ukrainian."
    text: Boolean!
    "The game is voiced in Ukrainian."
    audio: Boolean!
    source: String!
  }
  type Taxonomy {
    id: ID!
    slug: String!
    name: String!
  }
  type Image {
    url: String!
    width: Int
    height: Int
  }
`
