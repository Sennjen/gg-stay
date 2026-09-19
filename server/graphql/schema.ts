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
    "Index-backed fields: accepted and ignored until the nightly index exists."
    priceMaxUah: Int
    free: Boolean
    onSaleMinPercent: Int
    ukrainianLocalisation: Localisation
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
  enum Localisation {
    ANY
    INTERFACE
    SUBTITLES
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
    localisation: LocalisationInfo
    madeInUkraine: Boolean!
  }

  type Game {
    id: ID!
    slug: String!
    name: String!
    description: String
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
    similar: [GameCard!]!
    platformFamilies: [PlatformFamily!]!
  }

  type FeaturedGame {
    game: GameCard!
    clipUrl: String
  }
  type Landing {
    featured: FeaturedGame
    carousel: [GameCard!]!
    newReleases: [GameCard!]!
    topRated: [GameCard!]!
    totalGames: Int!
  }

  type PriceSummary {
    bestUah: Int!
    bestStore: String!
    discountPercent: Int!
    isFree: Boolean!
    updatedAt: String!
  }
  type StoreOffer {
    store: String!
    url: String!
    priceUah: Int
    regularPriceUah: Int
    discountPercent: Int
    updatedAt: String
  }
  type LocalisationInfo {
    interface: Boolean!
    subtitles: Boolean!
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
